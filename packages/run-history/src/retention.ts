import { runIdStartedAt } from "./ids";
import {
  type CatalogOptions,
  expireRun,
  handleFor,
  readExpiry,
  readVerdict,
  runsStartedBefore,
} from "./store";
import { beingWritten, currentOwner, ownershipProvablyLost } from "./owner";

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
  /** Runs old enough to expire but kept, with why. */
  kept: { runId: string; reason: string }[];
}

/** Expire finished runs older than the retention window. Idempotent: a run
 *  that already carries a tombstone is skipped. */
export function pruneCatalog(opts: PruneOptions = {}): PruneReport {
  const now = opts.now ?? Date.now();
  const retention = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const report: PruneReport = { expired: [], kept: [] };
  for (const runId of runsStartedBefore(now - retention, opts)) {
    const handle = handleFor(runId, opts);
    if (readExpiry(handle) !== null) continue;
    const verdict = readVerdict(handle);
    if (verdict === null) {
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
    if (beingWritten(currentOwner(handle.dir), now)) {
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
