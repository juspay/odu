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
 * **ONLY `ObjectStore`.** Deleting is `delete`, and the orphan sweep is `list`.
 * Nothing here opens a file, names a directory or signs an S3 request, so a
 * bucket on R2 collects exactly as a bucket on disk does — which is what
 * `@odu/objects`' contract suite and the cache's own GC suite prove by running
 * the same cases against both.
 *
 * **And nothing can land in between.** The cache holds ONE async mutex over
 * keep-and-record, `pin` and `gc`: a collection plans and deletes with no
 * writer able to interleave, and a pin that arrived first is already in the
 * plan. A push keeps its object under that lock too, so it cannot see an object
 * this run is about to delete. Each delete still asks the rows, not the plan,
 * whether a twin names its NarHash — the lock is the guarantee, the re-check is
 * what keeps a writer added outside it from costing bytes.
 */

import type { ObjectStore } from "@odu/objects";
import type { BucketRow, CacheRepo, ObjectRow, PinRow } from "./db";
import { objectKey } from "./staging";

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

/** What one evicted row costs: the compressed object when the row knows its
 *  size, the NAR's otherwise (a row from before objects were kept). */
const sizeOf = (row: ObjectRow): number => row.fileSize ?? row.narSize;

/** Every path reachable from `roots` by following `references`, including the
 *  roots themselves. Iterative, because a store closure is a graph and a
 *  recursive walk over somebody's million-path closure is a stack overflow. */
function closureOf(roots: Iterable<string>, byPath: Map<string, ObjectRow>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const reference of byPath.get(path)?.references ?? []) queue.push(reference);
  }
  return seen;
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

    const evict = objects.filter(
      (row) =>
        expired(row) &&
        !protectedByReference.has(row.storePath) &&
        !protectedByPin.has(row.storePath),
    );
    return {
      bucket: bucket.name,
      evict,
      remaining: objects.length - evict.length,
      bytes: evict.reduce((sum, row) => sum + sizeOf(row), 0),
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
  /** Bytes reclaimed, by the kept object's own size. */
  bytes: number;
  /** Object keys the store held that no row named — a crash between keeping
   *  an object and recording it. Found with `list`, deleted with `delete`. */
  orphans: number;
  /** What left, for the purge announcement. */
  removed: readonly GcRemoval[];
}

export interface GcReport {
  buckets: GcBucketReport[];
  evicted: number;
  kept: number;
  bytes: number;
  orphans: number;
}

/**
 * Do the plan. An object leaves with its row; the bytes are the object store's,
 * deleted by key, so nothing on this machine's Nix store is touched (the
 * server does not have one).
 *
 * Then the ORPHAN SWEEP, with the same two members: every key under the
 * bucket's prefix that no surviving row names is a put whose record never
 * landed, and the write lock is held, so nothing in flight owns one. The boot
 * sweep does this once at startup; a collection is the other moment a daemon
 * knows it is safe, and without it a crashed push's bytes waited for a
 * restart.
 */
export async function runGc(
  repo: CacheRepo,
  plan: readonly GcBucketPlan[],
  /** The store each bucket's objects live in. */
  objectsOf: (bucket: string) => ObjectStore,
): Promise<GcReport> {
  const perBucket = new Map<string, GcBucketReport>(
    plan.map((entry) => [
      entry.bucket,
      { bucket: entry.bucket, evicted: 0, kept: 0, bytes: 0, orphans: 0, removed: [] },
    ]),
  );
  for (const entry of plan) {
    const report = perBucket.get(entry.bucket) as GcBucketReport;
    const removed: GcRemoval[] = [];
    const objects = objectsOf(entry.bucket);
    for (const row of entry.evict) {
      repo.deleteObject(entry.bucket, row.storePath);
      // TWINS: two rows can carry the same NarHash (different store paths, one
      // object). The bytes go only when no row in the bucket names them NOW —
      // asked of the database right before the delete (an indexed lookup), not
      // of the plan's snapshot, so a row that appeared mid-run keeps its object.
      const twin = repo.objectsByNarHash(entry.bucket, row.narHash).length > 0;
      const key = objectKey(entry.bucket, row.narHash, row.compression);
      if (!twin) await objects.delete(key);
      removed.push({
        storePath: row.storePath,
        hash: row.hash,
        narFile: twin ? null : (key.split("/").at(-1) as string),
      });
      report.evicted += 1;
      if (twin) report.kept += 1;
      else report.bytes += sizeOf(row);
    }
    report.removed = removed;

    // THE ORPHANS, from the store itself: `list` is the only way to learn of a
    // key no row remembers, and the rows are re-read here rather than taken
    // from the plan so a path recorded during this run keeps its object.
    const named = new Set(
      repo
        .objects(entry.bucket)
        .map((row) => objectKey(entry.bucket, row.narHash, row.compression)),
    );
    for (const object of await objects.list(entry.bucket)) {
      if (named.has(object.key)) continue;
      await objects.delete(object.key);
      report.orphans += 1;
      report.bytes += object.size;
    }
  }
  const buckets = [...perBucket.values()];
  return {
    buckets,
    evicted: buckets.reduce((sum, bucket) => sum + bucket.evicted, 0),
    kept: buckets.reduce((sum, bucket) => sum + bucket.kept, 0),
    bytes: buckets.reduce((sum, bucket) => sum + bucket.bytes, 0),
    orphans: buckets.reduce((sum, bucket) => sum + bucket.orphans, 0),
  };
}
