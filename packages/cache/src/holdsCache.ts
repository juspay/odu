import type { BucketRow, CacheRepo } from "./db";
import { type Hold, holdsOf } from "./gc";
import { storePathParts } from "./surface";

export interface BucketHolds {
  holds: Map<string, Hold>;
  byName: Map<string, string[]>;
}

export interface HoldsCache {
  of(bucket: BucketRow): BucketHolds;
  forget(bucket: string): void;
}

export function holdsCache(repo: CacheRepo): HoldsCache {
  const kept = new Map<string, BucketHolds & { revision: number }>();
  return {
    of(bucket) {
      const revision = repo.revision(bucket.name);
      const held = kept.get(bucket.name);
      if (held !== undefined && held.revision === revision) return held;
      const objects = repo.objects(bucket.name);
      const holds = holdsOf(bucket, objects, repo.pins(bucket.name));
      const byName = new Map<string, string[]>();
      for (const row of objects) {
        const name = storePathParts(row.storePath).name;
        const versions = byName.get(name);
        if (versions === undefined) byName.set(name, [row.storePath]);
        else versions.push(row.storePath);
      }
      const fresh = { revision, holds, byName };
      kept.set(bucket.name, fresh);
      return fresh;
    },
    forget(bucket) {
      kept.delete(bucket);
    },
  };
}
