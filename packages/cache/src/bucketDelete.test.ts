import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { purgeBroker } from "@odu/cordis/services";
import { diskObjectStore, type ObjectStore } from "@odu/objects";
import { type Cache, createCache } from "./cache";
import { type BucketRow, openCacheRepo } from "./db";
import { base32 } from "./narinfo";
import { cacheServer } from "./server";
import { storeFacts } from "./stores";
import { asRoot, localStores } from "./testlib";
import type { CacheBucket } from "./surface";
import { hashOf } from "../test/fakeStore";

const ROOT = "root-token";
const NOW = 1_700_000_000_000;
const ORIGIN = "http://cache.test";

let scratch: string;
const trash: Cache[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "odu-cache-delete-"));
});

afterEach(async () => {
  await Promise.all(trash.splice(0).map((cache) => cache.close()));
  rmSync(scratch, { recursive: true, force: true });
});

const SECOND_STORE = "gw";

const deferred = (): PromiseWithResolvers<void> => Promise.withResolvers<void>();

function cacheWith(
  options: {
    purged?: (input: { reason: string; bucket: string }) => void;
    secondStore?: boolean;
    wrapLocal?: (inner: ObjectStore) => ObjectStore;
  } = {},
): Cache {
  const stores = new Map(localStores(scratch));
  if (options.wrapLocal !== undefined) {
    stores.set("local", options.wrapLocal(stores.get("local") as ObjectStore));
  }
  if (options.secondStore === true) {
    stores.set(SECOND_STORE, diskObjectStore({ dir: join(scratch, SECOND_STORE) }));
  }
  const cache = createCache({
    publicOrigin: ORIGIN,
    stateRoot: scratch,
    stores,
    rootToken: ROOT,
    now: () => NOW,
    ...(options.purged === undefined ? {} : { purged: options.purged }),
  });
  trash.push(cache);
  return cache;
}

const created = (name: string): Parameters<Cache["admin"]["create"]>[0] => ({
  ...asRoot(ROOT),
  name,
  public: true,
  retentionDays: 30,
  upstreamKeys: [],
});

function nar(text: string): { bytes: Uint8Array; narHash: string } {
  const bytes = new TextEncoder().encode(text);
  return { bytes, narHash: `sha256:${base32(createHash("sha256").update(bytes).digest())}` };
}

const stream = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

const narinfoText = (storePath: string, payload: { narHash: string }): string =>
  [
    `StorePath: ${storePath}`,
    `URL: nar/${payload.narHash.slice("sha256:".length)}.nar.zst`,
    "Compression: none",
    `NarHash: ${payload.narHash}`,
    "NarSize: 1",
    "References: ",
    "",
  ].join("\n");

async function stageNar(
  cache: Cache,
  bucket: BucketRow,
  text: string,
): Promise<{ narHash: string }> {
  const payload = nar(text);
  const upload = await cache.beginUpload(bucket, `${payload.narHash.slice("sha256:".length)}.nar.zst`);
  await upload.write(payload.bytes);
  await upload.commit();
  return payload;
}

async function push(cache: Cache, bucket: string, storePath: string, text: string): Promise<void> {
  const row = cache.bucket(bucket);
  if (row === null) throw new Error(`no bucket ${bucket}`);
  const payload = await stageNar(cache, row, text);
  const outcome = await cache.acceptNarinfo(
    row,
    hashOf(storePath),
    stream(narinfoText(storePath, payload)),
    { run: null, commit: null },
  );
  if (!outcome.ok) throw new Error(`push was refused: ${outcome.message}`);
}

const objectsDir = (): string => join(scratch, "cache", "objects");
const repoNow = () => openCacheRepo(join(scratch, "cache", "cache.sqlite"));

describe("bucket.delete refuses", () => {
  it("a name that is not a bucket", async () => {
    const cache = cacheWith();
    expect(await cache.admin.bucketDelete({ ...asRoot(ROOT), bucket: "nope" })).toMatchObject({
      ok: false,
      code: "unknown_bucket",
    });
  });

  it("a bucket with a domain bound to it, naming the domain", async () => {
    const cache = cacheWith();
    await cache.admin.create(created("named"));
    await cache.admin.domain({ ...asRoot(ROOT), bucket: "named", domain: "cache.example.org" });
    const refused = await cache.admin.bucketDelete({ ...asRoot(ROOT), bucket: "named" });
    expect(refused).toMatchObject({ ok: false, code: "bad_input" });
    expect((refused as { message: string }).message).toContain("cache.example.org");
    expect(cache.bucket("named")).not.toBeNull();
    await cache.admin.domain({ ...asRoot(ROOT), bucket: "named", domain: null });
    expect(await cache.admin.bucketDelete({ ...asRoot(ROOT), bucket: "named" })).toMatchObject({
      ok: true,
    });
  });

  it("a bucket that is moving to another store", async () => {
    const cache = cacheWith();
    await cache.admin.create(created("moving"));
    const repo = repoNow();
    repo.putMigration({
      bucket: "moving",
      fromStore: "local",
      toStore: "gw",
      state: "copying",
      copied: 1,
      total: 4,
      bytes: 10,
      started: NOW,
    });
    repo.close();
    const refused = await cacheWith().admin.bucketDelete({ ...asRoot(ROOT), bucket: "moving" });
    expect(refused).toMatchObject({ ok: false, code: "bad_input" });
    expect((refused as { message: string }).message).toContain("gw");
  });

  it("every caller without the root token", async () => {
    const cache = cacheWith();
    await cache.admin.create(created("guarded"));
    expect(await cache.admin.bucketDelete({ ...asRoot("nope"), bucket: "guarded" })).toMatchObject({
      ok: false,
      code: "no_root_token",
    });
    expect(cache.bucket("guarded")).not.toBeNull();
  });
});

describe("bucket.delete purges the store", () => {
  it("counts the NAR, its narinfo, nix-cache-info, an orphan and a temp", async () => {
    const cache = cacheWith();
    await cache.admin.create(created("main"));
    await push(cache, "main", "/nix/store/00000000000000000000000000000001-one", "one");

    const orphan = join(objectsDir(), "main", "nar", "orphan.nar.zst");
    writeFileSync(orphan, "an object nobody recorded");
    const temp = join(objectsDir(), "main", "nar", ".tmp-dead");
    writeFileSync(temp, "half an upload");
    utimesSync(temp, new Date(NOW - 60_000), new Date(NOW - 60_000));

    const gone = await cache.admin.bucketDelete({ ...asRoot(ROOT), bucket: "main" });
    expect(gone).toMatchObject({ ok: true });
    if (!gone.ok) return;
    expect(gone.value).toMatchObject({ name: "main", objects: 5 });
    expect(gone.value.bytes).toBeGreaterThan(0);

    const store = localStores(scratch).get("local");
    expect(await store?.list("main")).toEqual([]);
  });

  it("leaves another bucket's objects alone", async () => {
    const cache = cacheWith();
    await cache.admin.create(created("going"));
    await cache.admin.create(created("staying"));
    await push(cache, "going", "/nix/store/00000000000000000000000000000002-two", "two");
    await push(cache, "staying", "/nix/store/00000000000000000000000000000003-three", "three");

    expect(await cache.admin.bucketDelete({ ...asRoot(ROOT), bucket: "going" })).toMatchObject({
      ok: true,
    });
    const store = localStores(scratch).get("local");
    expect(await store?.list("going")).toEqual([]);
    expect((await store?.list("staying"))?.length).toBeGreaterThan(0);
    expect(cache.bucket("staying")).not.toBeNull();
  });

  it("tells whoever fronts the store, naming the addresses it served", async () => {
    const announced: { reason: string; bucket: string }[] = [];
    const cache = cacheWith({
      purged: (input) => announced.push({ reason: input.reason, bucket: input.bucket }),
    });
    await cache.admin.create(created("fronted"));
    await push(cache, "fronted", "/nix/store/00000000000000000000000000000004-four", "four");
    await cache.admin.bucketDelete({ ...asRoot(ROOT), bucket: "fronted" });
    expect(announced).toContainEqual({ reason: "delete", bucket: "fronted" });
  });
});

describe("bucket.delete drops the rows", () => {
  it("takes the paths, the pins and this bucket's own tokens with it", async () => {
    const cache = cacheWith();
    await cache.admin.create(created("rows"));
    await cache.admin.create(created("neighbour"));
    const path = "/nix/store/00000000000000000000000000000005-five";
    await push(cache, "rows", path, "five");
    await cache.admin.pin({ ...asRoot(ROOT), bucket: "rows", name: "release", paths: [path] });
    const mine = await cache.admin.tokenMint({
      ...asRoot(ROOT),
      bucket: "rows",
      bucketGlob: null,
      scope: "write",
      expiresDays: null,
    });
    const wide = await cache.admin.tokenMint({
      ...asRoot(ROOT),
      bucket: "rows",
      bucketGlob: "*",
      scope: "write",
      expiresDays: null,
    });
    expect(mine.ok && wide.ok).toBe(true);
    if (!mine.ok || !wide.ok) return;

    expect(await cache.admin.bucketDelete({ ...asRoot(ROOT), bucket: "rows" })).toMatchObject({
      ok: true,
    });

    expect(cache.bucket("rows")).toBeNull();
    const listed = await cache.admin.list(asRoot(ROOT));
    expect(listed.ok && listed.value.map((row) => row.name)).toEqual(["neighbour"]);
    const repo = repoNow();
    expect(repo.objects("rows")).toEqual([]);
    expect(repo.pins("rows")).toEqual([]);
    const left = repo.tokens().map((token) => token.id);
    repo.close();
    expect(left).not.toContain(mine.value.facts.id);
    expect(left).toContain(wide.value.facts.id);
  });

  it("stops serving the paths it held", async () => {
    const cache = cacheWith();
    await cache.admin.create(created("served"));
    const path = "/nix/store/00000000000000000000000000000006-six";
    await push(cache, "served", path, "six");
    const row = cache.bucket("served");
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(cache.narinfoText(row, hashOf(path))).not.toBeNull();
    await cache.admin.bucketDelete({ ...asRoot(ROOT), bucket: "served" });
    expect(cache.bucket("served")).toBeNull();
  });
});

describe("the row the board follows", () => {
  it("drops the deleted bucket's key", async () => {
    const cache = cacheWith();
    const server = cacheServer({
      cache,
      publicOrigin: ORIGIN,
      mount: "/cache",
      purge: purgeBroker(),
      stores: storeFacts(new Map()),
    });
    const published = new Map<string, CacheBucket>();
    server.attach({
      buckets: {
        upsert: (key, value) => {
          published.set(key, value);
        },
        remove: (key) => {
          published.delete(key);
        },
      },
    });
    await cache.admin.create(created("watched"));
    await cache.admin.create(created("other"));
    expect([...published.keys()].sort()).toEqual(["other", "watched"]);

    await cache.admin.bucketDelete({ ...asRoot(ROOT), bucket: "watched" });
    expect([...published.keys()]).toEqual(["other"]);
    server.detach();
  });
});

describe("a delete and the writer it races", () => {
  it("refuses a narinfo whose bucket went while its NAR was being verified", async () => {
    const cache = cacheWith();
    await cache.admin.create(created("racing"));
    const admitted = cache.bucket("racing");
    expect(admitted).not.toBeNull();
    if (admitted === null) return;
    const path = "/nix/store/00000000000000000000000000000007-seven";
    const payload = await stageNar(cache, admitted, "seven");

    expect(await cache.admin.bucketDelete({ ...asRoot(ROOT), bucket: "racing" })).toMatchObject({
      ok: true,
    });

    const late = await cache.acceptNarinfo(
      admitted,
      hashOf(path),
      stream(narinfoText(path, payload)),
      { run: null, commit: null },
    );
    expect(late).toMatchObject({ ok: false, status: 404 });

    const repo = repoNow();
    const left = repo.objects("racing");
    repo.close();
    expect(left).toEqual([]);
    expect(await new Map(localStores(scratch)).get("local")?.list("racing")).toEqual([]);
  });

  it("lets exactly one of a move and a delete win, whichever asks first", async () => {
    for (const deleteFirst of [true, false]) {
      const cache = cacheWith({ secondStore: true });
      const name = deleteFirst ? "delete-first" : "move-first";
      await cache.admin.create(created(name));
      await push(cache, name, `/nix/store/0000000000000000000000000000000${deleteFirst ? 8 : 9}-x`, name);

      const remove = (): Promise<unknown> =>
        cache.admin.bucketDelete({ ...asRoot(ROOT), bucket: name });
      const move = (): Promise<unknown> =>
        cache.admin.migrateStore({ ...asRoot(ROOT), bucket: name, store: SECOND_STORE });
      const [deleted, moved] = (deleteFirst
        ? await Promise.all([remove(), move()])
        : await Promise.all([move(), remove()]).then(([first, second]) => [second, first])) as [
        { ok: boolean; code?: string },
        { ok: boolean; code?: string },
      ];

      expect([deleted.ok, moved.ok].filter(Boolean)).toHaveLength(1);
      if (deleteFirst) {
        expect(moved).toMatchObject({ ok: false, code: "unknown_bucket" });
        expect(cache.bucket(name)).toBeNull();
      } else {
        expect(deleted).toMatchObject({ ok: false, code: "bad_input" });
        expect(cache.bucket(name)).not.toBeNull();
      }
    }
  });

  it("writes nothing for a bucket deleted while the narinfo backfill is inside it", async () => {
    const arrange = cacheWith();
    await arrange.admin.create(created("walked"));
    for (const [index, text] of ["one", "two", "three", "four"].entries()) {
      await push(arrange, "walked", `/nix/store/0000000000000000000000000000001${index}-w`, text);
    }
    const live = new Map(localStores(scratch)).get("local") as ObjectStore;
    for (const object of await live.list("walked")) {
      if (object.key.endsWith(".narinfo")) await live.delete(object.key);
    }

    const reached = deferred();
    const release = deferred();
    let open = false;
    const backfilling = cacheWith({
      wrapLocal: (inner) => ({
        ...inner,
        async head(key: string): Promise<number | null> {
          if (!open) {
            reached.resolve();
            await release.promise;
          }
          return inner.head(key);
        },
      }),
    });
    const pass = backfilling.backfillObjects();
    await reached.promise;

    expect(await arrange.admin.bucketDelete({ ...asRoot(ROOT), bucket: "walked" })).toMatchObject({
      ok: true,
    });
    open = true;
    release.resolve();
    await pass;

    expect(await live.list("walked")).toEqual([]);
  });
});
