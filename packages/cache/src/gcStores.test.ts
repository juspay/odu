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

interface Subject {
  cache: Cache;
  objects: ObjectStore;
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

const keyFor = (storePath: string): string => objectKey("main", nar(storePath).narHash, "none");

const narinfoFor = (storePath: string): string => narinfoKey("main", storePathHash(storePath));

const CACHE_INFO = cacheInfoKey("main");

const keysOf = async (objects: ObjectStore): Promise<string[]> =>
  (await objects.list("main")).map((entry) => entry.key).sort();

const keysOfPaths = (...storePaths: readonly string[]): string[] =>
  [CACHE_INFO, ...storePaths.flatMap((path) => [keyFor(path), narinfoFor(path)])].sort();

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

      travel(100 * DAY);
      const report = await cache.admin.gc({ ...asRoot(ROOT), bucket: "main" });
      expect(report).toMatchObject({ ok: true });
      if (!report.ok) return;
      expect(report.value.report.evicted).toBe(1);

      const bucket = cache.bucket("main");
      if (bucket === null) throw new Error("no bucket");
      expect(cache.narinfoText(bucket, storePathHash(gone))).toBeNull();
      expect(cache.narinfoText(bucket, storePathHash(kept))).not.toBeNull();
      expect(cache.narinfoText(bucket, storePathHash(child))).not.toBeNull();
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
      expect(await keysOf(objects)).toContain(keyFor(doomed));

      const report = await cache.admin.gc({ ...asRoot(ROOT), bucket: "main" });
      expect(report).toMatchObject({ ok: true });
      if (report.ok) expect(report.value.report.evicted).toBe(plan.value.evicted);
      expect(await keysOf(objects)).toEqual(keysOfPaths(fresh));
      await dispose();
    });

    it("plans at a retention the bucket does not have, and changes nothing by it", async () => {
      const { cache, objects, travel, dispose } = await make();
      const pinned = "/nix/store/pppppppppppppppppppppppppppppppp-pinned";
      const loose = "/nix/store/llllllllllllllllllllllllllllllll-loose";
      await push(cache, pinned);
      await push(cache, loose);
      expect(
        await cache.admin.pin({ ...asRoot(ROOT), bucket: "main", name: "release", paths: [pinned] }),
      ).toMatchObject({ ok: true });
      travel(DAY);
      const own = await cache.admin.gcPlan({ ...asRoot(ROOT), bucket: "main", retentionDays: null });
      expect(own).toMatchObject({ ok: true });
      if (own.ok) expect(own.value.evicted).toBe(0);

      const asked = await cache.admin.gcPlan({ ...asRoot(ROOT), bucket: "main", retentionDays: 0 });
      expect(asked).toMatchObject({ ok: true });
      if (!asked.ok) return;
      expect(asked.value.buckets[0]?.paths.map((path) => path.storePath)).toEqual([loose]);
      expect(asked.value.evicted).toBe(1);

      expect(cache.bucket("main")?.retentionDays).toBe(30);
      const report = await cache.admin.gc({ ...asRoot(ROOT), bucket: "main" });
      expect(report).toMatchObject({ ok: true });
      if (report.ok) expect(report.value.report.evicted).toBe(0);
      expect(await keysOf(objects)).toEqual(keysOfPaths(pinned, loose));

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
      const { cache, objects, travel, dispose } = await make();
      const asked = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-asked";
      const silent = "/nix/store/ssssssssssssssssssssssssssssssss-silent";
      await push(cache, asked);
      await push(cache, silent);

      travel(100 * DAY);
      const bucket = cache.bucket("main");
      if (bucket === null) throw new Error("no bucket");
      expect(cache.missing(bucket, [{ path: asked }], { run: null, commit: null }, false)).toEqual({
        missing: [],
        skipped: [],
      });
      cache.touch(bucket, storePathHash(silent));

      await cache.admin.gc({ ...asRoot(ROOT), bucket: "main" });
      expect(await keysOf(objects)).toEqual(keysOfPaths(asked));
      await dispose();
    });

    it("sweeps an object no row names, and keeps the bytes a twin still needs", async () => {
      const { cache, objects, travel, dispose } = await make();
      const alive = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-alive";
      await push(cache, alive);
      await objects.put("main/nar/deadbeefdeadbeef.nar", new Blob(["orphaned"]));

      travel(1 * DAY);
      const report = await cache.admin.gc({ ...asRoot(ROOT), bucket: null });
      expect(report).toMatchObject({ ok: true });
      if (report.ok) expect(report.value.report.orphans).toBe(1);
      expect(await keysOf(objects)).toEqual(keysOfPaths(alive));
      await dispose();
    });
  });

  describe(`${name}: provenance`, () => {
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
      expect(byPath.get(bare)).toMatchObject({ run: null, commit: null });
      await dispose();
    });

    it("keeps what a run stated when a later push states nothing", async () => {
      const { cache, travel, dispose } = await make();
      const path = "/nix/store/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr-repushed";
      await push(cache, path, [], { run: "run-7", commit: "b".repeat(40) });
      travel(1 * DAY);
      await push(cache, path);
      expect((await pathsOf(cache))[0]).toMatchObject({ run: "run-7", commit: "b".repeat(40) });

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

    const ask = (cache: Cache, storePath: string, provenance: Provenance) => {
      const bucket = cache.bucket("main");
      if (bucket === null) throw new Error("no bucket main");
      return cache.missing(bucket, [{ path: storePath }], provenance, false);
    };

    it("claims a path it already holds from the query that asked about it", async () => {
      const { cache, travel, dispose } = await make();
      const path = "/nix/store/pppppppppppppppppppppppppppppppp-present";
      await push(cache, path);
      expect((await pathsOf(cache))[0]).toMatchObject({ run: null, commit: null });

      travel(1 * DAY);
      expect(ask(cache, path, { run: "run-9", commit: "f".repeat(40) })).toEqual({
        missing: [],
        skipped: [],
      });
      expect((await pathsOf(cache))[0]).toMatchObject({
        run: "run-9",
        commit: "f".repeat(40),
      });
      await dispose();
    });

    it("never overwrites provenance a push or an earlier query already wrote", async () => {
      const { cache, travel, dispose } = await make();
      const path = "/nix/store/ffffffffffffffffffffffffffffffff-first";
      await push(cache, path, [], { run: "run-first", commit: "1".repeat(40) });

      travel(1 * DAY);
      ask(cache, path, { run: "run-later", commit: "2".repeat(40) });
      expect((await pathsOf(cache))[0]).toMatchObject({
        run: "run-first",
        commit: "1".repeat(40),
      });

      const actioned = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-actioned";
      await push(cache, actioned, [], { run: null, commit: "3".repeat(40) });
      travel(1 * DAY);
      ask(cache, actioned, { run: "run-claims", commit: "3".repeat(40) });
      const byPath = new Map((await pathsOf(cache)).map((row) => [row.storePath, row]));
      expect(byPath.get(actioned)).toMatchObject({
        run: "run-claims",
        commit: "3".repeat(40),
      });
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
