/**
 * GC AND PINS, ON EVERY STORE — the same cases against the local disk and
 * against a real S3 service (versitygw), through the whole cache.
 *
 * The claim this file exists to hold is one sentence: a bucket on R2 collects
 * exactly as a bucket on disk does. GC is written only against `ObjectStore`
 * (`list` and `delete`), and the way to prove that is not to read the code but
 * to run the collection twice — so every case below is written once and the
 * suite is instantiated per store. A rule that leaked into a store's own
 * dialect fails on exactly one of the two runs.
 *
 * `@odu/objects`' contract suite proves the two members behave alike; this
 * proves the COLLECTION does: an expired path's object leaves, a pinned
 * closure's does not, a twin keeps its bytes, an orphan is swept, and a
 * `missing` query renews what it named. And since 4.2, that a push's stated
 * PROVENANCE survives the same trip on either store — it is a column of the
 * row, not a fact of a store, and a run on each is what says so.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { diskObjectStore, s3ObjectStore, type ObjectStore } from "@odu/objects";
import { type Gateway, startGateway } from "@odu/objects/testing";
import { type Cache, createCache } from "./cache";
import type { Provenance } from "./paths";
import { base32 } from "./narinfo";
import { cacheInfoKey, narinfoKey, objectKey } from "./staging";
import { storePathHash } from "./narinfo";
import { asRoot } from "./testlib";

const ROOT = "root-token";
const DAY = 24 * 60 * 60 * 1000;
const START = 1_700_000_000_000;

/** One store under test, and the way to look at what it holds. */
interface Subject {
  cache: Cache;
  objects: ObjectStore;
  /** Move the cache's clock, which is how retention is made to pass without
   *  writing to the database behind the row's back. */
  travel(ms: number): void;
  dispose(): Promise<void>;
}

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

const narinfoText = (
  storePath: string,
  payload: { narHash: string },
  references: readonly string[] = [],
): string =>
  [
    `StorePath: ${storePath}`,
    `URL: nar/${payload.narHash.slice("sha256:".length)}.nar.zst`,
    "Compression: none",
    `NarHash: ${payload.narHash}`,
    "NarSize: 1",
    `References: ${references.map((path) => path.slice("/nix/store/".length)).join(" ")}`,
    "",
  ].join("\n");

/** Push one path into `main`: its NAR, then the narinfo that names it.
 *  `provenance` is what that narinfo's request STATES built the path — the
 *  default is what a push that says nothing sends. */
async function push(
  cache: Cache,
  storePath: string,
  references: readonly string[] = [],
  provenance: Provenance = { run: null, commit: null },
): Promise<void> {
  const bucket = cache.bucket("main");
  if (bucket === null) throw new Error("no bucket main");
  const payload = nar(storePath);
  const upload = await cache.beginUpload(bucket, `${payload.narHash.slice("sha256:".length)}.nar.zst`);
  await upload.write(payload.bytes);
  await upload.commit();
  const outcome = await cache.acceptNarinfo(
    bucket,
    storePathHash(storePath),
    stream(narinfoText(storePath, payload, references)),
    provenance,
  );
  if (!outcome.ok) throw new Error(`push ${storePath}: ${outcome.message}`);
}

/** The object key a pushed path's bytes live at. The narinfos above say
 *  `Compression: none`, so that is what the row recorded and what the key's
 *  extension encodes — asked of `objectKey` rather than spelled, so this
 *  cannot drift from staging. */
const keyFor = (storePath: string): string => objectKey("main", nar(storePath).narHash, "none");

/** The key the path's NARINFO OBJECT lives at (PLAN 2.8): a push writes the
 *  signed text beside the bytes so a store can serve the pair without odu,
 *  and a collection that took the bytes must take this too — a narinfo left
 *  behind is a client told to fetch a NAR that is gone. */
const narinfoFor = (storePath: string): string => narinfoKey("main", storePathHash(storePath));

/** The one key a bucket holds that belongs to no path. It is written when the
 *  bucket is created and no collection may touch it: a bucket a collection
 *  emptied is still a cache, and a Nix client reads this file first. */
const CACHE_INFO = cacheInfoKey("main");

/** Everything under the bucket's prefix, sorted — the NARs, their narinfos and
 *  `nix-cache-info`. */
const keysOf = async (objects: ObjectStore): Promise<string[]> =>
  (await objects.list("main")).map((entry) => entry.key).sort();

/** What the store should hold for a set of surviving paths: each one's bytes
 *  and narinfo, plus the bucket's `nix-cache-info`. */
const keysOfPaths = (...storePaths: readonly string[]): string[] =>
  [CACHE_INFO, ...storePaths.flatMap((path) => [keyFor(path), narinfoFor(path)])].sort();

/**
 * The cases. One function, two stores — see this file's header.
 *
 * `store` is the declared name the bucket is created with; the fixture builds
 * the map `createCache` holds, so nothing below knows what kind of store it
 * is talking to.
 */
function gcCases(name: string, make: () => Promise<Subject>): void {
  describe(`${name}: collection`, () => {
    it("evicts an expired path's object and keeps a pinned closure's", async () => {
      const { cache, objects, travel, dispose } = await make();
      const kept = "/nix/store/kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk-kept";
      const child = "/nix/store/cccccccccccccccccccccccccccccccc-child";
      const gone = "/nix/store/gggggggggggggggggggggggggggggggg-gone";
      await push(cache, child);
      await push(cache, kept, [child]);
      await push(cache, gone);
      expect(
        await cache.admin.pin({ ...asRoot(ROOT), bucket: "main", name: "release", paths: [kept] }),
      ).toMatchObject({ ok: true });

      // Nothing has wanted any of them for a hundred days; retention is 30.
      travel(100 * DAY);
      const report = await cache.admin.gc({ ...asRoot(ROOT), bucket: "main" });
      expect(report).toMatchObject({ ok: true });
      if (!report.ok) return;
      expect(report.value.report.evicted).toBe(1);

      const bucket = cache.bucket("main");
      if (bucket === null) throw new Error("no bucket");
      expect(cache.narinfoText(bucket, storePathHash(gone))).toBeNull();
      // The pin held its root AND the path its root references: a closure is
      // what a pin promises, not a path.
      expect(cache.narinfoText(bucket, storePathHash(kept))).not.toBeNull();
      expect(cache.narinfoText(bucket, storePathHash(child))).not.toBeNull();
      // WHAT 2.8 ADDED, asserted rather than tolerated: a path's NARINFO
      // OBJECT leaves with its bytes, and the survivors' stay. A store that
      // serves the pair on its own has no row to consult, so a narinfo left
      // behind would point every client at a NAR the collection took.
      expect(await keysOf(objects)).toEqual(keysOfPaths(kept, child));
      expect(await objects.head(narinfoFor(gone))).toBeNull();
      expect(await objects.head(narinfoFor(kept))).not.toBeNull();
      expect(await objects.head(narinfoFor(child))).not.toBeNull();
      await dispose();
    });

    it("lets a pin go, and the next collection takes what it held", async () => {
      const { cache, objects, travel, dispose } = await make();
      const held = "/nix/store/hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh-held";
      await push(cache, held);
      await cache.admin.pin({ ...asRoot(ROOT), bucket: "main", name: "release", paths: [held] });
      travel(100 * DAY);
      await cache.admin.gc({ ...asRoot(ROOT), bucket: "main" });
      expect(await keysOf(objects)).toEqual(keysOfPaths(held));

      const listed = await cache.admin.pinList({ ...asRoot(ROOT), bucket: "main" });
      expect(listed).toMatchObject({ ok: true });
      if (listed.ok) expect(listed.value.map((pin) => pin.name)).toEqual(["release"]);

      expect(
        await cache.admin.pinDelete({ ...asRoot(ROOT), bucket: "main", name: "release" }),
      ).toMatchObject({ ok: true });
      await cache.admin.gc({ ...asRoot(ROOT), bucket: "main" });
      // THE BUCKET IS EMPTY AND STILL A CACHE: `nix-cache-info` is the one
      // object no collection may take, because a client that reads it first
      // must not meet a 404 for a bucket that merely has nothing in it yet.
      expect(await keysOf(objects)).toEqual([CACHE_INFO]);
      await dispose();
    });

    it("answers a dry run that the collection then performs exactly", async () => {
      const { cache, objects, travel, dispose } = await make();
      const doomed = "/nix/store/dddddddddddddddddddddddddddddddd-doomed";
      const fresh = "/nix/store/ffffffffffffffffffffffffffffffff-fresh";
      await push(cache, doomed);
      travel(100 * DAY);
      await push(cache, fresh);

      const plan = await cache.admin.gcPlan({ ...asRoot(ROOT), bucket: "main", retentionDays: null });
      expect(plan).toMatchObject({ ok: true });
      if (!plan.ok) return;
      expect(plan.value.buckets[0]?.paths.map((path) => path.storePath)).toEqual([doomed]);
      expect(plan.value.evicted).toBe(1);
      // A DRY RUN DOES NOTHING, which is the only reason it is safe to offer
      // on a page: the object is still there after asking.
      expect(await keysOf(objects)).toContain(keyFor(doomed));

      const report = await cache.admin.gc({ ...asRoot(ROOT), bucket: "main" });
      expect(report).toMatchObject({ ok: true });
      if (report.ok) expect(report.value.report.evicted).toBe(plan.value.evicted);
      expect(await keysOf(objects)).toEqual(keysOfPaths(fresh));
      await dispose();
    });

    it("plans at a retention the bucket does not have, and changes nothing by it", async () => {
      // THE QUESTION 2.7 LEFT OPEN: "what would I lose if this bucket kept
      // only what is referenced or pinned?" — asked without first setting a
      // retention that a collection could then act on. ONE DAY passes and no
      // more: at zero days that is enough for both paths to be expired, so
      // the pin is the whole difference between them, while at the bucket's
      // own thirty it is nothing like enough for either.
      const { cache, objects, travel, dispose } = await make();
      const pinned = "/nix/store/pppppppppppppppppppppppppppppppp-pinned";
      const loose = "/nix/store/llllllllllllllllllllllllllllllll-loose";
      await push(cache, pinned);
      await push(cache, loose);
      expect(
        await cache.admin.pin({ ...asRoot(ROOT), bucket: "main", name: "release", paths: [pinned] }),
      ).toMatchObject({ ok: true });
      travel(DAY);
      // AT THE BUCKET'S OWN THIRTY DAYS there is nothing to take at all.
      const own = await cache.admin.gcPlan({ ...asRoot(ROOT), bucket: "main", retentionDays: null });
      expect(own).toMatchObject({ ok: true });
      if (own.ok) expect(own.value.evicted).toBe(0);

      const asked = await cache.admin.gcPlan({ ...asRoot(ROOT), bucket: "main", retentionDays: 0 });
      expect(asked).toMatchObject({ ok: true });
      if (!asked.ok) return;
      expect(asked.value.buckets[0]?.paths.map((path) => path.storePath)).toEqual([loose]);
      expect(asked.value.evicted).toBe(1);

      // AND IT WROTE NOTHING. The bucket still keeps its own thirty days, so
      // the collection that follows — which has no such field on the wire —
      // evicts neither path, and both objects are still there.
      expect(cache.bucket("main")?.retentionDays).toBe(30);
      const report = await cache.admin.gc({ ...asRoot(ROOT), bucket: "main" });
      expect(report).toMatchObject({ ok: true });
      if (report.ok) expect(report.value.report.evicted).toBe(0);
      expect(await keysOf(objects)).toEqual(keysOfPaths(pinned, loose));

      // The same plan a hundred days later is what the collection then does,
      // which is the other half of "the override is only a question".
      travel(100 * DAY);
      const later = await cache.admin.gcPlan({ ...asRoot(ROOT), bucket: "main", retentionDays: null });
      expect(later.ok && later.value.buckets[0]?.paths.map((path) => path.storePath)).toEqual([loose]);
      await dispose();
    });

    it("refuses a retention that is not a whole number of days", async () => {
      const { cache, dispose } = await make();
      for (const retentionDays of [-1, 1.5]) {
        expect({
          retentionDays,
          answer: await cache.admin.gcPlan({ ...asRoot(ROOT), bucket: "main", retentionDays }),
        }).toMatchObject({ retentionDays, answer: { ok: false, code: "bad_input" } });
      }
      await dispose();
    });

    it("renews what a missing query named, so a cache hit outlives retention", async () => {
      // THE RULE 2.7 TURNS ON: the path is never READ, only asked about by a
      // pusher that already had it. That is a build wanting it, and the
      // collection must leave it alone.
      const { cache, objects, travel, dispose } = await make();
      const asked = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-asked";
      const silent = "/nix/store/ssssssssssssssssssssssssssssssss-silent";
      await push(cache, asked);
      await push(cache, silent);

      travel(100 * DAY);
      const bucket = cache.bucket("main");
      if (bucket === null) throw new Error("no bucket");
      expect(cache.missing(bucket, [{ path: asked }])).toEqual({ missing: [], skipped: [] });
      // A READ of the other one, which must NOT save it.
      cache.touch(bucket, storePathHash(silent));

      await cache.admin.gc({ ...asRoot(ROOT), bucket: "main" });
      expect(await keysOf(objects)).toEqual(keysOfPaths(asked));
      await dispose();
    });

    it("sweeps an object no row names, and keeps the bytes a twin still needs", async () => {
      const { cache, objects, travel, dispose } = await make();
      const alive = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-alive";
      await push(cache, alive);
      // A crash between keeping an object and recording its row: bytes under
      // the bucket's prefix that nothing can ever serve.
      await objects.put("main/nar/deadbeefdeadbeef.nar", new Blob(["orphaned"]));

      travel(1 * DAY);
      // EVERY bucket, because that is the collection the orphan sweep rides
      // on: orphans appear when a push crashes, not when retention passes,
      // so a single bucket's button does not pay a full LIST for them.
      const report = await cache.admin.gc({ ...asRoot(ROOT), bucket: null });
      expect(report).toMatchObject({ ok: true });
      if (report.ok) expect(report.value.report.orphans).toBe(1);
      // ONE orphan, not three: the sweep knows the narinfo and
      // `nix-cache-info` keys the push wrote, and deletes neither.
      expect(await keysOf(objects)).toEqual(keysOfPaths(alive));
      await dispose();
    });
  });

  /**
   * WHAT BUILT A PATH, END TO END (PLAN 4.2) — stated on the narinfo request,
   * kept on the row, answered by `bucket.paths`.
   *
   * Here rather than in a route test because this is the whole of the trip
   * the feature makes: `acceptNarinfo` is the one request that writes the
   * row, and `admin.paths` is what the bucket page reads. Instantiated per
   * store for the same reason the collection is — the provenance is the
   * DATABASE's, not the object store's, and a run on each proves it.
   */
  describe(`${name}: provenance`, () => {
    /** The bucket's paths, newest first — what the page reads. */
    const pathsOf = async (cache: Cache) => {
      const answer = await cache.admin.paths({ bucket: "main", filter: null, after: null });
      if (!answer.ok) throw new Error(`paths: ${answer.message}`);
      return answer.value.paths;
    };

    it("answers the run and the commit a push stated, and null for one that stated neither", async () => {
      const { cache, dispose } = await make();
      const built = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-built";
      const bare = "/nix/store/nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn-bare";
      await push(cache, built, [], { run: "run-42", commit: "a".repeat(40) });
      await push(cache, bare);

      const byPath = new Map((await pathsOf(cache)).map((row) => [row.storePath, row]));
      expect(byPath.get(built)).toMatchObject({ run: "run-42", commit: "a".repeat(40) });
      // NULL, NOT ABSENT: a path nobody said anything about is a path with no
      // provenance, which the page draws as empty rather than as a gap in the
      // answer.
      expect(byPath.get(bare)).toMatchObject({ run: null, commit: null });
      await dispose();
    });

    it("keeps what a run stated when a later push states nothing", async () => {
      const { cache, travel, dispose } = await make();
      const path = "/nix/store/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr-repushed";
      await push(cache, path, [], { run: "run-7", commit: "b".repeat(40) });
      // A DEVELOPER'S BARE `odu cache push` over what CI already stored. It
      // knows no run and no commit, and must not erase the only record of
      // where the bytes came from.
      travel(1 * DAY);
      await push(cache, path);
      expect((await pathsOf(cache))[0]).toMatchObject({ run: "run-7", commit: "b".repeat(40) });

      // AND THE TWO FIELDS COALESCE SEPARATELY: the GitHub action states the
      // commit and never a run, so a stated commit must not carry the absent
      // run into the row.
      travel(1 * DAY);
      await push(cache, path, [], { run: null, commit: "c".repeat(40) });
      expect((await pathsOf(cache))[0]).toMatchObject({
        run: "run-7",
        commit: "c".repeat(40),
      });
      await dispose();
    });

    it("answers a package with its NEWEST version's provenance", async () => {
      const { cache, travel, dispose } = await make();
      // `o`, `e`, `u` and `t` are not in Nix's base32 alphabet, so a hash
      // part made of them is refused before it reaches a row.
      const older = "/nix/store/qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq-widget-1.0";
      const newer = "/nix/store/wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww-widget-1.0";
      await push(cache, older, [], { run: "run-old", commit: "d".repeat(40) });
      travel(1 * DAY);
      await push(cache, newer, [], { run: "run-new", commit: "e".repeat(40) });

      const grouped = await cache.admin.paths({
        bucket: "main",
        filter: null,
        after: null,
        group: "name",
      });
      if (!grouped.ok) throw new Error(`paths: ${grouped.message}`);
      // ONE ROW, and its hash and its provenance are the SAME version's: a
      // package that showed one build's path beside another's commit would
      // send a reader to the wrong run.
      expect(grouped.value.groups).toEqual([
        expect.objectContaining({
          name: "widget-1.0",
          versions: 2,
          storePath: newer,
          run: "run-new",
          commit: "e".repeat(40),
        }),
      ]);
      await dispose();
    });
  });
}

let scratch: string;
let gateway: Gateway;

beforeAll(async () => {
  gateway = await startGateway();
});
afterAll(async () => {
  await gateway.stop();
});

/** A cache whose `main` bucket lives in `store`, with a clock a case moves. */
async function subject(
  store: string,
  objectsFor: (dir: string) => Promise<ObjectStore> | ObjectStore,
): Promise<Subject> {
  const dir = mkdtempSync(join(tmpdir(), "odu-gc-stores-"));
  const objects = await objectsFor(dir);
  let clock = START;
  const cache = createCache({
    stateRoot: dir,
    rootToken: ROOT,
    publicOrigin: "http://cache.test",
    now: () => clock,
    // `local` is always declared (the cache's own disk); the S3 run adds a
    // second name and creates its bucket there, which is the only difference
    // between the two instantiations.
    stores: new Map<string, ObjectStore>([
      ["local", diskObjectStore({ dir: join(dir, "cache") })],
      [store, objects],
    ]),
  });
  const created = await cache.admin.create({
    ...asRoot(ROOT),
    name: "main",
    public: true,
    retentionDays: 30,
    upstreamKeys: [],
    store,
  });
  if (!created.ok) throw new Error(`create: ${created.message}`);
  return {
    cache,
    objects,
    travel: (ms) => {
      clock += ms;
    },
    dispose: async () => {
      await cache.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

gcCases("disk", () => subject("local", (dir) => diskObjectStore({ dir: join(dir, "cache") })));

gcCases("s3 (versitygw)", () =>
  subject("s3", async () => s3ObjectStore({ target: await gateway.bucket() })),
);
