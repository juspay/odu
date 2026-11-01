/**
 * GC's DECISION, on a fixture graph — the question "why did my cache eat my
 * build" answered as data.
 *
 * Every case here is a different reason a path is or is not evictable, and the
 * fixture is deliberately a graph rather than a list: the retention rule alone
 * is one line, and the three exceptions to it (a live referrer, a pin's
 * closure, another bucket's root) are what the collector is for.
 */

import { describe, expect, it } from "bun:test";
import { type BucketRow, type CacheRepo, type ObjectRow, type PinRow, openCacheRepo } from "./db";
import { planGc, runGc } from "./gc";
import { FakeStore } from "../test/fakeStore";

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
};

const other: BucketRow = { ...bucket, name: "other" };

function obj(
  bucketName: string,
  name: string,
  accessed: number,
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
    created: accessed,
    lastAccessed: accessed,
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
const pins: PinRow[] = [{ bucket: "main", name: "keep-d", rootPaths: [D.storePath], created: OLD }];

const evicted = (plan: ReturnType<typeof planGc>, bucketName: string): string[] =>
  (plan.find((entry) => entry.bucket === bucketName)?.evict ?? []).map((row) => row.storePath);

describe("planGc", () => {
  it("keeps what a live object references and evicts what nothing holds", () => {
    const plan = planGc({ buckets: [bucket, other], objects, pins, now: NOW });
    expect(evicted(plan, "main").sort()).toEqual([C.storePath, E.storePath, F.storePath].sort());
    // A is old, but B is fresh and references it: retention alone is not the
    // rule, and this is the case the rule exists for.
    expect(evicted(plan, "main")).not.toContain(A.storePath);
    expect(plan.find((entry) => entry.bucket === "main")?.remaining).toBe(3);
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
      pins: [{ bucket: "main", name: "p", rootPaths: [D.storePath], created: OLD }],
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

describe("runGc", () => {
  const repoWith = (): CacheRepo => {
    const repo = openCacheRepo(":memory:");
    repo.putBucket(bucket);
    for (const row of objects) repo.putObject(row);
    for (const pin of pins) repo.putPin(pin);
    return repo;
  };

  it("drops the rows and deletes each evicted object's key", async () => {
    const repo = repoWith();
    const deleted: string[] = [];
    const report = await runGc(
      repo,
      planGc({ buckets: [bucket], objects, pins, now: NOW }),
      { delete: async (key) => void deleted.push(key) },
    );

    expect(deleted.sort()).toEqual(
      [C, E, F]
        .map((row) => `main/nar/${row.narHash.replace(/^sha256:/, "")}.nar.zst`)
        .sort(),
    );
    expect(repo.objects("main").map((row) => row.storePath).sort()).toEqual(
      [A.storePath, B.storePath, D.storePath].sort(),
    );
    expect(report.buckets).toEqual([{ bucket: "main", evicted: 3, kept: 0, bytes: 300 }]);
    expect(report.evicted).toBe(3);
  });

  it("does not delete bytes a twin row with the same narHash still needs", async () => {
    const repo = openCacheRepo(":memory:");
    repo.putBucket(bucket);
    const oldTwin = { ...C, storePath: "/nix/store/cccccccccccccccccccccccccccccccc-c-old" };
    const liveTwin = { ...C, storePath: "/nix/store/cccccccccccccccccccccccccccccccc-c-live", lastAccessed: FRESH };
    repo.putObject(oldTwin);
    repo.putObject(liveTwin);
    const rows = [oldTwin, liveTwin];
    const deleted: string[] = [];
    const report = await runGc(
      repo,
      planGc({ buckets: [bucket], objects: rows, pins: [], now: NOW }),
      { delete: async (key) => void deleted.push(key) },
    );
    expect(deleted).toEqual([]);
    expect(report.evicted).toBe(1);
  });

  it("counts the object's compressed size when the row has one", async () => {
    const repo = openCacheRepo(":memory:");
    repo.putBucket(bucket);
    const sized = objects.map((row) =>
      row.storePath === C.storePath ? { ...row, fileSize: 999 } : row,
    );
    for (const row of sized) repo.putObject(row);
    const report = await runGc(
      repo,
      planGc({ buckets: [bucket], objects: sized, pins: [], now: NOW }),
      { delete: async () => {} },
    );
    const expected = [C, D, E, F].reduce(
      (sum, row) => sum + (row.storePath === C.storePath ? 999 : row.narSize),
      0,
    );
    expect(report.buckets[0]?.bytes).toBe(expected);
  });
});
