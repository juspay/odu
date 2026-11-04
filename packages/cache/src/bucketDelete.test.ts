/**
 * A BUCKET TAKEN AWAY — `bucket.delete`, the one verb with no undo behind it.
 *
 * Three questions, and all three are about what is left afterwards:
 *
 * - **What it REFUSES**, because every refusal here is a thing that would be
 *   left dangling: a name that is not a bucket, a DNS record pointing at a
 *   bucket that is not there, a copier writing into the other store as we
 *   delete.
 * - **What the STORE gives up**, counted — including the two kinds of key no
 *   row names and which would therefore outlive the bucket forever: an ORPHAN
 *   (a put whose record never landed) and a TEMP (a put that died).
 * - **What the DATABASE gives up**: the paths, the pins, and the tokens minted
 *   for this bucket alone — a credential whose only bucket is gone is a
 *   credential with nothing to address.
 *
 * The published ROW is checked through the server, not the cache: the board
 * subscribes to that collection, and a bucket deleted from the database while
 * its row stayed in the collection is a card a person can still click.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { purgeBroker } from "@odu/cordis/services";
import { type Cache, createCache } from "./cache";
import { openCacheRepo } from "./db";
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

function cacheWith(options: { purged?: (input: { reason: string; bucket: string }) => void } = {}): Cache {
  const cache = createCache({
    publicOrigin: ORIGIN,
    stateRoot: scratch,
    stores: localStores(scratch),
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

/** The bytes of a NAR and the hash a narinfo has to claim for them. */
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

/** One real push: the object, then the narinfo that proves it. */
async function push(cache: Cache, bucket: string, storePath: string, text: string): Promise<void> {
  const row = cache.bucket(bucket);
  if (row === null) throw new Error(`no bucket ${bucket}`);
  const payload = nar(text);
  const upload = await cache.beginUpload(row, `${payload.narHash.slice("sha256:".length)}.nar.zst`);
  await upload.write(payload.bytes);
  await upload.commit();
  const outcome = await cache.acceptNarinfo(
    row,
    hashOf(storePath),
    stream(
      [
        `StorePath: ${storePath}`,
        `URL: nar/${payload.narHash.slice("sha256:".length)}.nar.zst`,
        "Compression: none",
        `NarHash: ${payload.narHash}`,
        "NarSize: 1",
        "References: ",
        "",
      ].join("\n"),
    ),
  );
  if (!outcome.ok) throw new Error(`push was refused: ${outcome.message}`);
}

/** The state root's object store and database, as a test reads them back. */
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
    // AND IT IS STILL THERE: a refusal that had already deleted the objects
    // would be the worst outcome of the three.
    expect(cache.bucket("named")).not.toBeNull();
    // Clearing the name is the operator's next step, and then it goes.
    await cache.admin.domain({ ...asRoot(ROOT), bucket: "named", domain: null });
    expect(await cache.admin.bucketDelete({ ...asRoot(ROOT), bucket: "named" })).toMatchObject({
      ok: true,
    });
  });

  it("a bucket that is moving to another store", async () => {
    const cache = cacheWith();
    await cache.admin.create(created("moving"));
    // The MOVE ROW is what the refusal reads, so writing one is the whole
    // arrangement — the copier itself is `migrateStore.test`'s subject.
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

    // AN ORPHAN: a key under this bucket's prefix that no row names — a put
    // whose record never landed. Nothing but a listing can find it.
    const orphan = join(objectsDir(), "main", "nar", "orphan.nar.zst");
    writeFileSync(orphan, "an object nobody recorded");
    // AND A TEMP: what a put that died leaves. `list` never shows it, so only
    // the sweep takes it — and only if this verb asks for one.
    const temp = join(objectsDir(), "main", "nar", ".tmp-dead");
    writeFileSync(temp, "half an upload");
    utimesSync(temp, new Date(NOW - 60_000), new Date(NOW - 60_000));

    const gone = await cache.admin.bucketDelete({ ...asRoot(ROOT), bucket: "main" });
    expect(gone).toMatchObject({ ok: true });
    if (!gone.ok) return;
    // The NAR, its narinfo, the bucket's `nix-cache-info`, the orphan — and
    // the temp, which the sweep counts.
    expect(gone.value).toMatchObject({ name: "main", objects: 5 });
    expect(gone.value.bytes).toBeGreaterThan(0);

    // NOTHING LEFT UNDER THE PREFIX. A key that survives is a key no row can
    // name again, so no later collection could ever remove it.
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
    // A WIDER GLOB IS NOT THIS BUCKET'S: it addresses the neighbour too, and
    // deleting one bucket is not a decision about the others.
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
    // The paths and the pin are gone with it, so nothing names the bucket.
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
    // THE BUCKET IS THE ROUTE'S FIRST LOOKUP, so a reader is answered 404 by
    // the name not resolving at all.
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
    // NOT `server.publish()`: the row subscribes to the cache's own change
    // notification, and a verb that forgot to notify is exactly the bug this
    // case is here for.
    expect([...published.keys()].sort()).toEqual(["other", "watched"]);

    await cache.admin.bucketDelete({ ...asRoot(ROOT), bucket: "watched" });
    expect([...published.keys()]).toEqual(["other"]);
    server.detach();
  });
});
