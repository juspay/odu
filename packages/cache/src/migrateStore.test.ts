/**
 * A BUCKET MOVES BETWEEN STORES — `bucket.migrate` (PLAN 2.8), from the local
 * disk to a real S3 service (versitygw), which is the move kolu makes.
 *
 * What is worth proving here, and what each case holds:
 *
 * - The move copies EVERYTHING a bucket owns — the NARs, the narinfo beside
 *   each one and `nix-cache-info` — and the new store ends up holding exactly
 *   the key set the old one did.
 * - The bucket is SERVED THROUGHOUT. A client reading mid-move gets the old
 *   store's bytes, and after the flip the new store's; at no point a 404.
 * - It is RESUMABLE. A move interrupted half way is picked up by the next
 *   daemon and finishes, writing nothing it already wrote.
 * - It REFUSES the four things it must: an unknown store, the store it is
 *   already on, a second move of the same bucket, and a caller with no root
 *   token.
 */

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

/** Push one path, against the bucket row the caller holds — a request is
 *  admitted against a row read when it ARRIVED, and that row can be stale by
 *  the time the push reaches the write lock. */
async function pushAs(cache: Cache, bucket: BucketRow, storePath: string): Promise<void> {
  const payload = nar(storePath);
  const upload = await cache.beginUpload(bucket, `${payload.narHash.slice("sha256:".length)}.nar.zst`);
  await upload.write(payload.bytes);
  await upload.commit();
  const outcome = await cache.acceptNarinfo(bucket, storePathHash(storePath), stream(narinfoText(storePath, payload)));
  if (!outcome.ok) throw new Error(`push ${storePath}: ${outcome.message}`);
}

async function push(cache: Cache, storePath: string): Promise<void> {
  const bucket = cache.bucket("main");
  if (bucket === null) throw new Error("no bucket main");
  await pushAs(cache, bucket, storePath);
}

const keysOf = async (objects: ObjectStore): Promise<string[]> =>
  (await objects.list("main")).map((entry) => entry.key).sort();

/** Read the whole NAR a client would get for `storePath`, through the cache's
 *  own read path — which is what "still served" means. A bucket on an S3
 *  store answers a REDIRECT rather than bytes (PLAN 2.8), so this follows it,
 *  exactly as a Nix client does. */
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

/** A cache with two declared stores — the disk it starts on and the S3 one it
 *  is going to — and `main` on the disk. `dir` is reused by a second
 *  instantiation in the resumability case, which is how a restart is staged. */
async function subject(input?: { dir?: string; far?: ObjectStore }): Promise<Subject> {
  const dir = input?.dir ?? mkdtempSync(join(tmpdir(), "odu-migrate-"));
  const local = diskObjectStore({ dir: join(dir, "cache") });
  const far = input?.far ?? s3ObjectStore({ target: await gateway.bucket() });
  const cache = createCache({
    stateRoot: dir,
    rootToken: ROOT,
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

/** Wait for the bucket's move to finish — the verb answers as soon as the
 *  move is RECORDED, so a case that asserted straight away would be asserting
 *  against a copier that had not started.
 *
 *  Driven by the cache's own change notification rather than by a sleep: the
 *  copier publishes on every progress write and once more when the move's row
 *  goes, so the end of the move is a signal and not a duration. */
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
    // Three NARs, three narinfos and `nix-cache-info`.
    expect(before).toHaveLength(7);

    const started = await cache.admin.migrateStore({ ...asRoot(ROOT), bucket: "main", store: "far" });
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) return;
    // THE ANSWER IS THE ROW, with the move on it: the copy has not finished,
    // and the bucket still names the store it is being served from.
    expect(started.value.store).toBe("local");
    expect(started.value.migration?.to).toBe("far");

    await settled(cache);

    // THE NEW STORE HOLDS WHAT THE OLD ONE DID, key for key.
    expect(await keysOf(far)).toEqual(before);
    // AND THE OLD ONE HOLDS NOTHING: a second copy of everything is the cost
    // the move exists to stop paying.
    expect(await keysOf(local)).toEqual([]);
    expect(cache.bucket("main")?.store).toBe("far");
    expect(cache.snapshot().find((bucket) => bucket.name === "main")?.migration).toBeNull();

    // AND IT IS STILL A CACHE: every path reads back through the new store.
    for (const path of PATHS) expect(await readNar(cache, path)).toBe(path);
    await subjectUnder.dispose();
  });

  it("serves the bucket from the old store while the move is still copying", async () => {
    const subjectUnder = await subject();
    const { cache, far } = subjectUnder;
    const [first] = PATHS;
    for (const path of PATHS) await push(cache, path);

    await cache.admin.migrateStore({ ...asRoot(ROOT), bucket: "main", store: "far" });
    // MID-MOVE, whatever the copier has reached: the bucket names the OLD
    // store, so this read is the old store's and it answers.
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

    // THE ROW A REQUEST WAS ADMITTED AGAINST, taken before the move: a
    // narinfo PUT that arrived now holds exactly this, and the write lock it
    // then queues on is the lock the flip takes. The flip can therefore
    // happen while this push waits — on a bucket of any size the delta pass
    // holds that lock for minutes.
    const admitted = cache.bucket("main");
    if (admitted === null) throw new Error("no bucket main");
    expect(admitted.store).toBe("local");

    await cache.admin.migrateStore({ ...asRoot(ROOT), bucket: "main", store: "far" });
    await settled(cache);
    expect(cache.bucket("main")?.store).toBe("far");

    // THE PUSH LANDS WHERE THE BUCKET IS NOW, not where it was when the
    // request arrived. Written into the old store it would have been deleted
    // by the move's own delete pass, and the push would have answered 200 for
    // an object nobody has — a 307 into a 404.
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

    // STAGE THE INTERRUPTION by hand: the move's row says `copying` and part
    // of the bucket is already in the new store, which is exactly what a
    // daemon killed half way through leaves behind. (Killing the real copier
    // at a chosen key would be a race, not a fixture.)
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
    // One key is already in the new store, so the resume must leave it alone
    // and write the rest.
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

    // A SECOND MOVE WHILE ONE RUNS is a refusal, not a queue: two copiers
    // writing one bucket's keys would flip it under each other.
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
