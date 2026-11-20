import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { diskObjectStore, s3ObjectStore, type ObjectStore } from "@odu/objects";
import { type Gateway, startGateway } from "@odu/objects/testing";
import { type Cache, createCache } from "./cache";
import { openCacheRepo, type BucketRow } from "./db";
import { migrationKeys } from "./migrateStore";
import { base32, storePathHash } from "./narinfo";
import { narinfoKey, objectKey } from "./staging";
import { asRoot } from "./testlib";

const ROOT = "root-token";

const nar = (text: string): { bytes: Uint8Array; narHash: string } => {
  const bytes = new TextEncoder().encode(text);
  return { bytes, narHash: `sha256:${base32(createHash("sha256").update(bytes).digest())}` };
};

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

async function pushAs(cache: Cache, bucket: BucketRow, storePath: string): Promise<void> {
  const payload = nar(storePath);
  const upload = await cache.beginUpload(bucket, `${payload.narHash.slice("sha256:".length)}.nar.zst`);
  await upload.write(payload.bytes);
  await upload.commit();
  const outcome = await cache.acceptNarinfo(
    bucket,
    storePathHash(storePath),
    stream(narinfoText(storePath, payload)),
    { run: null, commit: null },
  );
  if (!outcome.ok) throw new Error(`push ${storePath}: ${outcome.message}`);
}

async function push(cache: Cache, storePath: string): Promise<void> {
  const bucket = cache.bucket("main");
  if (bucket === null) throw new Error("no bucket main");
  await pushAs(cache, bucket, storePath);
}

const keysOf = async (objects: ObjectStore): Promise<string[]> =>
  (await objects.list("main")).map((entry) => entry.key).sort();

async function readNar(cache: Cache, storePath: string): Promise<string | null> {
  const bucket = cache.bucket("main");
  if (bucket === null) throw new Error("no bucket main");
  const payload = nar(storePath);
  const source = await cache.narSource(bucket, `${payload.narHash.slice("sha256:".length)}.nar.zst`);
  if (source === null) return null;
  if (source.kind === "redirect") {
    const response = await fetch(source.url);
    return response.ok ? await response.text() : null;
  }
  if (source.kind !== "object") return null;
  const body = await source.read();
  return body === null ? null : await new Response(body).text();
}

const PATHS = [
  "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-one",
  "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-two",
  "/nix/store/cccccccccccccccccccccccccccccccc-three",
] as const;

let gateway: Gateway;

beforeAll(async () => {
  gateway = await startGateway();
});
afterAll(async () => {
  await gateway.stop();
});

interface Subject {
  dir: string;
  cache: Cache;
  local: ObjectStore;
  far: ObjectStore;
  dispose(): Promise<void>;
}

async function subject(input?: { dir?: string; far?: ObjectStore }): Promise<Subject> {
  const dir = input?.dir ?? mkdtempSync(join(tmpdir(), "odu-migrate-"));
  const local = diskObjectStore({ dir: join(dir, "cache") });
  const far = input?.far ?? s3ObjectStore({ target: await gateway.bucket() });
  const cache = createCache({
    stateRoot: dir,
    rootToken: ROOT,
    publicOrigin: "http://cache.test",
    stores: new Map<string, ObjectStore>([
      ["local", local],
      ["far", far],
    ]),
  });
  if (cache.bucket("main") === null) {
    const created = await cache.admin.create({
      ...asRoot(ROOT),
      name: "main",
      public: true,
      retentionDays: 30,
      upstreamKeys: [],
    });
    if (!created.ok) throw new Error(`create: ${created.message}`);
  }
  return {
    dir,
    cache,
    local,
    far,
    dispose: async () => {
      await cache.close();
    },
  };
}

function settled(cache: Cache): Promise<void> {
  const done = (): boolean =>
    cache.snapshot().find((bucket) => bucket.name === "main")?.migration == null;
  if (done()) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const stop = cache.onChange(() => {
    if (!done()) return;
    stop();
    resolve();
  });
  return promise;
}

describe("bucket.migrate", () => {
  it("copies every object to the new store, flips the bucket and lets the old copies go", async () => {
    const subjectUnder = await subject();
    const { cache, local, far } = subjectUnder;
    for (const path of PATHS) await push(cache, path);
    const before = await keysOf(local);
    expect(before).toHaveLength(7);

    const started = await cache.admin.migrateStore({ ...asRoot(ROOT), bucket: "main", store: "far" });
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) return;
    expect(started.value.store).toBe("local");
    expect(started.value.migration?.to).toBe("far");

    await settled(cache);

    expect(await keysOf(far)).toEqual(before);
    expect(await keysOf(local)).toEqual([]);
    expect(cache.bucket("main")?.store).toBe("far");
    expect(cache.snapshot().find((bucket) => bucket.name === "main")?.migration).toBeNull();

    for (const path of PATHS) expect(await readNar(cache, path)).toBe(path);
    await subjectUnder.dispose();
  });

  it("serves the bucket from the old store while the move is still copying", async () => {
    const subjectUnder = await subject();
    const { cache, far } = subjectUnder;
    const [first] = PATHS;
    for (const path of PATHS) await push(cache, path);

    await cache.admin.migrateStore({ ...asRoot(ROOT), bucket: "main", store: "far" });
    expect(cache.bucket("main")?.store).toBe("local");
    expect(await readNar(cache, first)).toBe(first);

    await settled(cache);
    expect(await keysOf(far)).toHaveLength(7);
    await subjectUnder.dispose();
  });

  it("writes a push admitted before the flip into the store the bucket moved to", async () => {
    const subjectUnder = await subject();
    const { cache, local, far } = subjectUnder;
    const [first, late] = PATHS;
    await push(cache, first);

    const admitted = cache.bucket("main");
    if (admitted === null) throw new Error("no bucket main");
    expect(admitted.store).toBe("local");

    await cache.admin.migrateStore({ ...asRoot(ROOT), bucket: "main", store: "far" });
    await settled(cache);
    expect(cache.bucket("main")?.store).toBe("far");

    await pushAs(cache, admitted, late);
    expect(await keysOf(local)).toEqual([]);
    expect(await readNar(cache, late)).toBe(late);
    const key = objectKey("main", nar(late).narHash, "none");
    expect(await far.head(key)).not.toBeNull();
    expect(await far.head(narinfoKey("main", storePathHash(late)))).not.toBeNull();
    await subjectUnder.dispose();
  });

  it("resumes a move a restart interrupted, and rewrites nothing it already wrote", async () => {
    const first = await subject();
    for (const path of PATHS) await push(first.cache, path);
    const expected = await keysOf(first.local);
    const far = first.far;

    await first.dispose();
    const repo = openCacheRepo(join(first.dir, "cache", "cache.sqlite"));
    const keys = migrationKeys(repo, "main");
    repo.putMigration({
      bucket: "main",
      fromStore: "local",
      toStore: "far",
      state: "copying",
      copied: 1,
      total: keys.length,
      bytes: 0,
      started: Date.now(),
    });
    repo.close();
    const already = keys[0]?.key;
    if (already === undefined) throw new Error("the bucket owns no keys");
    const carried = await first.local.get(already);
    if (carried !== null) await far.put(already, carried.stream);

    const second = await subject({ dir: first.dir, far });
    await second.cache.resumeMigrations();
    await settled(second.cache);

    expect(await keysOf(second.far)).toEqual(expected);
    expect(await keysOf(second.local)).toEqual([]);
    expect(second.cache.bucket("main")?.store).toBe("far");
    await second.dispose();
    rmSync(first.dir, { recursive: true, force: true });
  });

  it("refuses an unknown store, the store it is on, a second move and a caller with no root token", async () => {
    const subjectUnder = await subject();
    const { cache } = subjectUnder;
    await push(cache, PATHS[0] as string);

    expect(await cache.admin.migrateStore({ ...asRoot(ROOT), bucket: "main", store: "nowhere" })).toMatchObject({
      ok: false,
      code: "unknown_store",
    });
    expect(await cache.admin.migrateStore({ ...asRoot(ROOT), bucket: "main", store: "local" })).toMatchObject({
      ok: false,
      code: "bad_input",
    });
    expect(await cache.admin.migrateStore({ ...asRoot(ROOT), bucket: "nope", store: "far" })).toMatchObject({
      ok: false,
      code: "unknown_bucket",
    });
    expect(
      await cache.admin.migrateStore({ ...asRoot("not-the-root-token"), bucket: "main", store: "far" }),
    ).toMatchObject({ ok: false, code: "no_root_token" });

    expect(await cache.admin.migrateStore({ ...asRoot(ROOT), bucket: "main", store: "far" })).toMatchObject({
      ok: true,
    });
    const second = await cache.admin.migrateStore({ ...asRoot(ROOT), bucket: "main", store: "far" });
    expect(second).toMatchObject({ ok: false, code: "bad_input" });
    if (!second.ok) expect(second.message).toContain("already moving");

    await settled(cache);
    await subjectUnder.dispose();
  });
});
