/**
 * The retry policy — ONE decision about what "run that again" means, shared by
 * the native CLI now and by PR 2's service later.
 *
 * The three cases are not three commands. A caller asking to retry a node
 * knows the node; whether that means "reset it on the run still going" or
 * "start a fresh run from the recorded inputs" is a fact about the run, not
 * about the request, and making the caller choose is how the two get chosen
 * wrongly. So:
 *
 * | the run is | what happens |
 * | --- | --- |
 * | live, same snapshot | a new attempt on it; dependants reset, independent siblings untouched |
 * | finalized, same snapshot | a NEW run, linked to it, from its recorded inputs |
 * | a different commit | not this command's business — start a run; supersede is explicit |
 *
 * **THE CHOICE IS ATOMIC AGAINST SETTLEMENT, and the way it is made is the
 * interesting part.** Reading "is it settled?" and then acting on the answer is
 * a race with a window as wide as the read: a run can finalize in it, and then
 * a live retry lands on a coordinator that is exiting. So the live path is not
 * predicted, it is ATTEMPTED — the live coordinator's own accept or refusal is
 * the arbiter, and a refusal (its socket is gone, or it will not take the
 * mutation) is what selects the finalized path. There is no clock in the
 * decision and therefore no window in it.
 *
 * **A LOST REPLY IS RECONCILED, NEVER REPEATED.** A request may carry an id;
 * the id is claimed on disk before anything is done, with a run id pre-minted
 * for the new run the request might need. A repeat of the same id with the
 * same input replays the recorded answer; with different input it is refused;
 * and one whose first attempt vanished mid-flight asks the catalog whether
 * that pre-minted run exists, rather than starting a second one to find out.
 *
 * **A SELECTION IS NOT A PIPELINE.** A finalized retry starts a run whose
 * scope is the SELECTED nodes and their dependency closure, and the receipt
 * says so. It does not rewrite its parent, it does not mark the parent green,
 * and nothing here lets a passing selection be read as a passing pipeline.
 */

import { existsSync } from "node:fs";
import { dialRun } from "@odu/run-client/dial";
import type { PipelineState } from "@odu/run-client/surface";
import { mintRunId } from "@odu/run-history/ids";
import {
  claimReceipt,
  completeReceipt,
  markDispatched,
  digestOf,
  isRequestId,
  readReceipt,
  type ReceiptRecord,
} from "@odu/run-history/receipts";
import type { RunManifest, RunScope } from "@odu/run-history/schema";
import { currentOwner } from "@odu/run-history/owner";
import {
  attemptsFor,
  type CatalogOptions,
  handleFor,
  readExpiry,
  readManifest,
  readVerdict,
  type RunHandle,
} from "@odu/run-history/store";
import { formatCursor } from "@odu/run-history/ids";
import { readJournal } from "@odu/run-history/store";
import { firstFrame, runUnary } from "../common/effectEdge";
import {
  minimalRerunRoots,
  resolveRerunTargets,
  transitiveDependents,
} from "../common/nodeId";
import type { LaunchRequest, RunLauncher } from "./launcher";

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

export type RetryOutcome =
  | { ok: true; receipt: RetryReceipt; replayed: boolean }
  | {
      ok: false;
      message: string;
      /** A recovery the caller can run, as ARGV — never a string to eval. */
      suggestion?: string[];
    };

export interface RetryInput {
  /** The catalog run to retry. */
  runId: string;
  /** `ci::unit@plat`, `@plat`, or a recipe name — the same grammar
   *  `odu rerun` has always taken. */
  selector: string;
  /** Idempotency key. Absent means the caller accepts that a repeat repeats. */
  requestId?: string;
  /** Refuse unless the named node is on exactly this attempt — the guard
   *  against acting on a stale reading of a run that has moved on. */
  expectAttempt?: { node: string; attempt: number };
  catalog?: CatalogOptions;
  launcher: RunLauncher;
  /** Injected for tests; defaults to the real unix-socket dial. */
  dial?: typeof dialRun;
  /** Where a degraded-but-successful retry says so. Not an error channel: the
   *  one caller is the coordinator that could not record this request's id, so
   *  the mutation happened and only a future REPEAT of it is impaired. */
  warn?: (message: string) => void;
  now?: () => number;
}

/** Retry a node on a recorded run. */
export async function retryRun(input: RetryInput): Promise<RetryOutcome> {
  const now = input.now ?? Date.now;
  const catalog = input.catalog ?? {};
  const handle = handleFor(input.runId, catalog);
  const manifest = readManifest(handle);
  if (manifest === null) {
    return { ok: false, message: `odu: no run ${input.runId} in the catalog` };
  }
  if (input.requestId !== undefined && !isRequestId(input.requestId)) {
    return {
      ok: false,
      message:
        `odu: "${input.requestId}" is not a usable request id ` +
        "(letters, digits, dot, dash and underscore; 128 chars)",
    };
  }
  if (input.expectAttempt !== undefined) {
    const recorded = attemptsFor(handle, input.expectAttempt.node);
    const latest = recorded[recorded.length - 1] ?? 0;
    if (latest !== input.expectAttempt.attempt) {
      return {
        ok: false,
        message:
          `odu: ${input.expectAttempt.node} is on attempt ${latest}, not ` +
          `${input.expectAttempt.attempt} — this run has moved on since you read it`,
        suggestion: ["odu", "history", "show", "--run", input.runId],
      };
    }
  }

  // The run id a RELAUNCH would publish under, minted before anything is
  // claimed or started. Never used on the live path; see the receipt's own
  // note on why it is minted anyway.
  const plannedRunId = mintRunId(now());
  const digest = digestOf([
    input.runId,
    input.selector,
    input.expectAttempt?.node ?? "",
    input.expectAttempt?.attempt ?? 0,
  ]);

  let claimedRunId = plannedRunId;
  if (input.requestId !== undefined) {
    const claim = claimReceipt(handle, {
      requestId: input.requestId,
      kind: "retry",
      digest,
      plannedRunId,
      journalAtAccept: readJournal(handle).highestSeq,
    });
    if (claim === null) {
      return { ok: false, message: `odu: could not record request ${input.requestId}` };
    }
    if (claim.kind === "conflict") {
      return {
        ok: false,
        message:
          `odu: request id "${input.requestId}" was already used for a different retry ` +
          "— use a fresh id, or repeat the original request exactly",
      };
    }
    if (claim.kind === "replay") {
      // The recorded outcome, WHOLE — a refusal included. A request that was
      // refused has a recorded outcome just as much as one that succeeded, and
      // replaying only the successes would answer the second identical ask
      // with a different (and untrue) story about what happened to the first.
      return replayOf(claim.receipt.result);
    }
    if (claim.kind === "in_flight") {
      const reconciled = reconcile(
        input.requestId,
        claim.receipt,
        handle,
        catalog,
        now(),
      );
      if (reconciled.kind === "replay") {
        const outcome: RetryOutcome = {
          ok: true,
          receipt: reconciled.receipt,
          replayed: true,
        };
        completeReceipt(handle, input.requestId, outcome, now());
        return outcome;
      }
      if (reconciled.kind === "refused") {
        // A recorded NO. Completed like any other outcome, so the third ask is
        // a plain replay rather than a third round of reconciliation.
        const outcome: RetryOutcome = {
          ok: false,
          message: reconciled.message,
          suggestion: ["odu", "history", "show", "--run", input.runId],
        };
        completeReceipt(handle, input.requestId, outcome, now());
        return outcome;
      }
      if (reconciled.kind === "unresolved") {
        // NOT "retry with a fresh id". A fresh id is a licence to perform the
        // mutation a second time, and this is precisely the case where nobody
        // can say whether the first one landed. The caller is told what is
        // unknown and pointed at the evidence to settle it by hand.
        return {
          ok: false,
          message:
            `odu: request "${input.requestId}" was accepted and its outcome is UNKNOWN — ` +
            `${reconciled.reason}. Do not repeat it with a fresh id until you have ` +
            "checked whether it took effect: a second retry would be a second mutation.",
          suggestion: ["odu", "history", "show", "--run", input.runId],
        };
      }
      return {
        ok: false,
        message:
          `odu: request "${input.requestId}" was accepted and its outcome is not recorded. ` +
          "No run was started under it, this run's coordinator recorded no acceptance " +
          "for it, and it was never put on the wire — so nothing it asked for happened. " +
          "Retry with a fresh id.",
        suggestion: ["odu", "history", "show", "--run", input.runId],
      };
    }
    claimedRunId = claim.receipt.plannedRunId;
  }

  const requestId = input.requestId;
  /** One marker for both paths — a live rerun and a relaunch are both the
   *  moment this request stops being reversible. */
  const markDispatch =
    requestId === undefined
      ? undefined
      : () => markDispatched(handle, requestId, now());
  const live = await tryLive(handle, manifest, input, digest, markDispatch, (message) =>
    input.warn?.(message),
  );
  if (live !== null) {
    return finish(handle, input, { ok: true, receipt: live, replayed: false }, now);
  }
  const relaunched = await relaunch(
    handle,
    manifest,
    input,
    claimedRunId,
    catalog,
    markDispatch,
  );
  return finish(
    handle,
    input,
    relaunched.ok
      ? { ok: true, receipt: relaunched.receipt, replayed: false }
      : relaunched,
    now,
  );
}

/** Rebuild an outcome from a recorded receipt. A stored value this build
 *  cannot recognise is refused rather than cast: the alternative is handing a
 *  caller an object shaped like a receipt with nothing in it. */
function replayOf(stored: unknown): RetryOutcome {
  const value = stored as Partial<RetryOutcome> | null;
  if (value !== null && value !== undefined && "ok" in value) {
    return value.ok === true
      ? { ok: true, receipt: (value as { receipt: RetryReceipt }).receipt, replayed: true }
      : (value as { ok: false; message: string; suggestion?: string[] });
  }
  return {
    ok: false,
    message:
      "odu: that request id was used before, but this build cannot read what it recorded",
  };
}

/**
 * Record the answer against the request id, when there is one, and hand it
 * back.
 *
 * EVERY answer, including a refusal. A claimed id whose outcome is never
 * recorded stays `accepted` forever, and the next identical ask — which is
 * exactly what idempotency invites a caller to make — is told the request "was
 * accepted and its outcome is not recorded", which is false: the outcome was
 * a refusal, and it is knowable. One function, so no path can take the claim
 * and skip the record.
 */
function finish(
  handle: RunHandle,
  input: RetryInput,
  outcome: RetryOutcome,
  now: () => number,
): RetryOutcome {
  if (input.requestId !== undefined) {
    completeReceipt(handle, input.requestId, outcome, now());
  }
  return outcome;
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
function reconcile(
  requestId: string,
  receipt: ReceiptRecord,
  handle: RunHandle,
  catalog: CatalogOptions,
  now: number,
): Reconciled {
  const relaunched = reconcileRelaunch(requestId, receipt.plannedRunId, catalog);
  if (relaunched !== null) return { kind: "replay", receipt: relaunched };
  const live = reconcileLive(requestId, handle);
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
  // NOT YET DISPATCHED IS NOT THE SAME AS NEVER WILL BE. The claimant may be
  // alive and one instruction short of dispatching: a repeat that arrives
  // while a launcher is still starting a coordinator sees exactly this state,
  // and telling it "nothing happened, use a fresh id" is how one request
  // becomes two runs. So an undispatched claim is only read as a no-op once it
  // is old enough that a claimant which had not dispatched by now is not going
  // to — the same shape as the ownership fence next door, and for the same
  // reason: disappearance is not proof, and neither is a single instant.
  if (now - receipt.acceptedAt < RETRY_DISPATCH_GRACE_MS) {
    return {
      kind: "unresolved",
      reason:
        "it was accepted moments ago and has not reached the wire yet — the " +
        "caller that claimed it may still be dispatching it, and two callers " +
        "acting on one id is the duplicate this receipt exists to prevent",
    };
  }
  return { kind: "nothing_happened" };
}

/**
 * What a repeat of an in-flight request can be told.
 *
 * Three answers, because the missing third is what made the old advice unsafe.
 * `nothing_happened` is a claim about the world and licences re-issuing; it may
 * only be returned when the evidence that would have shown otherwise could
 * exist AND could be read. When it could not, the honest answer is that nobody
 * knows — which is not the same as no, and must never be answered with "retry
 * with a fresh id".
 */
/**
 * How long an accepted-but-undispatched claim is treated as possibly still in
 * flight.
 *
 * Generous on purpose. The window it has to cover is a claimant between
 * `claimReceipt` and its first mutation, and on the relaunch path that includes
 * starting a coordinator and waiting for its socket — seconds, not
 * milliseconds. Being too generous costs a caller a refusal it could have
 * avoided; being too mean costs a duplicate run, which is the failure this
 * whole mechanism exists to prevent. The asymmetry decides the number.
 */
export const RETRY_DISPATCH_GRACE_MS = 120_000;

type Reconciled =
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
 * Three answers, and the roots come from the recorded acceptance rather than
 * from whatever the run's latest attempt happens to be now.
 */
function reconcileLive(requestId: string, handle: RunHandle): Reconciled | null {
  const journal = readJournal(handle);
  const manifest = readManifest(handle);
  if (manifest === null) return null;
  let roots: string[] = [];
  let applied: boolean | undefined;
  for (const { event } of journal.entries) {
    if (event.kind === "retry_accepted" && event.requestId === requestId) {
      roots = [...new Set([...roots, ...event.roots])];
    }
    if (event.kind === "retry_applied" && event.requestId === requestId) {
      applied = event.applied;
    }
  }
  if (roots.length === 0) return null;
  if (applied === undefined) {
    return {
      kind: "unresolved",
      reason:
        `this run's coordinator recorded accepting it (${roots.join(", ")}) but never ` +
        "recorded what became of it — it died between accepting the retry and " +
        "performing it, so whether the reset happened is not knowable from here",
    };
  }
  if (!applied) {
    return {
      kind: "refused",
      message:
        `odu: request "${requestId}" was accepted by this run's coordinator and the ` +
        `lane declined the reset (${roots.join(", ")}). Nothing was re-run.`,
    };
  }
  return {
    kind: "replay",
    receipt: {
      request_id: requestId,
      mode: "live",
      effective_run: handle.runId,
      parent_run: null,
      roots,
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

/**
 * Try the live path. `null` means the run is not live, is not the run we were
 * asked about, or would not take the mutation — each of which SELECTS the
 * finalized path rather than failing the caller's request.
 *
 * **THE SOCKET IS NOT THE RUN.** `.ci/odu.sock` is scoped to a CHECKOUT, and a
 * checkout serves one run after another: run A finishes, run B starts, and the
 * path is identical. Dialing the endpoint a finished run recorded and issuing
 * `node.rerun` therefore mutates whatever is serving that path NOW — so a
 * retry of A would reset a node on B while handing back a receipt carrying A's
 * id and A's commit. Nothing downstream could detect it: the receipt is
 * internally consistent and describes a run that did not change.
 *
 * So the identity is CHECKED against the durable record before any mutation.
 * `<sha7>#<seq>` is the identity the fan-in publishes and the catalog stores,
 * and a run with no ordinal cannot prove it is the one being addressed — so
 * that case is refused rather than guessed, and falls through to a fresh run.
 * Fail-closed: the cost of the wrong answer is mutating a stranger's run.
 *
 * The endpoint is read from `currentOwner`, not from the manifest. The
 * manifest's `registeredBy` is stamped once and never cleared, so it names a
 * socket that stopped existing when the run ended; `owner.json` is the copy a
 * heartbeat refreshes and a clean exit clears.
 */
async function tryLive(
  handle: RunHandle,
  manifest: RunManifest,
  input: RetryInput,
  digest: string,
  onDispatch?: () => void,
  warn?: (message: string) => void,
): Promise<RetryReceipt | null> {
  const owner = currentOwner(handle.dir);
  if (owner === null || owner.endpoint === null) return null;
  const dial = input.dial ?? dialRun;
  const dialed = await dial(owner.endpoint);
  if (dialed === null) return null;
  try {
    const state = await firstFrame(dialed.client.surface.nodes.get(undefined));
    if (state === undefined || state.order.length === 0) return null;
    if (!isSameRun(manifest, state)) return null;
    let targets: string[];
    try {
      targets = resolveRerunTargets(state, input.selector);
    } catch {
      // The selector does not name anything on the LIVE run. It may still name
      // something the recorded run had (a node whose lane was dropped), so
      // this is a fall-through rather than a refusal.
      return null;
    }
    const roots = minimalRerunRoots(state, targets);
    if (roots.length === 0) return null;
    // The point of no return. Everything above is a question; the next line is
    // a mutation, and from here on "my reply went missing" and "nothing
    // happened" stop being the same thing. So the receipt learns that a
    // dispatch was attempted BEFORE one is — see `reconcile`, which reads this
    // to keep an unresolved acceptance unresolved instead of calling it a
    // no-op.
    onDispatch?.();
    const accepted: string[] = [];
    let recorded = true;
    for (const id of roots) {
      const result = await runUnary(
        dialed.client.surface.node.rerun({
          id,
          ...(input.requestId === undefined
            ? {}
            : { requestId: input.requestId, inputDigest: digest }),
        }),
      );
      if (result.ok) {
        accepted.push(id);
        // An older coordinator drops the id it does not know and answers
        // without `recorded`. It still performed the reset, so this is not a
        // failure — but nothing was written against the request, so a lost
        // reply for THIS call is not reconstructable from the journal.
        if (result.recorded !== true) recorded = false;
      }
    }
    if (accepted.length === 0) return null;
    if (input.requestId !== undefined && !recorded) {
      // Say it where an operator will see it. The retry itself succeeded; what
      // is degraded is only what a REPEAT of this id could be told.
      warn?.(
        `odu: this run's coordinator did not record request "${input.requestId}" — ` +
          "a repeat of it can only report that its outcome is unknown",
      );
    }
    return {
      request_id: input.requestId ?? null,
      mode: "live",
      effective_run: handle.runId,
      parent_run: null,
      roots: accepted,
      reset_dependants: dependantsOf(state, accepted),
      // Read AFTER the mutation, so the ordinal is the one the retry created
      // rather than the one it replaced.
      attempts: accepted.map((node) => ({
        node,
        attempt: attemptsFor(handle, node).at(-1) ?? 1,
      })),
      scope: manifest.scope,
      sha: manifest.sha,
      cursor: formatCursor({
        runId: handle.runId,
        seq: readJournal(handle).highestSeq,
      }),
    };
  } finally {
    await dialed.close();
  }
}

/**
 * Is the run serving this socket the run the manifest describes?
 *
 * `<sha7>#<seq>` is the identity every face already prints and the catalog
 * already stores, so it is what the two sides are compared on. A run that
 * reserved no ordinal has no unique identity to compare — `sha7` alone is
 * shared by every run of a commit, including a rerun of the very run being
 * retried — so it cannot answer yes, and this returns false rather than
 * assuming.
 */
export function isSameRun(
  manifest: Pick<RunManifest, "sha" | "seq">,
  live: Pick<PipelineState, "sha7" | "seq">,
): boolean {
  if (manifest.seq === null || live.seq === undefined) return false;
  if (manifest.seq !== live.seq) return false;
  if (live.sha7 === "") return false;
  return manifest.sha.toLowerCase().startsWith(live.sha7.toLowerCase());
}

function dependantsOf(state: PipelineState, roots: readonly string[]): string[] {
  const needsOf = (id: string): readonly string[] => state.nodes[id]?.needs ?? [];
  const out = new Set<string>();
  for (const root of roots) {
    for (const id of transitiveDependents(state.order, needsOf, root)) {
      out.add(id);
    }
  }
  for (const root of roots) out.delete(root);
  return [...out].sort();
}

/**
 * Start a NEW run from the recorded inputs, linked to the one retried.
 *
 * Two refusals rather than a silent substitution, and both are the same rule
 * wearing two faces: a replay must reproduce the run it replays, so a run
 * whose inputs were never recorded cannot be replayed at all.
 *
 * - A DIRTY LIVE TREE was never committed. Its inputs do not exist anywhere,
 *   so there is nothing to replay; running today's tree and calling it the
 *   same run would be the substitution the whole design forbids.
 * - A CHECKOUT THAT IS GONE cannot host the replay. The refusal names the
 *   path, because "clone it back to here" is the actual fix and the caller
 *   cannot guess the path from an error that omits it.
 */
async function relaunch(
  handle: RunHandle,
  manifest: RunManifest,
  input: RetryInput,
  runId: string,
  catalog: CatalogOptions,
  onDispatch?: () => void,
): Promise<{ ok: true; receipt: RetryReceipt } | { ok: false; message: string; suggestion?: string[] }> {
  if (!manifest.snapshot.retryable) {
    return {
      ok: false,
      message:
        `odu: run ${handle.runId} cannot be replayed — it ran a ` +
        `${manifest.snapshot.dirty ? "dirty working tree" : "live working tree"}, ` +
        "whose inputs were never committed. Its logs are still readable; start a " +
        "new run against a commit instead.",
      suggestion: ["odu", "run", ...manifest.scope.selectors],
    };
  }
  if (!existsSync(manifest.repoRoot)) {
    return {
      ok: false,
      message:
        `odu: run ${handle.runId} was started in ${manifest.repoRoot}, which is gone — ` +
        "a replay has to run where the run ran. Its logs are still readable.",
      suggestion: ["odu", "logs", "--run", handle.runId, input.selector],
    };
  }
  // The SELECTION the new run covers: the nodes asked for, with their
  // dependency closure (odu expands dependencies unless told not to). Recorded
  // platforms and root are carried through so the replay lands on the same
  // lanes; `noDeps` is deliberately NOT carried — a replay of one node needs
  // what that node needs, and a parent that skipped dependencies did not run
  // them for this child either.
  const scope: RunScope = {
    selectors: [input.selector],
    platforms: [...manifest.scope.platforms],
    ...(manifest.scope.root === undefined ? {} : { root: manifest.scope.root }),
    noDeps: false,
  };
  const request: LaunchRequest = {
    checkout: manifest.repoRoot,
    runId,
    parentRunId: handle.runId,
    requestId: input.requestId ?? null,
    scope,
    expectedSha: manifest.sha,
    noStrict: manifest.snapshot.mode === "live",
    noSnapshot: manifest.snapshot.mode === "live",
    // Posting is a property of the ORIGINAL run's intent, and the manifest does
    // not record it. A replay does not post: a selection's statuses would
    // overwrite the full run's contexts with a partial verdict, which is
    // exactly the "a passing selection implies a passing pipeline" confusion
    // this policy refuses elsewhere.
    noPost: true,
    hostPins: [],
  };
  // A LAUNCH IS A DISPATCH. Marked before the launcher is entered, for the same
  // reason the live path marks before its rerun call: from here on, a lost
  // answer and "nothing happened" stop being the same thing. A launcher that is
  // still running has not published a manifest yet, and reading that absence as
  // proof of no spawn is what let a repeat be told to use a fresh id while the
  // original launch was in flight — two coordinators for one request.
  onDispatch?.();
  const receiptOfLaunch = await input.launcher(request);
  if (!receiptOfLaunch.ok) {
    return {
      ok: false,
      message: `odu: could not start the replay run — ${receiptOfLaunch.error ?? "unknown error"}`,
      suggestion: ["odu", "run", ...scope.selectors],
    };
  }
  // The child registers itself; read back what it published so the receipt
  // describes the run that exists rather than the one we asked for.
  const child = handleFor(runId, catalog);
  const childManifest = readManifest(child);
  return {
    ok: true,
    receipt: {
      request_id: input.requestId ?? null,
      mode: "relaunched",
      effective_run: runId,
      parent_run: handle.runId,
      roots: [input.selector],
      reset_dependants: [],
      attempts: [],
      scope: childManifest?.scope ?? scope,
      sha: manifest.sha,
      cursor: formatCursor({ runId, seq: 0 }),
      ...(receiptOfLaunch.lifetime === undefined
        ? {}
        : { lifetime: receiptOfLaunch.lifetime }),
    },
  };
}

/** Has this run finalized? Read by faces that want to explain which path a
 *  retry would take BEFORE asking for one — never by the policy itself, which
 *  attempts rather than predicts (see the header). */
export function isFinalized(handle: RunHandle): boolean {
  return readVerdict(handle) !== null || readExpiry(handle) !== null;
}

/** Re-exported so a caller can read a recorded receipt without learning a
 *  second import path for the one concept. */
export { readReceipt };
