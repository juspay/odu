/**
 * Checkout-local venue lease record (`.ci/odu-lease.json`).
 *
 * Agent-held leases (odu lease / MCP lease) persist across discrete tool
 * calls via a detached holder process. The record maps platform → holder
 * identity so `odu run` can consume a held host without re-claiming, and so
 * wait-in-line state is observable (not stderr-only).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { HolderInfo } from "./lease";

export const LEASE_RECORD_PATH = ".ci/odu-lease.json";

export type LeaseRecordState = "waiting" | "held";

export interface PlatformLeaseRecord {
  host: string | null;
  holderPid: number;
  since: number;
  state: LeaseRecordState;
  /** When waiting: who holds the box (if known). */
  waitingBehind: HolderInfo | null;
  /** Optional run label the holder advertised. */
  run: string | null;
}

export type LeaseRecordFile = Record<string, PlatformLeaseRecord>;

export function leaseRecordPath(repoRoot: string): string {
  return join(repoRoot, LEASE_RECORD_PATH);
}

/** True if `pid` still exists (signal 0). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readLeaseRecord(repoRoot: string): LeaseRecordFile {
  const path = leaseRecordPath(repoRoot);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {};
    }
    return raw as LeaseRecordFile;
  } catch {
    return {};
  }
}

export function writeLeaseRecord(
  repoRoot: string,
  record: LeaseRecordFile,
): void {
  const path = leaseRecordPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/**
 * Drop entries whose holderPid is dead. Returns the cleaned record and
 * whether anything changed.
 */
export function reconcileLeaseRecord(repoRoot: string): {
  record: LeaseRecordFile;
  changed: boolean;
} {
  const prev = readLeaseRecord(repoRoot);
  const next: LeaseRecordFile = {};
  let changed = false;
  for (const [platform, entry] of Object.entries(prev)) {
    if (pidAlive(entry.holderPid)) {
      next[platform] = entry;
    } else {
      changed = true;
    }
  }
  if (changed) {
    if (Object.keys(next).length === 0) {
      removeLeaseRecordFile(repoRoot);
    } else {
      writeLeaseRecord(repoRoot, next);
    }
  }
  return { record: next, changed };
}

export function removeLeaseRecordFile(repoRoot: string): void {
  const path = leaseRecordPath(repoRoot);
  try {
    unlinkSync(path);
  } catch {
    /* absent */
  }
}

export function upsertPlatformLease(
  repoRoot: string,
  platform: string,
  entry: PlatformLeaseRecord,
): void {
  const { record } = reconcileLeaseRecord(repoRoot);
  record[platform] = entry;
  writeLeaseRecord(repoRoot, record);
}

export function removePlatformLease(
  repoRoot: string,
  platform: string,
): void {
  const { record } = reconcileLeaseRecord(repoRoot);
  if (record[platform] === undefined) return;
  delete record[platform];
  if (Object.keys(record).length === 0) {
    removeLeaseRecordFile(repoRoot);
  } else {
    writeLeaseRecord(repoRoot, record);
  }
}

/** Live held host for a platform, or null if none / stale / waiting. */
export function heldHostForPlatform(
  repoRoot: string,
  platform: string,
): string | null {
  const { record } = reconcileLeaseRecord(repoRoot);
  const e = record[platform];
  if (e === undefined || e.state !== "held" || e.host === null) return null;
  if (!pidAlive(e.holderPid)) return null;
  return e.host;
}

/** Platforms currently held by a live agent holder (state held). */
export function liveHeldPlatforms(
  repoRoot: string,
): Record<string, string> {
  const { record } = reconcileLeaseRecord(repoRoot);
  const out: Record<string, string> = {};
  for (const [platform, e] of Object.entries(record)) {
    if (e.state === "held" && e.host !== null && pidAlive(e.holderPid)) {
      out[platform] = e.host;
    }
  }
  return out;
}
