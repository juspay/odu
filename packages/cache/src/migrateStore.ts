/**
 * A BUCKET MOVES BETWEEN STORES — the copier behind `bucket.migrate`
 * (PLAN 2.8).
 *
 * The shape of the move, and why each part is where it is:
 *
 * - **It copies before it switches.** Every object of the bucket — its NARs,
 *   the narinfo beside each one, and its `nix-cache-info` — is written to the
 *   new store while the bucket goes on being served from the OLD one. A move
 *   that flipped first would be a cache that 404s everything until the copy
 *   caught up, which on kolu's bucket is twenty minutes of a broken
 *   substituter. It is the transition the object migration already uses
 *   (`cache.test.ts`'s "serves through the old store while the migration is
 *   still writing").
 * - **It is resumable because it is idempotent.** An object already in the new
 *   store with the same length is skipped on one HEAD, and the move's own row
 *   (`bucket_migration`) survives a restart, so a daemon that died half way
 *   through resumes rather than starting again or, worse, leaving half a
 *   bucket in each store with nobody tracking it.
 * - **The flip is under the write lock**, with one last delta pass inside it:
 *   a push that landed in the old store after the main pass walked past its
 *   key would otherwise be a path the new store never got. The lock is what a
 *   push takes to keep and record, so nothing can land between the delta pass
 *   and the flip.
 * - **The old objects go last, and are purged.** Until the flip they are what
 *   serves; after it they are a second copy of everything, and an edge that
 *   cached their URLs would hand out addresses that are about to 404.
 *
 * Two objects are in flight at a time, the throttle the row's other long
 * background work uses.
 */

import type { CacheRepo, MigrationRow } from "./db";
import type { GcRemoval } from "./gc";
import { narFileName } from "./narinfo";
import type { ObjectStore } from "@odu/objects";
import type { Slots } from "./slots";
import {
  cacheInfoKey,
  CACHE_INFO_CONTENT_TYPE,
  INFO_CACHE_CONTROL,
  NAR_CACHE_CONTROL,
  NAR_CONTENT_TYPE,
  narinfoKey,
  NARINFO_CONTENT_TYPE,
  objectKey,
} from "./staging";

/** What a key holds, which decides the headers it is written with. */
type KeyKind = "nar" | "narinfo" | "info";

interface MigrationKey {
  key: string;
  kind: KeyKind;
}

/** How often the move's row is written back and the board told. One write per
 *  object would be a database write and a broadcast per HEAD. */
const PROGRESS_EVERY = 25;

const headersFor = (kind: KeyKind): { contentType: string; cacheControl: string } =>
  kind === "nar"
    ? { contentType: NAR_CONTENT_TYPE, cacheControl: NAR_CACHE_CONTROL }
    : {
        contentType: kind === "narinfo" ? NARINFO_CONTENT_TYPE : CACHE_INFO_CONTENT_TYPE,
        cacheControl: INFO_CACHE_CONTROL,
      };

/**
 * EVERY KEY A BUCKET OWNS, read from the rows rather than listed from the
 * store: a `list` would also hand back whatever a dead push left behind, and
 * a move is not the moment to decide what is an orphan — the boot sweep and
 * the collector own that question.
 */
export function migrationKeys(repo: CacheRepo, bucket: string): MigrationKey[] {
  const keys: MigrationKey[] = [{ key: cacheInfoKey(bucket), kind: "info" }];
  const nars = new Set<string>();
  for (const row of repo.objects(bucket)) {
    // TWINS SHARE A NAR: two store paths with one NarHash name one object, and
    // copying it twice would be the same bytes over the wire twice.
    const nar = objectKey(bucket, row.narHash, row.compression);
    if (!nars.has(nar)) {
      nars.add(nar);
      keys.push({ key: nar, kind: "nar" });
    }
    keys.push({ key: narinfoKey(bucket, row.hash), kind: "narinfo" });
  }
  return keys;
}

/** What the old store should give up once the move is done, in the shape the
 *  purge announcement takes. */
function removalsOf(repo: CacheRepo, bucket: string): GcRemoval[] {
  return repo.objects(bucket).map((row) => ({
    storePath: row.storePath,
    hash: row.hash,
    narFile: narFileName(row.narHash, row.compression),
  }));
}

export interface MigrationDeps {
  repo: CacheRepo;
  /** A declared store by name. The caller has already proved both names. */
  storeNamed: (name: string) => ObjectStore;
  /** The cache's one write lock — what a push takes to keep and record. */
  withWriteLock: <T>(work: () => Promise<T>) => Promise<T>;
  /** Two copies at a time, the row's own throttle. */
  slots: Slots;
  now: () => number;
  /** Something a subscriber would see moved. */
  notify: () => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** What the old store gave up, so the row can purge the addresses it served
   *  them at. */
  purged?: (input: {
    bucket: string;
    store: string;
    reason: "migrate" | "repush";
    removals: readonly GcRemoval[];
    cacheInfo?: boolean;
  }) => void;
  /** True once the row is closing: every loop here checks it, so a move does
   *  not hold a database that is about to go. */
  stopping: () => boolean;
}

/** What one key's copy came to. */
type Copied = "copied" | "same" | "gone";

async function copyOne(
  from: ObjectStore,
  to: ObjectStore,
  entry: MigrationKey,
): Promise<{ outcome: Copied; bytes: number }> {
  const size = await from.head(entry.key);
  // AN OBJECT THAT IS NOT THERE is not a failure: a collection may have taken
  // it while the move was walking, and the row it belonged to went with it.
  if (size === null) return { outcome: "gone", bytes: 0 };
  const already = await to.head(entry.key);
  if (already === size) return { outcome: "same", bytes: size };
  // A HALF-WRITTEN OBJECT from a move that died mid-put: the key is taken, so
  // the conditional write below would refuse it with `exists`. It goes.
  if (already !== null) await to.delete(entry.key);
  const object = await from.get(entry.key);
  if (object === null) return { outcome: "gone", bytes: 0 };
  // THE OLD STORE'S OWN FACTS, PROMISED TO THE NEW ONE: the write is refused
  // if the bytes that arrive are not the bytes that left, so a truncated copy
  // can never become the object the bucket serves.
  const facts = await from.facts(entry.key).catch(() => null);
  const outcome = await to.put(
    entry.key,
    object.stream,
    facts ?? undefined,
    headersFor(entry.kind),
  );
  if (!outcome.ok && outcome.refusal.kind !== "exists") {
    throw new Error(`${entry.key} could not be copied: ${outcome.refusal.kind}`);
  }
  return { outcome: "copied", bytes: size };
}

/**
 * RUN A MOVE TO ITS END — from wherever its row says it is.
 *
 * Called with a row that is already persisted, by the verb that started it and
 * by the boot that found it unfinished. It never throws for a single object's
 * sake; a failure ends the pass, leaves the row where it is, and the next boot
 * resumes it.
 */
export async function runMigration(row: MigrationRow, deps: MigrationDeps): Promise<void> {
  const { repo, log } = deps;
  const from = deps.storeNamed(row.fromStore);
  const to = deps.storeNamed(row.toStore);
  let state = row;

  const save = (next: Partial<MigrationRow>): void => {
    state = { ...state, ...next };
    repo.putMigration(state);
    deps.notify();
  };

  /** One pass over every key the bucket owns. Answers how many it actually
   *  wrote, so the caller can run passes until one writes nothing. */
  async function pass(): Promise<number> {
    const keys = migrationKeys(repo, state.bucket);
    let copied = 0;
    let written = 0;
    let bytes = 0;
    let failure: unknown = null;
    await Promise.all(
      keys.map((entry) =>
        deps.slots
          .withSlot(async () => {
            if (deps.stopping() || failure !== null) return;
            const done = await copyOne(from, to, entry);
            copied += 1;
            bytes += done.bytes;
            if (done.outcome === "copied") written += 1;
            if (copied % PROGRESS_EVERY === 0) {
              save({ copied, total: keys.length, bytes });
              log?.("cache.bucket.migrate.progress", {
                bucket: state.bucket,
                to: state.toStore,
                copied,
                total: keys.length,
                bytes,
              });
            }
          })
          .catch((err: unknown) => {
            failure ??= err;
          }),
      ),
    );
    save({ copied, total: keys.length, bytes });
    if (failure !== null) throw failure;
    return written;
  }

  try {
    if (state.state === "copying") {
      // PASSES UNTIL ONE WRITES NOTHING: a push that landed while the previous
      // pass was running is a key the new store does not have yet. The last
      // delta is taken under the lock below, where nothing can land at all.
      for (let round = 0; round < 10; round += 1) {
        if (deps.stopping()) return;
        if ((await pass()) === 0) break;
      }
      if (deps.stopping()) return;
      save({ state: "flipping" });
    }

    if (state.state === "flipping") {
      await deps.withWriteLock(async () => {
        // THE DELTA AND THE FLIP, TOGETHER. A push takes this lock to keep its
        // object and record its row, so between the last key copied here and
        // the bucket naming its new store there is no moment a push can use.
        await pass();
        const bucket = repo.bucket(state.bucket);
        if (bucket === null) return;
        repo.putBucket({ ...bucket, store: state.toStore });
      });
      save({ state: "deleting" });
      log?.("cache.bucket.migrate.flipped", {
        bucket: state.bucket,
        from: state.fromStore,
        to: state.toStore,
        objects: state.copied,
        bytes: state.bytes,
      });
    }

    if (state.state === "deleting") {
      // THE OLD COPIES. The bucket is being served from the new store now, so
      // these are bytes nobody reads — and the addresses they were served at
      // are what the purge below invalidates.
      const removals = removalsOf(repo, state.bucket);
      for (const entry of migrationKeys(repo, state.bucket)) {
        if (deps.stopping()) return;
        await deps.slots.withSlot(() => from.delete(entry.key)).catch(() => {});
      }
      deps.purged?.({
        bucket: state.bucket,
        store: state.fromStore,
        reason: "migrate",
        removals,
        // `nix-cache-info` went with them: it is a key of the BUCKET rather
        // than of any path, so no removal names it.
        cacheInfo: true,
      });
      repo.deleteMigration(state.bucket);
      deps.notify();
      log?.("cache.bucket.migrate.done", {
        bucket: state.bucket,
        from: state.fromStore,
        to: state.toStore,
        objects: state.copied,
        bytes: state.bytes,
        ms: deps.now() - state.started,
      });
    }
  } catch (err) {
    // THE ROW STAYS WHERE IT IS: a move that failed is a move the next boot
    // picks up, and the bucket is still being served by whichever store its
    // own row names.
    log?.("cache.bucket.migrate.failed", {
      bucket: state.bucket,
      to: state.toStore,
      state: state.state,
      reason: String((err as Error).message ?? err),
    });
  }
}
