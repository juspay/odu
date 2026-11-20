import { readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { createExclusive, writeAtomic } from "./atomic";
import { RUN_FILES } from "./paths";
import { type Owner, OwnerSchema } from "./schema";

/** How long an owner's heartbeat may go unrefreshed before a successor may
 *  consider it evidence of death. */
export const OWNERSHIP_GRACE_MS = 90_000;

/** How often a live owner should refresh its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Proof of ownership, held by the writer for the life of the run. Opaque on
 *  purpose: a caller passes it back, it never constructs one. */
export interface OwnershipToken {
  readonly runId: string;
  readonly dir: string;
  readonly epoch: number;
}

/** Why a claim was refused — the shapes a caller must tell apart. `held` is a
 *  live owner (do not touch the run); `raced` is another claimant winning the
 *  same epoch (retry or give up, but the run has an owner either way). */
export type ClaimRefusal =
  | { kind: "held"; owner: Owner; reason: string }
  | { kind: "raced"; reason: string };

export type ClaimResult =
  | { ok: true; token: OwnershipToken; owner: Owner }
  | { ok: false; refusal: ClaimRefusal };

const decodeOwner = Schema.decodeUnknownResult(OwnerSchema);
const encodeOwner = (owner: Owner): string =>
  `${JSON.stringify(owner, null, 2)}\n`;

/** Is `pid` a live process on THIS machine? Signal 0 performs the permission
 *  and existence checks without delivering anything. `EPERM` means the process
 *  exists and belongs to somebody else — alive, for our purposes. */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function claimPath(dir: string, epoch: number): string {
  return join(dir, `owner.${epoch}.claim`);
}

function readOwnerFile(path: string): Owner | null {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const decoded = decodeOwner(parsed);
  return Result.isSuccess(decoded) ? decoded.success : null;
}

/**
 * The run's current owner, or `null` when nobody has ever claimed it.
 */
export function currentOwner(dir: string): Owner | null {
  const published = readOwnerFile(join(dir, RUN_FILES.owner));
  let best = published;
  for (const entry of listClaims(dir)) {
    if (best !== null && entry.epoch <= best.epoch) continue;
    const claimed = readOwnerFile(claimPath(dir, entry.epoch));
    if (claimed !== null) best = claimed;
  }
  return best;
}

function highestClaimedEpoch(dir: string): number {
  let highest = 0;
  for (const entry of listClaims(dir)) {
    highest = Math.max(highest, entry.epoch);
  }
  return highest;
}

function listClaims(dir: string): { epoch: number }[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { epoch: number }[] = [];
  for (const entry of entries) {
    const match = /^owner\.(\d+)\.claim$/.exec(entry);
    if (match === null) continue;
    const epoch = Number(match[1]);
    if (Number.isSafeInteger(epoch) && epoch > 0) out.push({ epoch });
  }
  return out;
}

export function ownershipProvablyLost(
  incumbent: Owner,
  now: number,
  host: string = hostname(),
  isAlive: (pid: number) => boolean = pidAlive,
): { lost: true } | { lost: false; reason: string } {
  if (now - incumbent.heartbeatAt < OWNERSHIP_GRACE_MS) {
    const ago = Math.max(0, Math.round((now - incumbent.heartbeatAt) / 1000));
    return {
      lost: false,
      reason: `its owner (pid ${incumbent.pid} on ${incumbent.host}) was alive ${ago}s ago`,
    };
  }
  if (incumbent.host === host && isAlive(incumbent.pid)) {
    return {
      lost: false,
      reason: `its owner (pid ${incumbent.pid}) is still running on this host, despite a stale heartbeat`,
    };
  }
  return { lost: true };
}

export function beingWritten(owner: Owner | null, now: number): boolean {
  return owner !== null && now - owner.heartbeatAt < OWNERSHIP_GRACE_MS;
}

export interface ClaimInput {
  runId: string;
  dir: string;
  /** Where this owner will serve its live surface, or null if it serves none. */
  endpoint: string | null;
  now?: number;
  pid?: number;
  host?: string;
  isAlive?: (pid: number) => boolean;
}

/**
 * Claim write-ownership of a run — for a fresh registration, or as a successor
 * to an owner that is provably gone.
 */
export function claimOwnership(input: ClaimInput): ClaimResult {
  const now = input.now ?? Date.now();
  const pid = input.pid ?? process.pid;
  const host = input.host ?? hostname();
  const isAlive = input.isAlive ?? pidAlive;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const incumbent = currentOwner(input.dir);
    if (incumbent !== null) {
      const verdict = ownershipProvablyLost(incumbent, now, host, isAlive);
      if (!verdict.lost) {
        return {
          ok: false,
          refusal: { kind: "held", owner: incumbent, reason: verdict.reason },
        };
      }
    }
    const epoch =
      Math.max(incumbent?.epoch ?? 0, highestClaimedEpoch(input.dir)) + 1;
    const owner: Owner = {
      epoch,
      pid,
      host,
      claimedAt: now,
      heartbeatAt: now,
      endpoint: input.endpoint,
    };
    if (!createExclusive(claimPath(input.dir, epoch), encodeOwner(owner))) {
      continue;
    }
    writeAtomic(join(input.dir, RUN_FILES.owner), encodeOwner(owner));
    return {
      ok: true,
      token: { runId: input.runId, dir: input.dir, epoch },
      owner,
    };
  }
  return {
    ok: false,
    refusal: {
      kind: "raced",
      reason: "another process kept winning the ownership epoch",
    },
  };
}

/**
 * Does this token still hold the fence?
 *
 * A read failure answers `false`: a writer that cannot confirm it still owns
 * the run must not write to it.
 */
export function stillOwner(token: OwnershipToken): boolean {
  const owner = readOwnerFile(join(token.dir, RUN_FILES.owner));
  return owner !== null && owner.epoch === token.epoch;
}

/** Refresh the heartbeat, keeping the epoch. A no-op (returning false) once
 *  this token has been fenced. */
export function heartbeat(
  token: OwnershipToken,
  now: number = Date.now(),
): boolean {
  const owner = currentOwner(token.dir);
  if (owner === null || owner.epoch !== token.epoch) return false;
  writeAtomic(
    join(token.dir, RUN_FILES.owner),
    encodeOwner({ ...owner, heartbeatAt: now }),
  );
  return true;
}

/** Give the run up cleanly: keep the epoch (so nothing else may claim it
 *  without a fresh takeover) and drop the endpoint, which is what tells a
 *  reader the live surface is gone but the record is not. */
export function releaseOwnership(
  token: OwnershipToken,
  now: number = Date.now(),
): void {
  const owner = currentOwner(token.dir);
  if (owner === null || owner.epoch !== token.epoch) return;
  writeAtomic(
    join(token.dir, RUN_FILES.owner),
    encodeOwner({ ...owner, endpoint: null, heartbeatAt: now }),
  );
}

/**
 * Is this run's owner still, as far as anyone here can tell, alive?
 *
 * `null` means there is no owner record at all — a run that never claimed one,
 * or one whose owner released cleanly. That is a THIRD answer, not a `false`:
 * "nobody is writing this" and "the writer is provably gone" are different
 * facts, and a face that collapses them tells an operator a finished run died.
 */
export function ownerProvablyAlive(dir: string, now: number): boolean | null {
  return ownerAlive(currentOwner(dir), now);
}

/** The same answer, for a caller that already holds the owner record. */
export function ownerAlive(owner: Owner | null, now: number): boolean | null {
  if (owner === null) return null;
  return !ownershipProvablyLost(owner, now).lost;
}
