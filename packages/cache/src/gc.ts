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
 * Do the plan. A store that refuses to delete is not an error: the path is
 * somebody else's too, and the answer is `kept` — the row still goes, because
 * this bucket no longer retains it.
 */
export async function runGc(
  store: BlobStore,
  repo: CacheRepo,
  plan: readonly GcBucketPlan[],
): Promise<GcReport> {
  const buckets: GcBucketReport[] = [];
  for (const entry of plan) {
    let evicted = 0;
    let kept = 0;
    let bytes = 0;
    for (const row of entry.evict) {
      await store.release(entry.bucket, row.storePath);
      const outcome = await store.delete(row.storePath);
      if (outcome === "deleted") {
        evicted += 1;
        bytes += row.narSize;
      } else {
        kept += 1;
      }
      repo.deleteObject(entry.bucket, row.storePath);
    }
    buckets.push({ bucket: entry.bucket, evicted, kept, bytes });
  }
  return {
    buckets,
    evicted: buckets.reduce((sum, bucket) => sum + bucket.evicted, 0),
    kept: buckets.reduce((sum, bucket) => sum + bucket.kept, 0),
    bytes: buckets.reduce((sum, bucket) => sum + bucket.bytes, 0),
  };
}
