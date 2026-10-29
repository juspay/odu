/**
 * GARBAGE COLLECTION — retention, references and pins, and nothing else.
 *
 * The rule is one sentence and it is the whole answer to "why did my cache eat
 * my build": an object is expired when it has not been read within its bucket's
 * retention AND nothing the bucket still keeps references it AND no pin holds
 * it. Expired means "release its root, delete it from the store, forget the
 * row". Nothing is evicted because it is old; it is evicted because it is old
 * AND unreachable AND unpinned.
 *
 * **The decision is a pure function.** {@link planGc} takes rows and a clock
 * and answers what to evict; {@link runGc} does the store calls. That split is
 * what lets the suite state a fixture graph — a retained object, a reference to
 * it, a pin over a third — and assert the decision without a Nix store, and it
 * is why a "did GC keep the closure?" question has one place to look.
 *
 * **Two closures, because a pin is a promise.** A pin's closure is resolved at
 * pin time and stored, so a path that was in the closure then stays protected
 * even if the bucket has since forgotten the objects that referenced it. GC
 * ALSO walks the bucket's own references from those roots, so a path added to
 * the closure later is protected too. Either alone is a hole: the first misses
 * new members, the second misses members whose linking object was evicted.
 *
 * **Deletion is one call for the whole set.** `nix-store --delete` reports
 * "still alive" for a path that another path in the set references, so
 * deleting a closure one path at a time leaks every path in the middle of it
 * while reporting success. One call lets Nix order the set itself.
 *
 * **And the premises are re-checked.** A pin or a re-push can land between the
 * plan and the delete; a path that is no longer evictable gets its root back
 * rather than being deleted under a promise made a moment ago.
 */

import type { BucketRow, CacheRepo, ObjectRow, PinRow } from "./db";
import type { BlobStore } from "./store";

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
}

const DAY_MS = 24 * 60 * 60 * 1000;

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
      input.now - row.lastAccessed > bucket.retentionDays * DAY_MS;

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
    return { bucket: bucket.name, evict, remaining: objects.length - evict.length };
  });
}

export interface GcBucketReport {
  bucket: string;
  /** Rows dropped and paths deleted from the store. */
  evicted: number;
  /** Paths whose row was dropped but whose bytes the store refused to delete,
   *  because something else on this machine still roots them. */
  kept: number;
  /** Nar bytes reclaimed, by the narinfo's own `NarSize`. */
  bytes: number;
}

export interface GcReport {
  buckets: GcBucketReport[];
  evicted: number;
  kept: number;
  bytes: number;
}

/**
 * Do the plan.
 *
 * Release every root FIRST (the roots are what make `nix-store --delete` say
 * "still alive"), then delete the whole set in one call, then re-read the
 * world: a path that a pin or a re-push claimed in between gets its root back
 * and its row kept. A delete that throws re-roots everything it can before
 * failing — a root lost to an exception is a path the machine's own GC eats.
 */
export async function runGc(
  store: BlobStore,
  repo: CacheRepo,
  plan: readonly GcBucketPlan[],
  now: number = Date.now(),
): Promise<GcReport> {
  const planned = plan.flatMap((entry) => entry.evict.map((row) => ({ ...row, bucket: entry.bucket })));
  const bytesOf = new Map(planned.map((row) => [`${row.bucket}\u0000${row.storePath}`, row.narSize]));

  for (const row of planned) await store.release(row.bucket, row.storePath);

  let deleted: string[] = [];
  try {
    const outcome = await store.deleteMany(planned.map((row) => row.storePath));
    deleted = outcome.deleted;
  } catch (err) {
    for (const row of planned) {
      if (await store.has(row.storePath)) await store.retain(row.bucket, row.storePath);
    }
    throw err;
  }

  // THE PREMISES, RE-CHECKED. `planGc` ran before an await; a pin or a re-push
  // could have landed since.
  const fresh = new Set(
    planGc({
      buckets: repo.buckets(),
      objects: repo.objects(),
      pins: repo.pins(),
      now,
    }).flatMap((entry) => entry.evict.map((row) => row.storePath)),
  );

  const deletedSet = new Set(deleted);
  const perBucket = new Map<string, GcBucketReport>(
    plan.map((entry) => [entry.bucket, { bucket: entry.bucket, evicted: 0, kept: 0, bytes: 0 }]),
  );

  for (const row of planned) {
    const report = perBucket.get(row.bucket);
    if (report === undefined) continue;
    if (!fresh.has(row.storePath)) {
      // Something claimed it while the delete was in flight. Put the root back
      // and leave the row alone.
      if (await store.has(row.storePath)) await store.retain(row.bucket, row.storePath);
      continue;
    }
    repo.deleteObject(row.bucket, row.storePath);
    if (deletedSet.has(row.storePath)) {
      report.evicted += 1;
      report.bytes += bytesOf.get(`${row.bucket}\u0000${row.storePath}`) ?? 0;
    } else {
      report.kept += 1;
    }
  }

  const buckets = [...perBucket.values()];
  return {
    buckets,
    evicted: buckets.reduce((sum, bucket) => sum + bucket.evicted, 0),
    kept: buckets.reduce((sum, bucket) => sum + bucket.kept, 0),
    bytes: buckets.reduce((sum, bucket) => sum + bucket.bytes, 0),
  };
}
