import type { CacheRepo, MigrationRow } from "./db";
import type { GcRemoval } from "./gc";
import { narFileName } from "./narinfo";
import type { ObjectStore } from "@odu/objects";
import type { Slots } from "./slots";
import { purgeKeys } from "./purge";
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

type KeyKind = "nar" | "narinfo" | "info";

interface MigrationKey {
  key: string;
  kind: KeyKind;
}

const PROGRESS_EVERY = 25;

const headersFor = (kind: KeyKind): { contentType: string; cacheControl: string } =>
  kind === "nar"
    ? { contentType: NAR_CONTENT_TYPE, cacheControl: NAR_CACHE_CONTROL }
    : {
        contentType: kind === "narinfo" ? NARINFO_CONTENT_TYPE : CACHE_INFO_CONTENT_TYPE,
        cacheControl: INFO_CACHE_CONTROL,
      };

export function migrationKeys(repo: CacheRepo, bucket: string): MigrationKey[] {
  const keys: MigrationKey[] = [{ key: cacheInfoKey(bucket), kind: "info" }];
  const nars = new Set<string>();
  for (const row of repo.objects(bucket)) {
    const nar = objectKey(bucket, row.narHash, row.compression);
    if (!nars.has(nar)) {
      nars.add(nar);
      keys.push({ key: nar, kind: "nar" });
    }
    keys.push({ key: narinfoKey(bucket, row.hash), kind: "narinfo" });
  }
  return keys;
}

function removalsOf(repo: CacheRepo, bucket: string): GcRemoval[] {
  return repo.objects(bucket).map((row) => ({
    storePath: row.storePath,
    hash: row.hash,
    narFile: narFileName(row.narHash, row.compression),
  }));
}

export interface MigrationDeps {
  repo: CacheRepo;
  storeNamed: (name: string) => ObjectStore;
  withWriteLock: <T>(work: () => Promise<T>) => Promise<T>;
  slots: Slots;
  now: () => number;
  notify: () => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
  purged?: (input: {
    bucket: string;
    store: string;
    reason: "migrate" | "repush";
    removals: readonly GcRemoval[];
    cacheInfo?: boolean;
  }) => void;
  stopping: () => boolean;
}

type Copied = "copied" | "same" | "gone";

async function copyOne(
  from: ObjectStore,
  to: ObjectStore,
  entry: MigrationKey,
): Promise<{ outcome: Copied; bytes: number }> {
  const size = await from.head(entry.key);
  if (size === null) return { outcome: "gone", bytes: 0 };
  const already = await to.head(entry.key);
  if (already === size) return { outcome: "same", bytes: size };
  if (already !== null) await to.delete(entry.key);
  const object = await from.get(entry.key);
  if (object === null) return { outcome: "gone", bytes: 0 };
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
      for (let round = 0; round < 10; round += 1) {
        if (deps.stopping()) return;
        if ((await pass()) === 0) break;
      }
      if (deps.stopping()) return;
      save({ state: "flipping" });
    }

    if (state.state === "flipping") {
      await deps.withWriteLock(async () => {
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
      const removals = removalsOf(repo, state.bucket);
      await purgeKeys({
        objects: from,
        keys: migrationKeys(repo, state.bucket).map((entry) => entry.key),
        slots: deps.slots,
        stop: deps.stopping,
        failed: () => {},
      });
      if (deps.stopping()) return;
      deps.purged?.({
        bucket: state.bucket,
        store: state.fromStore,
        reason: "migrate",
        removals,
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
    log?.("cache.bucket.migrate.failed", {
      bucket: state.bucket,
      to: state.toStore,
      state: state.state,
      reason: String((err as Error).message ?? err),
    });
  }
}
