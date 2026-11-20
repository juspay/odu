import type { ObjectStore } from "@odu/objects";
import type { BucketRow, CacheRepo, ObjectRow, PinRow } from "./db";
import type { CacheKeptBy } from "./surface";
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
  bytes: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const GC_PREVIEW_PATHS = 50;

const sizeOf = (row: ObjectRow): number => row.fileSize ?? row.narSize;

export function closureOf(roots: Iterable<string>, byPath: Map<string, ObjectRow>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const reference of byPath.get(path)?.references ?? []) queue.push(referenced(reference));
  }
  return seen;
}

const referenced = (reference: string): string =>
  reference.startsWith("/nix/store/") ? reference : `/nix/store/${reference}`;

export interface Hold {
  readonly pins: readonly string[];
  readonly until: number;
  readonly via: string | null;
}

const NO_PINS: readonly string[] = [];

export function holdsOf(
  bucket: Pick<BucketRow, "retentionDays">,
  objects: readonly ObjectRow[],
  pins: readonly PinRow[],
): Map<string, Hold> {
  const keep = bucket.retentionDays * DAY_MS;
  const byPath = new Map(objects.map((row) => [row.storePath, row]));

  const pinned = new Map<string, string[]>();
  for (const pin of pins) {
    for (const path of closureOf(pin.rootPaths, byPath)) {
      const names = pinned.get(path);
      if (names === undefined) pinned.set(path, [pin.name]);
      else names.push(pin.name);
    }
  }

  const holds = new Map<string, Hold>();
  const latestFirst = [...objects].sort(
    (a, b) =>
      b.lastWanted - a.lastWanted ||
      (a.storePath < b.storePath ? -1 : a.storePath > b.storePath ? 1 : 0),
  );
  for (const root of latestFirst) {
    if (holds.has(root.storePath)) continue;
    const until = root.lastWanted + keep;
    const queue = [root.storePath];
    while (queue.length > 0) {
      const path = queue.pop() as string;
      const row = byPath.get(path);
      if (row === undefined || holds.has(path)) continue;
      holds.set(path, {
        pins: pinned.get(path) ?? NO_PINS,
        until,
        via: row.lastWanted === root.lastWanted ? null : root.storePath,
      });
      for (const reference of row.references) queue.push(referenced(reference));
    }
  }
  return holds;
}

export function released(hold: Hold, now: number): boolean {
  return hold.pins.length === 0 && now > hold.until;
}

export function keptBy(hold: Hold, now: number): CacheKeptBy {
  const kind =
    hold.pins.length > 0
      ? "pin"
      : now > hold.until
        ? "nothing"
        : hold.via === null
          ? "retention"
          : "reference";
  return { kind, pins: hold.pins, via: hold.via, until: hold.until };
}

export function longestHeld(holds: Iterable<Hold>): Hold | null {
  let best: Hold | null = null;
  for (const hold of holds) {
    if (best === null) {
      best = hold;
      continue;
    }
    const pinned = hold.pins.length > 0;
    if (pinned !== best.pins.length > 0) {
      if (pinned) best = hold;
      continue;
    }
    if (hold.until > best.until) best = hold;
  }
  return best;
}

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
    const pins = input.pins.filter((pin) => pin.bucket === bucket.name);
    const holds = holdsOf(bucket, objects, pins);
    const doomed = (row: ObjectRow): boolean =>
      released(holds.get(row.storePath) as Hold, input.now);
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

export interface GcBucketPreview {
  bucket: string;
  evicted: number;
  bytes: number;
  remaining: number;
  paths: readonly { storePath: string; bytes: number; lastWanted: number }[];
}

export interface GcPreview {
  buckets: readonly GcBucketPreview[];
  evicted: number;
  bytes: number;
}

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

export interface GcRemoval {
  storePath: string;
  hash: string;
  narFile: string | null;
}

export interface GcBucketReport {
  bucket: string;
  evicted: number;
  kept: number;
  bytes: number;
  orphans: number;
}

export interface GcReport {
  buckets: GcBucketReport[];
  evicted: number;
  kept: number;
  bytes: number;
  orphans: number;
  stopped: string | null;
}

export interface GcCollection {
  report: GcReport;
  removed: ReadonlyMap<string, readonly GcRemoval[]>;
}

/**
 * A batch is two `deleteMany` calls — the narinfos, then the NARs — so on S3
 * it is two requests, inside the 1000-key ceiling of each.
 */
const GC_BATCH_ROWS = 500;

export interface GcRunOptions {
  now?: () => number;
  withLock?: <T>(work: () => Promise<T>) => Promise<T>;
  batch?: number;
}

interface GcBatch {
  rows: ObjectRow[];
  narinfos: string[];
  nars: string[];
  removals: GcRemoval[];
  kept: number;
  bytes: number;
}

function decideBatch(
  repo: CacheRepo,
  bucket: string,
  batch: readonly ObjectRow[],
  doomed: ReadonlySet<string>,
): GcBatch {
  const rows = batch.filter((row) => doomed.has(row.storePath));
  const going = new Set(rows.map((row) => row.storePath));
  const lastRowPerNarHash = new Map(rows.map((row) => [row.narHash, row.storePath]));
  const decided: GcBatch = { rows, narinfos: [], nars: [], removals: [], kept: 0, bytes: 0 };
  for (const row of rows) {
    const elsewhere = repo
      .objectsByNarHash(bucket, row.narHash)
      .some((other) => !going.has(other.storePath));
    const takesBytes = !elsewhere && lastRowPerNarHash.get(row.narHash) === row.storePath;
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

async function deleteBatchObjects(objects: ObjectStore, decided: GcBatch): Promise<void> {
  await objects.deleteMany(decided.narinfos);
  await objects.deleteMany(decided.nars);
}

function dropBatchRows(repo: CacheRepo, bucket: string, decided: GcBatch): void {
  for (const row of decided.rows) repo.deleteObject(bucket, row.storePath);
}

export async function runGc(
  repo: CacheRepo,
  plan: readonly GcBucketPlan[],
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
        await deleteBatchObjects(objects, decided);
      } catch (err) {
        stopped = stoppedBy(entry.bucket, err);
        break;
      }
      await withLock(async () => {
        dropBatchRows(repo, entry.bucket, decided);
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

function keysBucketOwns(repo: CacheRepo, bucket: string): ReadonlySet<string> {
  return new Set([
    ...repo.objects(bucket).flatMap((row) => [
      objectKey(bucket, row.narHash, row.compression),
      narinfoKey(bucket, row.hash),
    ]),
    cacheInfoKey(bucket),
  ]);
}

export async function sweepOrphans(
  repo: CacheRepo,
  bucket: string,
  objects: ObjectStore,
): Promise<number> {
  const named = keysBucketOwns(repo, bucket);
  let swept = 0;
  for (const object of await objects.list(bucket)) {
    if (named.has(object.key)) continue;
    await objects.delete(object.key);
    swept += 1;
  }
  return swept;
}
