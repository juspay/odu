/**
 * WHAT HAPPENED TO REQUEST X — the fold from a run's durable evidence to the
 * answer a repeat of an idempotent retry deserves.
 *
 * Pure over the catalog, exactly like `./attention`, and here for the same
 * reason. It reads a receipt and a journal and returns a FACT; it dials
 * nothing, launches nothing, and mutates nothing. It lived inside the retry
 * POLICY next door, reachable only through `retryRun` — whose input REQUIRES a
 * `RunLauncher` — so a face that only wanted to ask "did my earlier retry
 * land?" had to construct a launcher it would never invoke in order to satisfy
 * a type. That is a mutation port standing in front of a read, and it is the
 * split `readAttention` already has: the orchestration is the engine's, the
 * fold over evidence is the catalog's. PR 2's service face needs to ask this
 * question over HTTP, with no launcher anywhere in the picture.
 *
 * The policy still owns everything that ACTS — dialing the live coordinator,
 * launching a replacement, choosing between them. It calls this to learn what
 * it is entitled to conclude.
 */

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


/** The addressed answer a retry returns — everything a caller needs to act
 *  without asking a second question, and the exact shape a receipt replays. */
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
  /** Dependants the reset also clears — named because a caller that reads
   *  "reran unit" and finds `e2e` pending has to know which happened. */
  reset_dependants: string[];
  /** The attempt ordinal each root is now on, where that is known. Empty for a
   *  relaunch: the new run has not started its attempts yet. */
  attempts: { node: string; attempt: number }[];
  /** What the effective run covers. A SELECTION, and the field is here so no
   *  face can present its verdict as the pipeline's. */
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
 * A retry has TWO possible effects and reconciliation has to be able to see
 * either, because which one it took is not something the caller can know when
 * its reply goes missing.
 *
 * - A RELAUNCH publishes a new run under the id minted at accept time, so the
 *   question is a directory lookup.
 * - A LIVE retry publishes no run at all. It resets a node on a coordinator
 *   that is already going, and the only trace is in that run's own journal —
 *   the `attempt_started` the coordinator appends for the node it reset. So
 *   the journal's height at accept time is recorded on the receipt, and this
 *   asks whether a matching attempt appeared past it.
 *
 * Looking only for the child run is what made a successful live mutation
 * report "nothing was done — retry with a fresh id", advice that invites a
 * caller to do it a second time. Absence of a child manifest is not absence of
 * an effect.
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
  /** This host and its pid probe — injected so a suite can state a world
   *  rather than mutate the process's. The defaults are the real ones. */
  host: string | undefined = hostname(),
  isAlive: ((pid: number) => boolean) | undefined = pidAlive,
): Reconciled {
  const seen = evidenceFor(requestId, receipt, handle, catalog);
  if (seen !== null) return seen;
  // NOT YET DISPATCHED IS NOT THE SAME AS NEVER WILL BE, and AGE IS NOT
  // EVIDENCE. This once concluded "nothing happened" from elapsed time alone,
  // which fences nothing: a claimant paused in a dial is still perfectly
  // capable of mutating a moment after the grace expires, so the second caller
  // was told re-issuing was safe while the first was about to act. A longer
  // grace only moves that race.
  //
  // So the question is the one the ownership fence next door asks, with the
  // same answer shape: is the process that holds this claim GONE? A pid on a
  // host is evidence; a clock is not. The grace survives as a FLOOR — below it
  // nobody is even asked about, because a pid observed dead moments after a
  // claim is more likely a pid not yet observed alive — but past it the answer
  // turns on liveness, and a claimant that is still running keeps the outcome
  // unknown for as long as it runs.
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
  // THE CLAIMANT IS GONE — and the evidence read at the top of this function
  // was read BEFORE that was established. In between, the very process now
  // observed dead could have marked its dispatch, sent it, and exited: the
  // probe answers about the instant it runs, and every read older than it is a
  // snapshot from before the question was asked.
  //
  // So the authoritative records are read AGAIN, now that nothing can add to
  // them. A dispatch that landed in the window is found here; only a second
  // look that still shows nothing licenses re-issuing.
  const fresh = readReceipt(handle, requestId) ?? receipt;
  const late = evidenceFor(requestId, fresh, handle, catalog);
  if (late !== null) return late;
  return { kind: "nothing_happened" };
}

/**
 * Everything the durable records say about this request, or `null` when they
 * say nothing.
 *
 * One function because it is asked TWICE — once before the claimant's liveness
 * is probed, and once after the probe says it is gone. The second ask is what
 * closes the window between those two reads, and it can only close it by being
 * the same question.
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

  // Neither effect is visible. Whether that means "nothing happened" depends
  // entirely on whether the evidence that WOULD have shown it could exist and
  // could be read — so the two unreadable cases are separated out rather than
  // folded into the safe one.
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

/**
 * What a repeat of an in-flight request can be told.
 *
 * FOUR answers, and the two that were missing are the ones that made the old
 * advice unsafe.
 * `nothing_happened` is a claim about the world and licences re-issuing; it may
 * only be returned when the evidence that would have shown otherwise could
 * exist AND could be read. When it could not, the honest answer is that nobody
 * knows — which is not the same as no, and must never be answered with "retry
 * with a fresh id".
 */
/**
 * The floor below which an undispatched claim is not even asked about.
 *
 * NOT the decision, and it used to be — which was the bug. A claim was read as
 * abandoned once it was merely this old, so a claimant paused in a dial was
 * declared harmless while it was still perfectly able to mutate, and the
 * caller that asked second was told re-issuing was safe. Elapsed time fences
 * nothing; a longer number would only have moved the race.
 *
 * What decides now is whether the claiming PROCESS is gone, the same evidence
 * the ownership fence requires. This survives only as a cheap guard in front of
 * that question: a pid observed dead moments after a claim is more likely a pid
 * that was not yet observed alive, and the cost of waiting two minutes before
 * asking is a refusal that would have been a refusal anyway.
 */
export const RETRY_DISPATCH_GRACE_MS = 120_000;

export type Reconciled =
  | { kind: "replay"; receipt: RetryReceipt }
  | { kind: "nothing_happened" }
  /** The coordinator answered, and the answer was no. A recorded refusal is an
   *  OUTCOME — replaying it tells a repeat what happened, where `unresolved`
   *  would say nobody knows. */
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
    // The id it was asked under: a reconciled receipt is answering the SAME
    // request, and a caller correlating on this field must not find it empty
    // for the one call where it had to reconcile.
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

/**
 * The live half: what the coordinator wrote down about THIS request.
 *
 * **Why nothing weaker will do.** This once asked a question about timing — did
 * a node the selector names start an attempt after my receipt was claimed? —
 * and treated `yes` as proof that the mutation was this caller's. It is not
 * proof of anything. Ordinary scheduling starts attempts; so does a rerun
 * somebody else asked for; so does the run's own first pass over a node that
 * had not run yet. Correlation cannot be reconstructed from a clock.
 *
 * **And acceptance alone is not application.** The coordinator records
 * `retry_accepted` BEFORE performing the reset, because the other ordering lets
 * a crash hide a mutation that happened. The price is that the acceptance, read
 * alone, proves only that the reset was asked for: the coordinator can die in
 * between, and the lane can decline. So this reads the PAIR. An acceptance whose
 * `retry_applied` never arrived is a pending intent, and pending is reported as
 * unknown — never as a receipt describing a retry that may not have run.
 *
 * Four answers — applied, declined, partial, and pending — and the roots come
 * from the recorded acceptance rather than from whatever the run's latest
 * attempt happens to be now.
 */
function reconcileLive(
  requestId: string,
  receipt: ReceiptRecord,
  handle: RunHandle,
): Reconciled | null {
  const journal = readJournal(handle);
  const manifest = readManifest(handle);
  if (manifest === null) return null;
  const asked: string[] = [];
  /** Per NODE, because one request dispatches one `node.rerun` per root and the
   *  answers can differ. Folding them into a single boolean made a retry where
   *  one root was reset and another declined read as wholly one or the other —
   *  last write wins — which is a lie in whichever direction it lands. */
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
  // THE INTENT, not the acceptances written so far. The coordinator records one
  // acceptance per root and `tryLive` dispatches them one at a time, so between
  // two roots the journal shows a PREFIX of the request. Reading the intent
  // from that prefix made a repeat arriving in the window believe the first
  // root was the whole request — and `completeReceipt` then froze that short
  // answer forever, so even the third ask, long after every root had landed,
  // replayed a success naming one of two.
  //
  // The receipt's `roots` were written before any root was dispatched, so they
  // are the whole request by construction. An older receipt has none, and then
  // the accepted set is the only thing there is — the old behaviour, kept only
  // where nothing better exists.
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
    // EVERY root declined — which is where the live attempt ENDS and the
    // request does not. The policy treats a wholly-declined live reset as the
    // signal to start a replacement run, so these same records mean "the live
    // path is over" to one side and used to mean "the request is over" to this
    // one. A repeat arriving while the original caller was inside its launcher
    // therefore persisted a refusal, and `completeReceipt` then hid the child
    // that really started — permanently, since the first result wins.
    //
    // A per-lane refusal cannot finalize a request that can still launch a
    // child. A request whose fallback DID finish has a completed receipt and is
    // replayed long before this is reached, so reaching here at all means the
    // original caller is still working.
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
    // PARTIAL, and said so. Reporting this as a success would name roots that
    // were never reset; reporting it as a refusal would deny ones that were.
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
      // Not recorded at the time and not reconstructable now: the dependants a
      // reset cleared are a property of the live DAG, which may have moved on.
      // Empty rather than guessed.
      reset_dependants: [],
      // EMPTY, and this is the point rather than an omission. The ordinal a
      // retry produced is not known at the moment the reset is applied — the
      // lane allocates it when it republishes — so it was never recorded, and
      // reading "the latest attempt now" would hand back a number belonging to
      // whatever has happened since, including the very failure being retried.
      // A relaunch reports the same emptiness for the same reason.
      attempts: [],
      scope: manifest.scope,
      sha: manifest.sha,
      cursor: formatCursor({ runId: handle.runId, seq: journal.highestSeq }),
    },
  };
}

