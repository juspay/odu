/**
 * GC's DECISION, on a fixture graph — the question "why did my cache eat my
 * build" answered as data.
 *
 * Every case here is a different reason a path is or is not evictable, and the
 * fixture is deliberately a graph rather than a list: the retention rule alone
 * is one line, and the three exceptions to it (a live referrer, a pin's
 * closure, another bucket's root) are what the collector is for.
 *
 * The RUN half drives a real disk `ObjectStore`, because that is all GC is
 * allowed to touch: `delete` for what it evicted, `list` for what no row
 * remembers. The same cases run against S3 in `gcStores.test.ts`, through the
 * whole cache — if one of these claims were store-specific, that file would be
 * the one that failed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { diskObjectStore } from "@odu/objects";
import { type BucketRow, type CacheRepo, type ObjectRow, type PinRow, openCacheRepo } from "./db";
import { planGc, previewGc, runGc } from "./gc";
import { objectKey } from "./staging";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const OLD = NOW - 60 * DAY;
const FRESH = NOW - 1 * DAY;

const bucket: BucketRow = {
  name: "main",
  isPublic: true,
  retentionDays: 30,
  keyName: "main-1",
  secretKey: "main-1:x",
  publicKey: "main-1:y",
  upstreamKeys: [],
  created: OLD,
  domain: null,
  store: "local",
};

const other: BucketRow = { ...bucket, name: "other" };

function obj(
  bucketName: string,
  name: string,
  wanted: number,
  references: string[] = [],
): ObjectRow {
  const storePath = `/nix/store/${name.padEnd(32, "0")}-${name}`;
  return {
    bucket: bucketName,
    storePath,
    hash: name.padEnd(32, "0"),
    narHash: `sha256:${name.padEnd(52, "0")}`,
    narSize: 100,
    references,
    deriver: null,
    ca: null,
    caProof: "unknown",
    compression: "zstd",
    fileHash: null,
    fileSize: null,
    sigs: [],
    hits: 0,
    created: wanted,
    lastWanted: wanted,
  };
}

/** A, referenced by a FRESH B; C alone and old; D pinned; E→F both old. */
const A = obj("main", "a", OLD);
const B = obj("main", "b", FRESH, [A.storePath]);
const C = obj("main", "c", OLD);
const D = obj("main", "d", OLD);
const E = obj("main", "e", OLD, [obj("main", "f", OLD).storePath]);
const F = obj("main", "f", OLD);
const X = obj("other", "x", OLD);

const objects = [A, B, C, D, E, F, X];
const pins: PinRow[] = [
  { bucket: "main", name: "keep-d", rootPaths: [D.storePath], created: OLD, createdBy: "admin" },
];

const evicted = (plan: ReturnType<typeof planGc>, bucketName: string): string[] =>
  (plan.find((entry) => entry.bucket === bucketName)?.evict ?? []).map((row) => row.storePath);

const keyOf = (row: ObjectRow): string => objectKey(row.bucket, row.narHash, row.compression);

describe("planGc", () => {
  it("keeps what a live object references and evicts what nothing holds", () => {
    const plan = planGc({ buckets: [bucket, other], objects, pins, now: NOW });
    expect(evicted(plan, "main").sort()).toEqual([C.storePath, E.storePath, F.storePath].sort());
    // A is old, but B is fresh and references it: retention alone is not the
    // rule, and this is the case the rule exists for.
    expect(evicted(plan, "main")).not.toContain(A.storePath);
    expect(plan.find((entry) => entry.bucket === "main")?.remaining).toBe(3);
  });

  it("counts retention from lastWanted, not from a read", () => {
    // THE WHOLE POINT OF 2.7: a path read every hour but pushed sixty days
    // ago is expired, because reads are about to stop reaching odu at all.
    // `hits` is a statistic; `lastWanted` is the clock.
    const read = { ...C, hits: 10_000 };
    const wanted = { ...C, lastWanted: FRESH };
    expect(evicted(planGc({ buckets: [bucket], objects: [read], pins: [], now: NOW }), "main")).toEqual([
      C.storePath,
    ]);
    expect(evicted(planGc({ buckets: [bucket], objects: [wanted], pins: [], now: NOW }), "main")).toEqual(
      [],
    );
  });

  it("keeps a pinned closure, and a path in it that nothing else references", () => {
    const plan = planGc({ buckets: [bucket], objects, pins, now: NOW });
    expect(evicted(plan, "main")).not.toContain(D.storePath);
  });

  it("protects a path a pin's ROOT references, even when the pin predates it", () => {
    // The pin's stored closure names D; the walk over the bucket's own
    // references is what protects a member added to the closure afterwards.
    const G = obj("main", "g", OLD);
    const withChild = [...objects.filter((row) => row.bucket === "main"), G];
    const plan = planGc({
      buckets: [bucket],
      objects: withChild,
      pins: [{ bucket: "main", name: "p", rootPaths: [D.storePath], created: OLD, createdBy: "admin" }],
      now: NOW,
    });
    // `g` references the pinned `d`; that does not protect `g` (nothing keeps
    // `g`), which is the direction that matters: references flow from the
    // retained object outward.
    expect(evicted(plan, "main")).toContain(G.storePath);
    expect(evicted(plan, "main")).not.toContain(D.storePath);
  });

  it("applies retention per bucket", () => {
    const lenient = { ...other, retentionDays: 365 };
    // `x` is 60 days old: expired in its own 30-day bucket, live in a 365-day
    // one — the same rows, two answers, decided by the bucket.
    expect(evicted(planGc({ buckets: [other], objects, pins, now: NOW }), "other")).toEqual([
      X.storePath,
    ]);
    expect(evicted(planGc({ buckets: [lenient], objects, pins, now: NOW }), "other")).toEqual([]);
  });

  it("expires everything unreferenced and unpinned at retention 0", () => {
    const plan = planGc({ buckets: [{ ...bucket, retentionDays: 0 }], objects, pins, now: NOW });
    expect(evicted(plan, "main").sort()).toEqual(
      [A.storePath, B.storePath, C.storePath, E.storePath, F.storePath].sort(),
    );
  });

  it("never evicts an object a live referrer keeps, however old it is", () => {
    const plan = planGc({ buckets: [bucket], objects, pins: [], now: NOW });
    expect(evicted(plan, "main")).not.toContain(A.storePath);
  });
});

describe("previewGc", () => {
  it("answers the whole count and the bytes, with the oldest wants listed first", () => {
    const sized = objects.map((row) =>
      row.storePath === C.storePath ? { ...row, fileSize: 999, lastWanted: OLD - DAY } : row,
    );
    const preview = previewGc(planGc({ buckets: [bucket], objects: sized, pins, now: NOW }), 2);
    const main = preview.buckets[0];
    expect(main?.evicted).toBe(3);
    // The TOTAL is the whole eviction's, not the truncated list's — a dry run
    // that under-reported what it was about to free would be worse than none.
    expect(main?.bytes).toBe(999 + 100 + 100);
    expect(main?.remaining).toBe(3);
    expect(main?.paths.length).toBe(2);
    expect(main?.paths[0]).toEqual({ storePath: C.storePath, bytes: 999, lastWanted: OLD - DAY });
    expect(preview.evicted).toBe(3);
  });

  it("decides nothing: the rows are still there afterwards", () => {
    const plan = planGc({ buckets: [bucket], objects, pins, now: NOW });
    previewGc(plan, 50);
    expect(plan[0]?.evict.length).toBe(3);
  });
});

describe("runGc", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "odu-gc-"));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** The rows, and an object on disk for each of them. */
  const seeded = async (rows: readonly ObjectRow[]): Promise<CacheRepo> => {
    const repo = openCacheRepo(":memory:");
    repo.putBucket(bucket);
    const store = diskObjectStore({ dir: scratch });
    for (const row of rows) {
      repo.putObject(row);
      await store.put(keyOf(row), new Blob([row.storePath]));
    }
    for (const pin of pins) repo.putPin(pin);
    return repo;
  };

  const store = (): ReturnType<typeof diskObjectStore> => diskObjectStore({ dir: scratch });
  const keys = async (prefix: string): Promise<string[]> =>
    (await store().list(prefix)).map((entry) => entry.key).sort();

  it("drops the rows and deletes each evicted object's key", async () => {
    const repo = await seeded(objects.filter((row) => row.bucket === "main"));
    const report = await runGc(repo, planGc({ buckets: [bucket], objects, pins, now: NOW }), () =>
      store(),
    );

    expect(repo.objects("main").map((row) => row.storePath).sort()).toEqual(
      [A.storePath, B.storePath, D.storePath].sort(),
    );
    expect(await keys("main")).toEqual([A, B, D].map(keyOf).sort());
    expect(report.evicted).toBe(3);
    expect(report.bytes).toBe(300);
    expect(report.buckets[0]?.removed.map((one) => one.storePath).sort()).toEqual(
      [C, E, F].map((row) => row.storePath).sort(),
    );
  });

  it("names what left, so the deletion can be announced", async () => {
    const repo = await seeded([C]);
    const report = await runGc(repo, planGc({ buckets: [bucket], objects: [C], pins: [], now: NOW }), () =>
      store(),
    );
    expect(report.buckets[0]?.removed).toEqual([
      {
        storePath: C.storePath,
        hash: C.hash,
        narFile: `${C.narHash.replace(/^sha256:/, "")}.nar.zst`,
      },
    ]);
  });

  it("does not delete bytes a twin row with the same narHash still needs", async () => {
    const oldTwin = { ...C, storePath: "/nix/store/cccccccccccccccccccccccccccccccc-c-old" };
    const liveTwin = {
      ...C,
      storePath: "/nix/store/cccccccccccccccccccccccccccccccc-c-live",
      lastWanted: FRESH,
    };
    const repo = await seeded([oldTwin, liveTwin]);
    const rows = [oldTwin, liveTwin];
    const report = await runGc(
      repo,
      planGc({ buckets: [bucket], objects: rows, pins: [], now: NOW }),
      () => store(),
    );
    expect(await keys("main")).toEqual([keyOf(C)]);
    expect(report.evicted).toBe(1);
    // The row went and the bytes stayed, which is what `kept` counts — and
    // the announcement must not claim the NAR's URL is gone.
    expect(report.kept).toBe(1);
    expect(report.bytes).toBe(0);
    expect(report.buckets[0]?.removed[0]?.narFile).toBeNull();
  });

  it("re-checks the rows before each delete: a NarHash recorded mid-run keeps its bytes", async () => {
    // THE SNAPSHOT IS NOT THE ANSWER: a row naming an evicted NarHash that
    // appears while the collection runs must keep that object.
    const rows = [C, F];
    const repo = await seeded(rows);
    const arriving = store();
    let seen = 0;
    const watched = {
      ...arriving,
      delete: async (key: string): Promise<void> => {
        seen += 1;
        if (seen === 1) {
          const next = rows.find((row) => keyOf(row) !== key) as ObjectRow;
          repo.putObject({
            ...next,
            storePath: "/nix/store/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-arrived",
            hash: "z".repeat(32),
            lastWanted: NOW,
          });
        }
        await arriving.delete(key);
      },
    };
    const report = await runGc(
      repo,
      planGc({ buckets: [bucket], objects: rows, pins: [], now: NOW }),
      () => watched,
    );
    expect(report.evicted).toBe(2);
    expect(report.kept).toBe(1);
    expect(await keys("main")).toHaveLength(1);
  });

  it("sweeps an object no row names, found by listing the bucket", async () => {
    // A crash between keeping an object and recording its row leaves bytes
    // nothing can ever serve. The boot sweep finds them at startup; a
    // collection is the other moment the write lock makes that safe, and
    // without this they waited for a restart.
    const repo = await seeded([B]);
    await store().put("main/nar/deadbeef.nar.zst", new Blob(["orphan"]));
    const report = await runGc(repo, planGc({ buckets: [bucket], objects: [B], pins: [], now: NOW }), () =>
      store(),
    );
    expect(report.orphans).toBe(1);
    expect(report.bytes).toBe("orphan".length);
    expect(await keys("main")).toEqual([keyOf(B)]);
  });

  it("counts the object's compressed size when the row has one", async () => {
    const sized = objects
      .filter((row) => row.bucket === "main")
      .map((row) => (row.storePath === C.storePath ? { ...row, fileSize: 999 } : row));
    const repo = await seeded(sized);
    const report = await runGc(
      repo,
      planGc({ buckets: [bucket], objects: sized, pins: [], now: NOW }),
      () => store(),
    );
    // C's recorded `fileSize` beats its NAR size; D is evicted too, because
    // this plan has no pins.
    const expected = [C, D, E, F].reduce(
      (sum, row) => sum + (row.storePath === C.storePath ? 999 : row.narSize),
      0,
    );
    expect(report.buckets[0]?.bytes).toBe(expected);
  });
});
