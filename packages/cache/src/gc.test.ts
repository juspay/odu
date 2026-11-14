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
import { diskObjectStore, type ObjectStore } from "@odu/objects";
import { type BucketRow, type CacheRepo, type ObjectRow, type PinRow, openCacheRepo } from "./db";
import {
  type GcBucketPlan,
  type GcCollection,
  type GcRunOptions,
  type Hold,
  holdsOf,
  keptBy,
  longestHeld,
  planGc,
  previewGc,
  runGc,
  sweepOrphans,
} from "./gc";
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
    run: null,
    commit: null,
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

/**
 * WHAT KEEPS EACH PATH — the bucket page's "kept by" column, on the same
 * fixture graph the collector is graded on. A verdict a reader would notice
 * was wrong is a case here; the last one is that the column and the
 * collector cannot disagree.
 */
describe("what keeps a path", () => {
  const main = objects.filter((row) => row.bucket === "main");
  const verdicts = (
    rows: readonly ObjectRow[],
    held: readonly PinRow[],
    now: number,
    days = bucket.retentionDays,
  ) => {
    const holds = holdsOf({ retentionDays: days }, rows, held);
    return new Map([...holds].map(([path, hold]) => [path, keptBy(hold, now)]));
  };

  it("says pin, retention, reference or nothing, from the fixture graph", () => {
    const said = verdicts(main, pins, NOW);
    expect(said.get(B.storePath)).toEqual({
      kind: "retention",
      pins: [],
      via: null,
      until: FRESH + 30 * DAY,
    });
    // A IS OLD, and B — fresh, and referencing it — is why it stays: the
    // column names B and leaves when B's clock does.
    expect(said.get(A.storePath)).toEqual({
      kind: "reference",
      pins: [],
      via: B.storePath,
      until: FRESH + 30 * DAY,
    });
    expect(said.get(D.storePath)).toMatchObject({ kind: "pin", pins: ["keep-d"] });
    for (const row of [C, E, F]) expect(said.get(row.storePath)?.kind).toBe("nothing");
  });

  it("keeps a path at the instant its clock runs out, and not a millisecond later", () => {
    const until = FRESH + 30 * DAY;
    expect(verdicts(main, [], until).get(B.storePath)?.kind).toBe("retention");
    expect(verdicts(main, [], until + 1).get(B.storePath)?.kind).toBe("nothing");
  });

  it("names every pin over a path, and a path a pin's root references", () => {
    const G = obj("main", "g", OLD);
    const root = obj("main", "r", OLD, [G.storePath]);
    const said = verdicts(
      [...main, G, root],
      [
        ...pins,
        { bucket: "main", name: "second", rootPaths: [D.storePath], created: OLD + 1, createdBy: "admin" },
        // THE PIN PREDATES G: its stored closure is only `r`, and the walk over
        // the bucket's own references is what reaches `g`.
        { bucket: "main", name: "release", rootPaths: [root.storePath], created: OLD + 2, createdBy: "write" },
      ],
      NOW,
    );
    expect(said.get(D.storePath)?.pins).toEqual(["keep-d", "second"]);
    expect(said.get(G.storePath)).toMatchObject({ kind: "pin", pins: ["release"] });
  });

  it("calls a dependency wanted with its dependent retention, not reference", () => {
    // ONE PUSH RENEWS A WHOLE CLOSURE TO ONE INSTANT, so the path's own clock
    // is the answer; `reference` is for a dependent that genuinely outlives it.
    const child = obj("main", "k", FRESH);
    const parent = obj("main", "p", FRESH, [child.storePath]);
    expect(verdicts([child, parent], [], NOW).get(child.storePath)).toMatchObject({
      kind: "retention",
      via: null,
    });
  });

  it("names the latest clock that reaches a path, however far up it is", () => {
    const leaf = obj("main", "l", OLD);
    const middle = obj("main", "m", OLD + DAY, [leaf.storePath]);
    const top = obj("main", "t", FRESH, [middle.storePath]);
    const said = verdicts([leaf, middle, top], [], NOW);
    expect(said.get(leaf.storePath)).toMatchObject({ kind: "reference", via: top.storePath });
    expect(said.get(middle.storePath)).toMatchObject({ kind: "reference", via: top.storePath });
  });

  it("at retention 0, answers only pin or nothing", () => {
    const said = verdicts(main, pins, NOW, 0);
    expect(new Set([...said.values()].map((verdict) => verdict.kind))).toEqual(
      new Set(["pin", "nothing"]),
    );
  });

  it("ends on a reference cycle and a self-reference", () => {
    const one = obj("main", "o", OLD, ["/nix/store/".concat("w".padEnd(32, "0"), "-w")]);
    const two = obj("main", "w", FRESH, [one.storePath]);
    const self = obj("main", "s", OLD);
    const looped = { ...self, references: [self.storePath] };
    const said = verdicts([one, two, looped], [], NOW);
    expect(said.get(one.storePath)).toMatchObject({ kind: "reference", via: two.storePath });
    expect(said.get(two.storePath)?.kind).toBe("retention");
    expect(said.get(looped.storePath)?.kind).toBe("nothing");
  });

  it("agrees with the collector: `nothing` is exactly what planGc evicts", () => {
    for (const days of [30, 0]) {
      const rows = [...main, obj("main", "g", OLD, [D.storePath])];
      const said = verdicts(rows, pins, NOW, days);
      const nothing = [...said].filter(([, verdict]) => verdict.kind === "nothing").map(([path]) => path);
      const plan = planGc({ buckets: [{ ...bucket, retentionDays: days }], objects: rows, pins, now: NOW });
      expect(nothing.sort()).toEqual(evicted(plan, "main").sort());
    }
  });

  it("holds a package for as long as its longest-held version", () => {
    const clock = (until: number, pinNames: string[] = []): Hold => ({ pins: pinNames, until, via: null });
    // A PIN HAS NO END DATE, so a pinned version beats any clock.
    expect(longestHeld([clock(NOW + 9 * DAY), clock(NOW, ["release"])])).toEqual(clock(NOW, ["release"]));
    expect(longestHeld([clock(NOW), clock(NOW + 9 * DAY), clock(NOW + DAY)])).toEqual(clock(NOW + 9 * DAY));
    expect(longestHeld([])).toBeNull();
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

  /** The collection, on the FIXTURE'S clock. Each batch asks the plan's own
   *  question again, so a run taken on another clock would answer about a
   *  different retention than the plan it was handed. */
  const collect = (
    repo: CacheRepo,
    plan: readonly GcBucketPlan[],
    objectsOf: (bucket: string) => ObjectStore,
    options: GcRunOptions = {},
  ): Promise<GcCollection> => runGc(repo, plan, objectsOf, { now: () => NOW, ...options });

  /** A store that refuses every `deleteMany` from the `from`-th BATCH on,
   *  the way R2 refused one: a batch is two calls, the narinfos and then the
   *  NARs. The body is the service's, XML and all — what reaches a person
   *  must not be. */
  const refusing = (from: number): ObjectStore => {
    const live = store();
    let calls = 0;
    return {
      ...live,
      deleteMany: async (keys: readonly string[]): Promise<void> => {
        calls += 1;
        if (Math.ceil(calls / 2) >= from) {
          throw new Error(
            "DeleteObjects main: 429 <Error><Code>ServiceUnavailable</Code>" +
              "<Message>Reduce your concurrent request rate for the same object.</Message></Error>",
          );
        }
        await live.deleteMany(keys);
      },
    };
  };

  it("drops the rows and deletes each evicted object's key", async () => {
    const repo = await seeded(objects.filter((row) => row.bucket === "main"));
    const { report, removed } = await collect(
      repo,
      planGc({ buckets: [bucket], objects, pins, now: NOW }),
      () => store(),
    );

    expect(repo.objects("main").map((row) => row.storePath).sort()).toEqual(
      [A.storePath, B.storePath, D.storePath].sort(),
    );
    expect(await keys("main")).toEqual([A, B, D].map(keyOf).sort());
    expect(report.evicted).toBe(3);
    expect(report.bytes).toBe(300);
    expect([...(removed.get("main") ?? [])].map((one) => one.storePath).sort()).toEqual(
      [C, E, F].map((row) => row.storePath).sort(),
    );
  });

  it("promises in the plan exactly the bytes the collection frees", async () => {
    // ONE RULE, TWO READERS. The dry run is what a person presses the button
    // on, so a plan that counted a twin's object twice — or counted bytes a
    // surviving row still names — would be a page that lies about the disk.
    const twin = { ...C, storePath: "/nix/store/cccccccccccccccccccccccccccccccc-c-twin" };
    const rows = [C, twin, E, F];
    const repo = await seeded(rows);
    const plan = planGc({ buckets: [bucket], objects: rows, pins: [], now: NOW });
    const promised = plan[0]?.bytes ?? -1;
    const { report } = await collect(repo, plan, () => store());
    expect(report.bytes).toBe(promised);
    // Non-vacuous: C and its twin are both evicted and share ONE object, so
    // a plan that summed every row would have promised 100 bytes too many.
    expect(report.evicted).toBe(4);
    expect(report.kept).toBe(1);
    expect(promised).toBe(300);
  });

  it("names what left, so the deletion can be announced", async () => {
    const repo = await seeded([C]);
    const { removed } = await collect(
      repo,
      planGc({ buckets: [bucket], objects: [C], pins: [], now: NOW }),
      () => store(),
    );
    expect(removed.get("main")).toEqual([
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
    const { report, removed } = await collect(
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
    expect(removed.get("main")?.[0]?.narFile).toBeNull();
  });

  it("re-checks the rows before each BATCH: a NarHash recorded mid-run keeps its bytes", async () => {
    // THE SNAPSHOT IS NOT THE ANSWER: a row naming an evicted NarHash that
    // appears while the collection runs must keep that object. One row a
    // batch, so the row that lands during the first batch's deletes is there
    // to be found when the second is decided.
    const rows = [C, F];
    const repo = await seeded(rows);
    const arriving = store();
    let batches = 0;
    const watched = {
      ...arriving,
      deleteMany: async (keys: readonly string[]): Promise<void> => {
        batches += 1;
        if (batches === 1) {
          repo.putObject({
            ...F,
            storePath: "/nix/store/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-arrived",
            hash: "z".repeat(32),
            lastWanted: NOW,
          });
        }
        await arriving.deleteMany(keys);
      },
    };
    const { report } = await collect(
      repo,
      planGc({ buckets: [bucket], objects: rows, pins: [], now: NOW }),
      () => watched,
      { batch: 1 },
    );
    expect(report.evicted).toBe(2);
    // F's bytes stayed: the row that arrived names its NarHash.
    expect(report.kept).toBe(1);
    expect(await keys("main")).toHaveLength(1);
  });

  it("counts the object's compressed size when the row has one", async () => {
    const sized = objects
      .filter((row) => row.bucket === "main")
      .map((row) => (row.storePath === C.storePath ? { ...row, fileSize: 999 } : row));
    const repo = await seeded(sized);
    const { report } = await collect(
      repo,
      planGc({ buckets: [bucket], objects: sized, pins, now: NOW }),
      () => store(),
    );
    // C's recorded `fileSize` beats its NAR size; D is held by the fixture's
    // pin, which the collection re-checks against the rows as they are.
    const expected = [C, E, F].reduce(
      (sum, row) => sum + (row.storePath === C.storePath ? 999 : row.narSize),
      0,
    );
    expect(report.buckets[0]?.bytes).toBe(expected);
  });

  it("stops where the store refused, and keeps every row whose objects did not go", async () => {
    // THE DAY THIS WAS WRITTEN: R2 answered one DELETE with a 429 a quarter
    // of an hour into a 6 137-path collection, and the whole thing ended with
    // an XML document on the bucket page and every row of the aborted batch
    // already forgotten. Now the batch that failed keeps its rows.
    const rows = [C, E, F];
    const repo = await seeded(rows);
    const { report, removed } = await collect(
      repo,
      planGc({ buckets: [bucket], objects: rows, pins: [], now: NOW }),
      () => refusing(2),
      { batch: 1 },
    );
    expect(report.evicted).toBe(1);
    expect(report.bytes).toBe(100);
    // WHAT A PERSON READS: the service's own words, and no markup.
    expect(report.stopped).toContain("Reduce your concurrent request rate");
    expect(report.stopped).not.toContain("<");
    // Only the batch that landed is announced, and only its row is gone.
    expect(removed.get("main")?.map((one) => one.storePath)).toEqual([C.storePath]);
    expect(repo.objects("main").map((row) => row.storePath).sort()).toEqual(
      [E.storePath, F.storePath].sort(),
    );
    expect(await keys("main")).toEqual([E, F].map(keyOf).sort());

    // AND PRESSING RUN GC AGAIN RESUMES: the rows that stayed are the plan.
    const again = await collect(
      repo,
      planGc({ buckets: [bucket], objects: repo.objects("main"), pins: [], now: NOW }),
      () => store(),
      { batch: 1 },
    );
    expect(again.report).toMatchObject({ evicted: 2, stopped: null });
    expect(repo.objects("main")).toEqual([]);
    expect(await keys("main")).toEqual([]);
  });

  it("deletes objects before rows: a store that refuses everything leaves every row", async () => {
    // THE ORDER IS THE WHOLE POINT. A row dropped ahead of its object is a
    // narinfo the store still serves for a path odu has forgotten, with a NAR
    // URL that 404s — so a collection that could delete NOTHING must forget
    // nothing either.
    const rows = [C, E, F];
    const repo = await seeded(rows);
    const { report, removed } = await collect(
      repo,
      planGc({ buckets: [bucket], objects: rows, pins: [], now: NOW }),
      () => refusing(1),
      { batch: 1 },
    );
    expect(report).toMatchObject({ evicted: 0, kept: 0, bytes: 0 });
    expect(report.stopped).not.toBeNull();
    expect(removed.get("main")).toEqual([]);
    expect(repo.objects("main")).toHaveLength(3);
    expect(await keys("main")).toEqual(rows.map(keyOf).sort());
  });

  it("sweeps the keys no row names, and leaves another bucket's alone", async () => {
    // The sweep is its own verb now: orphans appear when a push CRASHES, not
    // when retention passes, so a collection of one bucket does not pay a
    // full paged LIST for them — boot and a full collection do.
    const repo = await seeded([B]);
    await store().put("main/nar/deadbeefdeadbeef.nar.zst", new Blob(["orphan"]));
    await store().put("other/nar/deadbeefdeadbeef.nar.zst", new Blob(["somebody else's"]));
    expect(await sweepOrphans(repo, "main", store())).toBe(1);
    expect(await keys("main")).toEqual([keyOf(B)]);
    expect(await keys("other")).toHaveLength(1);
  });
});
