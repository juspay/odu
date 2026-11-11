/**
 * GARBAGE COLLECTION — retention, references and pins, and nothing else.
 *
 * The rule is one sentence and it is the whole answer to "why did my cache eat
 * my build": an object is expired when nobody has WANTED it within its bucket's
 * retention AND nothing the bucket still keeps references it AND no pin holds
 * it. Expired means "delete its object, forget the row". Nothing is evicted
 * because it is old; it is evicted because it is old AND unreachable AND
 * unpinned.
 *
 * **Wanted, not read** ({@link ObjectRow.lastWanted}). A push renews it and the
 * `missing` query renews it; a READ does not. That is not an oversight: reads
 * are leaving odu (PLAN 2.8), so the busiest paths in a bucket are precisely
 * the ones whose reads the daemon will stop seeing, and a collector on the read
 * clock would evict them first. What a cache is for is answering a build, and
 * the thing that says a build still wants a path is the build asking whether
 * the path is there.
 *
 * **The decision is a pure function.** {@link planGc} takes rows and a clock
 * and answers what to evict; {@link runGc} deletes rows and object keys. That
 * split is what lets the suite state a fixture graph — a retained object, a
 * reference to it, a pin over a third — and assert the decision without a
 * filesystem, and it is why a "did GC keep the closure?" question has one place
 * to look. It is also the DRY RUN: the plan is what the bucket page shows
 * before anybody presses the button.
 *
 * **Two closures, because a pin is a promise.** A pin's closure is resolved at
 * pin time and stored, so a path that was in the closure then stays protected
 * even if the bucket has since forgotten the objects that referenced it. GC
 * ALSO walks the bucket's own references from those roots, so a path added to
 * the closure later is protected too. Either alone is a hole: the first misses
 * new members, the second misses members whose linking object was evicted.
 *
 * **A twin does not lose its bytes.** Two store paths can share one NarHash
 * and therefore one object key; the file is deleted only when no remaining row
 * in the bucket names that NarHash.
 *
 * **ONLY `ObjectStore`.** Deleting is `deleteMany`, and the orphan sweep is
 * `list`. Nothing here opens a file, names a directory or signs an S3 request,
 * so a bucket on R2 collects exactly as a bucket on disk does — which is what
 * `@odu/objects`' contract suite and the cache's own GC suite prove by running
 * the same cases against both.
 *
 * **In batches, objects before rows, and the lock only around the
 * decisions.** A collection is thousands of deletes and the service they go
 * to may ask for less at any point, so the run is cut into batches: each is
 * decided under the cache's write lock, deletes its objects with the lock
 * FREE, and drops its rows under the lock again. A batch whose deletes failed
 * drops no rows and the collection stops with a sentence saying why, so
 * nothing is ever forgotten before its bytes are gone and collecting again
 * resumes where this one left off.
 *
 * **And a writer that lands first still wins.** The cache holds ONE async
 * mutex over keep-and-record, `pin` and `gc`, and each batch asks
 * {@link planGc}'s own predicate again under it: a pin or a re-push that
 * arrived since the plan takes its row out of the batch. Each delete still
 * asks the rows, not the plan, whether a twin names its NarHash. What the
 * lock no longer spans is the network — see {@link runGc} for what that
 * costs and what it buys.
 */

import type { ObjectStore } from "@odu/objects";
import type { BucketRow, CacheRepo, ObjectRow, PinRow } from "./db";
import { narFileName } from "./narinfo";
import { cacheInfoKey, narinfoKey, objectKey } from "./staging";

export interface GcInput {
  buckets: readonly BucketRow[];
  objects: readonly ObjectRow[];
  pins: readonly PinRow[];
  now: number;
}

export interface GcBucketPlan {
  bucket: string;
  evict: readonly ObjectRow[];
  remaining: number;
  /** What evicting them would reclaim, by the kept object's own size. */
  bytes: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many paths a DRY RUN lists per bucket. The counts and the bytes are
 *  the whole truth; this is how much of it a person reads before pressing the
 *  button, and the reason a million-path eviction is not a million-row
 *  answer. Beside `previewGc`, the only thing that applies it. */
export const GC_PREVIEW_PATHS = 50;

/** What one evicted row costs: the compressed object when the row knows its
 *  size, the NAR's otherwise (a row from before objects were kept). */
const sizeOf = (row: ObjectRow): number => row.fileSize ?? row.narSize;

/**
 * Every path reachable from `roots` by following `references`, including the
 * roots themselves. Iterative, because a store closure is a graph and a
 * recursive walk over somebody's million-path closure is a stack overflow.
 *
 * A reference may be a bare basename or a full store path, depending on what
 * wrote the row, and both are followed HERE — so a pin's closure and the
 * collector's reach are the same set. Two walks with two rules is a pin that
 * promises paths the collector does not protect.
 */
export function closureOf(roots: Iterable<string>, byPath: Map<string, ObjectRow>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const reference of byPath.get(path)?.references ?? []) {
      queue.push(reference.startsWith("/nix/store/") ? reference : `/nix/store/${reference}`);
    }
  }
  return seen;
}

/**
 * WHAT EVICTING THESE ROWS ACTUALLY FREES — one rule, so the dry run and the
 * collection cannot answer differently about the same bucket.
 *
 * A row's bytes go only when its object goes, and the object goes only when
 * no SURVIVING row names that NarHash — and then once, however many of the
 * evicted rows are twins of each other.
 */
function freedBytes(evict: readonly ObjectRow[], kept: readonly ObjectRow[]): number {
  const survives = new Set(kept.map((row) => row.narHash));
  const counted = new Set<string>();
  let bytes = 0;
  for (const row of evict) {
    if (survives.has(row.narHash) || counted.has(row.narHash)) continue;
    counted.add(row.narHash);
    bytes += sizeOf(row);
  }
  return bytes;
}

export function planGc(input: GcInput): GcBucketPlan[] {
  return input.buckets.map((bucket) => {
    const objects = input.objects.filter((row) => row.bucket === bucket.name);
    const byPath = new Map(objects.map((row) => [row.storePath, row]));
    const expired = (row: ObjectRow): boolean =>
      input.now - row.lastWanted > bucket.retentionDays * DAY_MS;

    // Everything a LIVE object keeps alive: the live objects themselves, and
    // whatever they reference inside this bucket.
    const live = objects.filter((row) => !expired(row));
    const protectedByReference = closureOf(
      live.map((row) => row.storePath),
      byPath,
    );

    const pins = input.pins.filter((pin) => pin.bucket === bucket.name);
    const pinnedRoots = pins.flatMap((pin) => pin.rootPaths);
    const protectedByPin = closureOf(pinnedRoots, byPath);

    const doomed = (row: ObjectRow): boolean =>
      expired(row) &&
      !protectedByReference.has(row.storePath) &&
      !protectedByPin.has(row.storePath);
    const evict = objects.filter(doomed);
    return {
      bucket: bucket.name,
      evict,
      remaining: objects.length - evict.length,
      bytes: freedBytes(
        evict,
        objects.filter((row) => !doomed(row)),
      ),
    };
  });
}

/** What the next collection would do to one bucket. */
export interface GcBucketPreview {
  bucket: string;
  /** How many paths it would evict, and what that would reclaim — the WHOLE
   *  count, whatever `paths` was truncated to. */
  evicted: number;
  bytes: number;
  remaining: number;
  /** The first `limit` of them, oldest want first: a person reading a dry run
   *  wants to recognise what is about to go, not to page a million rows. */
  paths: readonly { storePath: string; bytes: number; lastWanted: number }[];
}

export interface GcPreview {
  buckets: readonly GcBucketPreview[];
  evicted: number;
  bytes: number;
}

/** The plan, as a person reads it. Pure: this is the dry run. */
export function previewGc(plan: readonly GcBucketPlan[], limit: number): GcPreview {
  const buckets = plan.map((entry) => ({
    bucket: entry.bucket,
    evicted: entry.evict.length,
    bytes: entry.bytes,
    remaining: entry.remaining,
    paths: [...entry.evict]
      .sort((one, two) => one.lastWanted - two.lastWanted)
      .slice(0, limit)
      .map((row) => ({
        storePath: row.storePath,
        bytes: sizeOf(row),
        lastWanted: row.lastWanted,
      })),
  }));
  return {
    buckets,
    evicted: buckets.reduce((sum, bucket) => sum + bucket.evicted, 0),
    bytes: buckets.reduce((sum, bucket) => sum + bucket.bytes, 0),
  };
}

/** ONE PATH THAT LEFT, as the row announces it to whatever was caching it.
 *  `narFile` is null when a twin row still names the bytes: the narinfo is
 *  gone, the NAR is not. */
export interface GcRemoval {
  storePath: string;
  /** The store path's hash — the narinfo's own name. */
  hash: string;
  /** `<narHash>.<ext>`, the NAR's name under `nar/`, or null. */
  narFile: string | null;
}

export interface GcBucketReport {
  bucket: string;
  /** Rows dropped and paths deleted from the store. */
  evicted: number;
  /** Rows dropped whose bytes a TWIN row still names — the object stayed. */
  kept: number;
  /** Bytes reclaimed, by the one rule {@link planGc} previews. */
  bytes: number;
  /** Object keys the store held that no row named — a crash between keeping
   *  an object and recording it. Swept by {@link sweepOrphans}, counted here
   *  because this is the report a person reads. */
  orphans: number;
}

export interface GcReport {
  buckets: GcBucketReport[];
  evicted: number;
  kept: number;
  bytes: number;
  orphans: number;
  /**
   * WHY THE COLLECTION DID NOT FINISH, in one plain sentence, or null.
   *
   * A store that refuses a delete is not a crash and is not an empty
   * report: the counts above are what DID leave, every row whose objects
   * were not confirmed deleted is still recorded, and pressing Run GC again
   * carries on from there. The sentence is for a person — an operator read
   * an R2 `<Error>` document on the bucket page the day this was written —
   * so it names the service's code and its words and never its XML.
   */
  stopped: string | null;
}

/**
 * WHAT A COLLECTION DID, and separately WHAT LEFT.
 *
 * The report is the answer a caller reads and the shape the wire carries; the
 * removals are the purge port's payload. They are two things on two clocks —
 * a contract major moves the first, an edge's needs the second — so a report
 * that carried removals would be a wire answer somebody has to remember to
 * strip, and would leak the day somebody forgot.
 */
export interface GcCollection {
  report: GcReport;
  /** By bucket, in the order they were deleted. */
  removed: ReadonlyMap<string, readonly GcRemoval[]>;
}

/**
 * HOW MANY ROWS ONE BATCH TAKES. A batch is two `deleteMany` calls — the
 * narinfos, then the NARs — so on S3 it is two requests, inside the 1000-key
 * ceiling of each. It is also the most work one refusal can cost: a batch
 * whose deletes failed drops no rows, and the next collection starts there.
 */
const GC_BATCH_ROWS = 500;

/** What {@link runGc} needs beyond the plan. */
export interface GcRunOptions {
  /** The clock the plan was taken on — the same one, so a re-check cannot
   *  find a row expired that the plan found live. */
  now?: () => number;
  /**
   * RUN `work` WITH NOTHING ELSE ABLE TO WRITE — the cache's write lock.
   *
   * Decisions and row drops take it; the deletes between them never do. The
   * default runs the work as it is, for a caller with no writers (the suite).
   */
  withLock?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Rows per batch; {@link GC_BATCH_ROWS} unless a caller says otherwise. */
  batch?: number;
}

/** WHAT ONE BATCH IS ABOUT TO DO, decided against the rows AS THEY ARE and
 *  with no network in it: the caller takes the lock for this and lets it go
 *  for the deletes. */
interface GcBatch {
  /** The rows going, in the plan's order — still doomed, still recorded. */
  rows: ObjectRow[];
  /** One per row: the narinfo object that is the row's own. */
  narinfos: string[];
  /** The NAR objects no row outside this batch names any more. */
  nars: string[];
  /** Per row, what the purge port is told. */
  removals: GcRemoval[];
  /** Rows whose bytes another row still names — the object stayed. */
  kept: number;
  bytes: number;
}

/**
 * THE DECISION FOR ONE BATCH, taken again rather than read off the plan.
 *
 * `doomed` is {@link planGc}'s own answer re-asked of the rows as they are
 * NOW, which is the whole point of deciding per batch: a pin or a re-push
 * that landed since the plan takes its row out of the batch rather than
 * losing its bytes.
 *
 * TWINS: two rows can carry the same NarHash (different store paths, one
 * object), and the bytes go only when no row in the bucket names them. The
 * question is asked of the database — an indexed lookup — minus the rows
 * this batch is itself dropping, so a row that appeared mid-run keeps its
 * object and a NarHash wholly inside this batch is deleted exactly once,
 * with the last of its rows. It is `freedBytes`' rule, applied to the rows
 * as they are.
 */
function decideBatch(
  repo: CacheRepo,
  bucket: string,
  batch: readonly ObjectRow[],
  doomed: ReadonlySet<string>,
): GcBatch {
  const rows = batch.filter((row) => doomed.has(row.storePath));
  const going = new Set(rows.map((row) => row.storePath));
  /** The row that will delete each NarHash's object: the last one here. */
  const closes = new Map(rows.map((row) => [row.narHash, row.storePath]));
  const decided: GcBatch = { rows, narinfos: [], nars: [], removals: [], kept: 0, bytes: 0 };
  for (const row of rows) {
    const elsewhere = repo
      .objectsByNarHash(bucket, row.narHash)
      .some((other) => !going.has(other.storePath));
    const takesBytes = !elsewhere && closes.get(row.narHash) === row.storePath;
    // THE NARINFO OBJECT IS THE ROW'S OWN (PLAN 2.8) — one per store path,
    // never shared by twins the way a NAR is, so it goes whenever the row
    // does. A store left holding it would answer a path odu has forgotten,
    // with a NAR URL that 404s.
    decided.narinfos.push(narinfoKey(bucket, row.hash));
    if (takesBytes) {
      decided.nars.push(objectKey(bucket, row.narHash, row.compression));
      decided.bytes += sizeOf(row);
    } else {
      decided.kept += 1;
    }
    decided.removals.push({
      storePath: row.storePath,
      hash: row.hash,
      narFile: takesBytes ? narFileName(row.narHash, row.compression) : null,
    });
  }
  return decided;
}

/** WHY A COLLECTION STOPPED, as a person reads it: one line, the service's
 *  own words, and no markup whatever threw. */
function stoppedBy(bucket: string, err: unknown): string {
  const said = (err instanceof Error ? err.message : String(err))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return (
    `${bucket}: the store refused a delete — ${said}. ` +
    "Everything it would not delete is still recorded, so collecting again carries on from there."
  );
}

/**
 * DO THE PLAN, A BATCH AT A TIME. An object leaves BEFORE its row: the bytes
 * are the object store's, deleted by key, so nothing on this machine's Nix
 * store is touched (the server does not have one).
 *
 * **Objects, then rows, and never the other way round.** A row dropped ahead
 * of its object is a narinfo R2 still serves for a path odu has forgotten,
 * whose NAR 404s until an all-bucket orphan sweep — which is exactly what an
 * aborted collection left behind the day this was written. So a batch deletes
 * its narinfos, then its NARs, then drops its rows; a batch that fails drops
 * none of them and the collection STOPS, saying so ({@link GcReport.stopped}),
 * with every unconfirmed row still recorded. Pressing Run GC again resumes.
 *
 * **The narinfos go first** because the two are not symmetric: a run that
 * stops between them leaves a NAR whose narinfo is gone, which the row still
 * names and the boot backfill rewrites — where the other order leaves a
 * narinfo promising a NAR that is not there.
 *
 * **The lock is held for decisions, never across the network.** Each batch is
 * decided under `withLock` and its rows dropped under `withLock`; the deletes
 * between run with the lock free, so an hour-long collection no longer blocks
 * every push to the daemon. The invariant that buys: a pin or a re-push that
 * lands between the plan and a batch's decision WINS — the decision is
 * {@link planGc}'s predicate asked again of the rows as they are, and a row it
 * no longer dooms is left where it is. What the lock no longer covers is the
 * deletes themselves: a push that lands while a batch's objects are being
 * deleted may be told the bucket has a path whose object is going. That window
 * is one batch of deletes rather than, as before, the whole collection, and it
 * costs a re-push rather than a row that outlives its bytes.
 */
export async function runGc(
  repo: CacheRepo,
  plan: readonly GcBucketPlan[],
  /** The store each bucket's objects live in. */
  objectsOf: (bucket: string) => ObjectStore,
  options: GcRunOptions = {},
): Promise<GcCollection> {
  const now = options.now ?? Date.now;
  const withLock = options.withLock ?? ((work) => work());
  const size = Math.max(1, options.batch ?? GC_BATCH_ROWS);
  const perBucket = new Map<string, GcBucketReport>(
    plan.map((entry) => [
      entry.bucket,
      { bucket: entry.bucket, evicted: 0, kept: 0, bytes: 0, orphans: 0 },
    ]),
  );
  const removed = new Map<string, GcRemoval[]>();
  let stopped: string | null = null;
  for (const entry of plan) {
    if (stopped !== null) break;
    const report = perBucket.get(entry.bucket) as GcBucketReport;
    const left: GcRemoval[] = [];
    removed.set(entry.bucket, left);
    const objects = objectsOf(entry.bucket);
    for (let at = 0; at < entry.evict.length; at += size) {
      const batch = entry.evict.slice(at, at + size);
      const decided = await withLock(async () =>
        decideBatch(repo, entry.bucket, batch, stillDoomed(repo, entry.bucket, now())),
      );
      if (decided.rows.length === 0) continue;
      try {
        await objects.deleteMany(decided.narinfos);
        await objects.deleteMany(decided.nars);
      } catch (err) {
        stopped = stoppedBy(entry.bucket, err);
        break;
      }
      await withLock(async () => {
        for (const row of decided.rows) repo.deleteObject(entry.bucket, row.storePath);
      });
      left.push(...decided.removals);
      report.evicted += decided.rows.length;
      report.kept += decided.kept;
      report.bytes += decided.bytes;
    }
  }
  const buckets = [...perBucket.values()];
  return {
    report: {
      buckets,
      evicted: buckets.reduce((sum, bucket) => sum + bucket.evicted, 0),
      kept: buckets.reduce((sum, bucket) => sum + bucket.kept, 0),
      bytes: buckets.reduce((sum, bucket) => sum + bucket.bytes, 0),
      orphans: 0,
      stopped,
    },
    removed,
  };
}

/** THE PLAN'S OWN PREDICATE, ASKED AGAIN of one bucket's rows as they are:
 *  the store paths {@link planGc} would evict from it NOW. A bucket deleted
 *  mid-collection dooms nothing. */
function stillDoomed(repo: CacheRepo, bucket: string, now: number): ReadonlySet<string> {
  const row = repo.bucket(bucket);
  if (row === null) return new Set();
  const [fresh] = planGc({
    buckets: [row],
    objects: repo.objects(bucket),
    pins: repo.pins(),
    now,
  });
  return new Set((fresh?.evict ?? []).map((one) => one.storePath));
}

/**
 * EVERY KEY UNDER A BUCKET THAT NO ROW NAMES — a put whose record never
 * landed, deleted. `list` is the only way to learn of one, which is why this
 * is the other half of "GC speaks only `ObjectStore`".
 *
 * It runs on the CRASH clock, not the retention clock: orphans appear when a
 * push dies mid-put, so the sweep belongs to the two moments a daemon knows
 * nothing it owns is writing and is walking everything anyway — boot, and a
 * collection of every bucket. The single-bucket button does not pay a full
 * paged LIST of a million-key store to find what a crash leaves behind.
 *
 * The rows are re-read here rather than taken from a plan, so a path recorded
 * during the collection keeps its object.
 */
export async function sweepOrphans(
  repo: CacheRepo,
  bucket: string,
  objects: ObjectStore,
): Promise<number> {
  // EVERY KEY A BUCKET IS MEANT TO HAVE: its NARs, the narinfo beside each
  // one, and its `nix-cache-info` (PLAN 2.8). The last is named by the bucket
  // rather than by a row, so an empty bucket keeps it.
  const named = new Set([
    ...repo.objects(bucket).flatMap((row) => [
      objectKey(bucket, row.narHash, row.compression),
      narinfoKey(bucket, row.hash),
    ]),
    cacheInfoKey(bucket),
  ]);
  let swept = 0;
  for (const object of await objects.list(bucket)) {
    if (named.has(object.key)) continue;
    await objects.delete(object.key);
    swept += 1;
  }
  return swept;
}
