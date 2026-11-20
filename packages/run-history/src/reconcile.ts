import { hostname } from "node:os";
import { formatCursor } from "./ids";
import { pidAlive } from "./owner";
import { readReceipt, type ReceiptRecord } from "./receipts";
import type { RunScope } from "./schema";
import {
  type CatalogOptions,
  handleFor,
  readJournal,
  readManifest,
  type RunHandle,
} from "./store";


/** The addressed answer a retry returns, and the exact shape a receipt
 *  replays. */
export interface RetryReceipt {
  request_id: string | null;
  /** `live` — a new attempt on the run that was already going.
   *  `relaunched` — a new run, linked to the one that was retried. */
  mode: "live" | "relaunched";
  /** The run the retry ACTS ON. For `live` that is the run retried; for
   *  `relaunched`, the new one. */
  effective_run: string;
  /** The run that was retried, when the effective run is a different one. */
  parent_run: string | null;
  /** The dependency-minimal nodes the retry re-runs. */
  roots: string[];
  /** Dependants the reset also clears. */
  reset_dependants: string[];
  /** The attempt ordinal each root is now on, where that is known. Empty for a
   *  relaunch. */
  attempts: { node: string; attempt: number }[];
  /** What the effective run covers. A SELECTION, not the pipeline. */
  scope: RunScope;
  /** The commit. A relaunch pins it; nothing here substitutes today's HEAD. */
  sha: string;
  /** Where to resume reading the effective run's journal. */
  cursor: string;
  /** How independent the new coordinator is, when one was started. */
  lifetime?: string;
}



/**
 * Did this request already do its work?
 *
 * `null` means neither effect is visible, which is the one case where
 * re-issuing is safe.
 */
export function reconcile(
  requestId: string,
  receipt: ReceiptRecord,
  handle: RunHandle,
  catalog: CatalogOptions,
  now: number,
  /** This host and its pid probe. The defaults are the real ones. */
  host: string | undefined = hostname(),
  isAlive: ((pid: number) => boolean) | undefined = pidAlive,
): Reconciled {
  const seen = evidenceFor(requestId, receipt, handle, catalog);
  if (seen !== null) return seen;
  if (now - receipt.acceptedAt < RETRY_DISPATCH_GRACE_MS) {
    return {
      kind: "unresolved",
      reason:
        "it was accepted moments ago and has not reached the wire yet — the " +
        "caller that claimed it may still be dispatching it, and two callers " +
        "acting on one id is the duplicate this receipt exists to prevent",
    };
  }
  const claimant = receipt.claimant;
  if (claimant === undefined) {
    return {
      kind: "unresolved",
      reason:
        "the receipt does not name the process that claimed it (an older " +
        "build wrote it), so whether that caller can still dispatch is not a " +
        "question this can answer",
    };
  }
  if (claimant.host !== host) {
    return {
      kind: "unresolved",
      reason:
        `it was claimed by pid ${claimant.pid} on ${claimant.host}, and this ` +
        "host cannot see whether that process is still running — across hosts " +
        "there is no liveness to check, so the outcome stays unknown",
    };
  }
  if (isAlive(claimant.pid)) {
    return {
      kind: "unresolved",
      reason:
        `the caller that claimed it (pid ${claimant.pid}) is STILL RUNNING — ` +
        "it has not dispatched yet, but it can, and telling a second caller to " +
        "re-issue while the first is alive is how one request becomes two",
    };
  }
  const fresh = readReceipt(handle, requestId) ?? receipt;
  const late = evidenceFor(requestId, fresh, handle, catalog);
  if (late !== null) return late;
  return { kind: "nothing_happened" };
}

/**
 * Everything the durable records say about this request, or `null` when they
 * say nothing.
 */
function evidenceFor(
  requestId: string,
  receipt: ReceiptRecord,
  handle: RunHandle,
  catalog: CatalogOptions,
): Reconciled | null {
  const relaunched = reconcileRelaunch(requestId, receipt.plannedRunId, catalog);
  if (relaunched !== null) return { kind: "replay", receipt: relaunched };
  const live = reconcileLive(requestId, receipt, handle);
  if (live !== null) return live;

  if (readJournal(handle).unreadable > 0) {
    return {
      kind: "unresolved",
      reason:
        "this run's journal has lines this build cannot read, so the absence " +
        "of a record for it is not evidence that nothing happened",
    };
  }
  if (receipt.dispatchedAt !== undefined) {
    return {
      kind: "unresolved",
      reason:
        "it had already been put on the wire when its outcome was lost, and " +
        "the coordinator it was sent to recorded no acceptance — an older " +
        "build, or one that died before writing one",
    };
  }
  return null;
}

/** The floor below which an undispatched claim is not even asked about. */
export const RETRY_DISPATCH_GRACE_MS = 120_000;

export type Reconciled =
  | { kind: "replay"; receipt: RetryReceipt }
  | { kind: "nothing_happened" }
  /** The coordinator answered, and the answer was no. */
  | { kind: "refused"; message: string }
  | { kind: "unresolved"; reason: string };

/** The relaunch half: a run exists under the id this request planned. */
function reconcileRelaunch(
  requestId: string,
  plannedRunId: string,
  catalog: CatalogOptions,
): RetryReceipt | null {
  if (plannedRunId === "") return null;
  const planned = handleFor(plannedRunId, catalog);
  const manifest = readManifest(planned);
  if (manifest === null) return null;
  return {
    request_id: requestId,
    mode: "relaunched",
    effective_run: plannedRunId,
    parent_run: manifest.parentRunId,
    roots: [...manifest.scope.selectors],
    reset_dependants: [],
    attempts: [],
    scope: manifest.scope,
    sha: manifest.sha,
    cursor: formatCursor({ runId: plannedRunId, seq: 0 }),
  };
}

/** The live half: what the coordinator wrote down about THIS request. */
function reconcileLive(
  requestId: string,
  receipt: ReceiptRecord,
  handle: RunHandle,
): Reconciled | null {
  const journal = readJournal(handle);
  const manifest = readManifest(handle);
  if (manifest === null) return null;
  const asked: string[] = [];
  const resolved = new Map<string, boolean>();
  for (const { event } of journal.entries) {
    if (event.kind === "retry_accepted" && event.requestId === requestId) {
      for (const root of event.roots) if (!asked.includes(root)) asked.push(root);
    }
    if (event.kind === "retry_applied" && event.requestId === requestId) {
      resolved.set(event.node, event.applied);
    }
  }
  if (asked.length === 0) return null;
  const intended = receipt.roots === undefined ? asked : [...receipt.roots];
  const unresolved = intended.filter((node) => !resolved.has(node));
  if (unresolved.length > 0) {
    return {
      kind: "unresolved",
      reason:
        `this request names ${intended.join(", ")}, and nothing has recorded what ` +
        `became of ${unresolved.join(", ")} — either it is still being dispatched ` +
        "root by root, or the coordinator died between accepting a reset and " +
        "performing it. Either way the request is not finished, so its outcome is " +
        "not knowable yet",
    };
  }
  const applied = intended.filter((node) => resolved.get(node) === true);
  const declined = intended.filter((node) => resolved.get(node) !== true);
  if (applied.length === 0) {
    return {
      kind: "unresolved",
      reason:
        `this run's coordinator declined every root it was asked to reset ` +
        `(${declined.join(", ")}), which is what selects a replacement RUN rather ` +
        "than the end of the request — so the caller that claimed it is very " +
        "likely inside that launch now, and its outcome is not settled here",
    };
  }
  if (declined.length > 0) {
    return {
      kind: "refused",
      message:
        `odu: request "${requestId}" was applied in part — ${applied.join(", ")} ` +
        `was re-run, ${declined.join(", ")} was declined by its lane. The retry did ` +
        "not do everything it was asked for, so it is reported rather than replayed " +
        "as a whole.",
    };
  }
  return {
    kind: "replay",
    receipt: {
      request_id: requestId,
      mode: "live",
      effective_run: handle.runId,
      parent_run: null,
      roots: applied,
      reset_dependants: [],
      attempts: [],
      scope: manifest.scope,
      sha: manifest.sha,
      cursor: formatCursor({ runId: handle.runId, seq: journal.highestSeq }),
    },
  };
}

