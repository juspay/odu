/**
 * The ownership fence — how exactly one process at a time may write a run's
 * durable record, and what a successor has to prove before it takes over.
 *
 * THE RULE THIS FILE EXISTS FOR: *disappearance is not proof*. A coordinator's
 * pid vanishing, or its socket going away, is what a restart looks like from
 * the outside, and it is also what a crash looks like. Treating either as
 * "ownership is free" is how a run ends up with two writers appending to one
 * journal, or with a second process publishing a terminal verdict for a run
 * that is still going. Both are unrecoverable lies — the journal is the
 * history, and a fabricated `finalized` line cannot be un-said.
 *
 * So ownership is an EPOCH, not a pid:
 *
 *   - a writer claims an epoch and remembers it ({@link OwnershipToken});
 *   - every durable write re-reads the epoch on disk and refuses if it is no
 *     longer the one it holds — so a fenced writer stops at its next write
 *     rather than at some point it was supposed to notice it had been
 *     replaced;
 *   - a successor claims epoch+1, and claiming is `O_CREAT|O_EXCL` on a file
 *     named for the epoch, so exactly one claimant can win a given epoch even
 *     if a hundred try at once.
 *
 * Taking over additionally requires evidence that the incumbent is *gone*:
 * a heartbeat older than {@link OWNERSHIP_GRACE_MS}, and — when the incumbent
 * claimed on THIS host, which is the only case we can check — a pid that is no
 * longer alive. On another host we have only the heartbeat, and that limit is
 * stated here rather than hidden: a cross-host takeover waits out the grace,
 * and nothing else can be honestly asserted from this side.
 */

import { readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { createExclusive, writeAtomic } from "./atomic";
import { RUN_FILES } from "./paths";
import { type Owner, OwnerSchema } from "./schema";

/** How long an owner's heartbeat may go unrefreshed before a successor may
 *  consider it evidence of death. Generous on purpose: a coordinator does go
 *  quiet for tens of seconds (a cold `nix copy` of the runner closure is the
 *  routine case), and the cost of waiting is a slower recovery while the cost
 *  of being wrong is two writers. */
export const OWNERSHIP_GRACE_MS = 90_000;

/** How often a live owner should refresh its heartbeat. Comfortably inside the
 *  grace, so an owner that misses one beat to a busy event loop is not
 *  declared dead by the next thing that looks. */
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
function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The claim-file name for an epoch. One per epoch, ever. */
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
 *
 * Reads BOTH the published `owner.json` and the epoch claim files, and takes
 * whichever epoch is higher. The claim files are not bookkeeping: a claimant
 * that wins epoch N and then dies before publishing leaves `owner.json` at
 * N-1, and a reader that trusted only the published file would hand epoch N
 * out a second time — to a process that would then be fenced by the first
 * winner's file the moment it wrote anything. The highest claim IS the
 * ownership, and `owner.json` is the fast path to it.
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

/**
 * The highest epoch any claim file NAMES, decodable or not.
 *
 * Distinct from `currentOwner().epoch`, and the distinction is what stops a
 * run from wedging. A claimant killed part-way through writing `owner.3.claim`
 * leaves a file that does not decode, so `currentOwner` still reports epoch 2
 * — and a successor computing `2 + 1` then loses `O_CREAT|O_EXCL` to that
 * corpse on every one of its retries and gives up, reporting a race with a
 * process that does not exist. The FLOOR for the next epoch is therefore the
 * file names, which are readable whatever the contents are; the OWNER is still
 * decided by the records, which is `currentOwner`'s job.
 */
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

/** May `candidate` take over from `incumbent`? The one place the evidence rule
 *  is spelled, so a caller cannot accidentally accept a weaker proof.
 *
 *  Exported for the tests that matter most here — the ones that assert a LIVE
 *  owner is never displaced. */
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

/**
 * Is somebody WRITING this run right now?
 *
 * Deliberately not {@link ownershipProvablyLost}, and the difference is the
 * whole reason both exist. A SUCCESSOR asks "may I take over", and must not
 * displace a live writer, so it also checks whether the recorded pid is alive.
 * A JANITOR asks "is anything writing", holds no epoch, and must not ask about
 * the pid at all: a finished coordinator's record keeps naming a pid the OS is
 * free to hand to somebody else, so a janitor that checked it would refuse to
 * clean up a run that ended a month ago.
 *
 * "Somebody stamped this within the grace" is the question that actually means
 * *being written*. It was inlined identically in the store's expiry and in
 * retention's report — two copies of a rule, in exactly the two places where a
 * partial edit is invisible.
 */
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
 *
 * Bounded retry, because a lost race is not necessarily a lost claim: two
 * processes reading epoch N both try N+1, one wins, and the loser now knows the
 * epoch moved and must re-evaluate against the NEW incumbent (which may be the
 * winner — live, so refuse — or, on a pathological crash, another corpse). The
 * bound stops the loop from becoming a spin on a directory nobody can write.
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
      // Somebody else took this epoch. Look again — the incumbent has changed.
      continue;
    }
    // The claim file is the authority; publishing is the fast path readers use.
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
 * Does this token still hold the fence? Every durable write asks first, so
 * this is the hottest read in the package and its cost is part of its design.
 *
 * It reads the PUBLISHED record only — not the claim-file scan `currentOwner`
 * does — and that is a correctness argument rather than a shortcut. A
 * successor becomes the writer when it PUBLISHES; a claimant that won an epoch
 * and died before publishing has not taken over, and the incumbent appending
 * one more line in that window is harmless, because the successor re-derives
 * its sequence floor from the file when it opens its journal. The scan exists
 * for the opposite question — "what is the next free epoch" — where a corpse's
 * claim file must be counted, and that question is asked once per takeover
 * rather than once per event.
 *
 * A read failure answers `false`: a writer that cannot confirm it still owns
 * the run must not write to it. Fail-closed is the only safe disposition for a
 * question whose wrong answer is two writers.
 */
export function stillOwner(token: OwnershipToken): boolean {
  const owner = readOwnerFile(join(token.dir, RUN_FILES.owner));
  return owner !== null && owner.epoch === token.epoch;
}

/** Refresh the heartbeat, keeping the epoch. A no-op (returning false) once
 *  this token has been fenced — the caller stops rather than resurrecting an
 *  epoch a successor has already moved past. */
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
 *
 * Beside {@link beingWritten} because they are the same question at two
 * strengths — that one asks only whether a heartbeat is fresh, this one applies
 * the full successor test. The cheap one was already factored here and reused;
 * this one had been written out three times (the catalog listing, retention,
 * and the attention query) and could have drifted in any of them.
 */
export function ownerProvablyAlive(dir: string, now: number): boolean | null {
  const owner = currentOwner(dir);
  if (owner === null) return null;
  return !ownershipProvablyLost(owner, now).lost;
}
