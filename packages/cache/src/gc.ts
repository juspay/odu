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
 * **And nothing can land in between.** `planGc` and the delete are separate
 * awaits, so a pin or a re-push issued while a collection is in flight would
 * find its path already gone — the "put the root back" branch would do nothing,
 * because the bytes are deleted. The cache therefore holds ONE async mutex over
 * `record`, `pin` and `gc`: a collection plans, releases and deletes with no
 * writer able to interleave, and a pin that arrived first is already in the
 * plan. That is why there is no re-plan here — there is nothing that could have
 * changed.
 */

import type { BucketRow, CacheRepo, ObjectRow, PinRow } from "./db";

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
  /** Kept for the report's shape: the object store deletes unconditionally. */
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
 * Do the plan. An object leaves with its row; the bytes are the object store's,
 * deleted by key, so nothing on this machine's Nix store is touched (the
 * server does not have one).
 */
export async function runGc(
  repo: CacheRepo,
  plan: readonly GcBucketPlan[],
  objects: { delete(key: string): Promise<void> },
): Promise<GcReport> {
  const planned = plan.flatMap((entry) =>
    entry.evict.map((row) => ({ ...row, bucket: entry.bucket })),
  );
  const perBucket = new Map<string, GcBucketReport>(
    plan.map((entry) => [entry.bucket, { bucket: entry.bucket, evicted: 0, kept: 0, bytes: 0 }]),
  );
  for (const row of planned) {
    repo.deleteObject(row.bucket, row.storePath);
    await objects.delete(`${row.bucket}/nar/${row.narHash.replace(/^sha256:/, "")}.nar.zst`);
    const report = perBucket.get(row.bucket);
    if (report !== undefined) {
      report.evicted += 1;
      report.bytes += row.fileSize ?? row.narSize;
    }
  }
  const buckets = [...perBucket.values()];
  return {
    buckets,
    evicted: buckets.reduce((sum, bucket) => sum + bucket.evicted, 0),
    kept: 0,
    bytes: buckets.reduce((sum, bucket) => sum + bucket.bytes, 0),
  };
}
