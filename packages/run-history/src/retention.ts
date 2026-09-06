/**
 * Retention — how long a finished run's evidence is kept, and what is left
 * behind when it is not.
 *
 * The policy is small and the reason for each half is not:
 *
 *   - ACTIVE RUNS ARE NEVER PRUNED, whatever their age. A run whose owner is
 *     alive is a run somebody is watching; an owner that has been stuck for
 *     forty days is a problem, but deleting the evidence of it is not the fix.
 *   - FINISHED RUNS EXPIRE AT 30 DAYS by default, and expiry is a TOMBSTONE
 *     rather than a deletion. `rm -rf` on the directory would make an
 *     addressed read say "no such run", which is the same answer a typo gets;
 *     an agent holding a month-old id deserves to be told the run existed and
 *     its evidence aged out, and to be told what it ended as. That is three
 *     small files instead of none.
 *
 * Pruning is by RUN, never by sweeping a shared directory: a run id encodes
 * its start instant (see `./ids`), so selecting candidates is a directory
 * listing and a string parse, with no manifest read per entry and no chance of
 * a half-read record selecting the wrong run for deletion.
 */

import { runIdStartedAt } from "./ids";
import {
  type CatalogOptions,
  expireRun,
  handleFor,
  readExpiry,
  readVerdict,
  runsStartedBefore,
} from "./store";
import {
  currentOwner,
  OWNERSHIP_GRACE_MS,
  ownershipProvablyLost,
} from "./owner";

/** The default keep-window for finished runs. */
export const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface PruneOptions extends CatalogOptions {
  /** Keep runs newer than this. */
  retentionMs?: number;
  now?: number;
  /** Report what would go, and change nothing. */
  dryRun?: boolean;
}

export interface PruneReport {
  /** Runs whose evidence was replaced with a tombstone. */
  expired: string[];
  /** Runs old enough to expire but kept, with why. The list exists so a
   *  `--dry-run` can explain a disk that is not shrinking. */
  kept: { runId: string; reason: string }[];
}

/**
 * Expire finished runs older than the retention window.
 *
 * Deliberately idempotent: a run that already carries a tombstone is skipped,
 * so this can be called on every coordinator start without accumulating work
 * or rewriting expiry timestamps that a reader may be quoting.
 */
export function pruneCatalog(opts: PruneOptions = {}): PruneReport {
  const now = opts.now ?? Date.now();
  const retention = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const report: PruneReport = { expired: [], kept: [] };
  for (const runId of runsStartedBefore(now - retention, opts)) {
    const handle = handleFor(runId, opts);
    if (readExpiry(handle) !== null) continue;
    const verdict = readVerdict(handle);
    if (verdict === null) {
      // No terminal record. Either it is still going, or its owner died
      // without finalizing — and an un-finalized run's evidence is the ONLY
      // account of what happened to it, which is precisely when it is worth
      // most. Kept, and said out loud.
      const owner = currentOwner(handle.dir);
      const alive =
        owner !== null && !ownershipProvablyLost(owner, now).lost;
      report.kept.push({
        runId,
        reason: alive
          ? "still running"
          : "never finalized — its evidence is the only account of how it ended",
      });
      continue;
    }
    // A finished run that is somehow still being written — a `--linger`
    // coordinator that has not let go — keeps its evidence. The check is made
    // in BOTH modes, before the dry-run branch: a `--dry-run` whose whole
    // promise is "this is what a real pass would do" must not report a
    // deletion that a real pass would then refuse.
    const owner = currentOwner(handle.dir);
    if (owner !== null && now - owner.heartbeatAt < OWNERSHIP_GRACE_MS) {
      report.kept.push({ runId, reason: "still owned by a live coordinator" });
      continue;
    }
    if (!opts.dryRun) expireRun(handle, now);
    report.expired.push(runId);
  }
  return report;
}

/** How old a run is, from its id alone. `null` for an id this vocabulary did
 *  not mint. */
export function ageOf(runId: string, now: number = Date.now()): number | null {
  const started = runIdStartedAt(runId);
  return started === null ? null : now - started;
}
