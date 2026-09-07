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
// The reconciliation FOLD moved to `@odu/run-history/reconcile` — it reads a
// receipt and a journal and returns a fact, which is the catalog's business,
// not the policy's. What stays here is everything that ACTS. Re-exported
// because `RetryReceipt` is this policy's published answer shape and callers
// should not have to learn where the fold lives to name it.
export {
  RETRY_DISPATCH_GRACE_MS,
  type Reconciled,
  reconcile,
  type RetryReceipt,
} from "@odu/run-history/reconcile";
import { reconcile, type RetryReceipt } from "@odu/run-history/reconcile";
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
import { splitFanId } from "@odu/run-client/nodeId";
import { formatCursor } from "@odu/run-history/ids";
import { readJournal } from "@odu/run-history/store";
import { foldJournal } from "@odu/run-history/attention";
import { firstFrame, runUnary } from "../common/effectEdge";
import {
  minimalRerunRoots,
  resolveRerunTargets,
  transitiveDependents,
} from "../common/nodeId";
import { fanoutPools, type HostsConfig, loadHosts } from "./hosts";
import type { LaunchRequest, RunLauncher } from "./launcher";
/**
 * WHY a retry was refused, as a value.
 *
 * The message is for a person; this is for a caller that has to DECIDE. They
 * are different jobs and a caller that read the sentence would be parsing prose
 * that exists to be reworded — which is exactly what PR 2's service face did
 * before this field, and what it stopped doing when the classification moved to
 * the module that knows why it refused.
 *
 * The union is deliberately the one `@odu/service`'s `RunRetrier` port names.
 * Two spellings, because the arrow runs cli → execution and the service must
 * not import the engine; the compiler proves them equal where the composition
 * root binds one to the other, which is the only place both are in scope.
 */
export type RetryRefusal =
  | "bad_input"
  | "unknown_run"
  | "not_replayable"
  | "request_conflict"
  | "request_unresolved"
  | "stale_attempt"
  | "partial"
  | "launch_failed"
  /** The parent's recorded placement cannot be expressed against today's
   *  declared inventory. See `relaunch`. */
  | "no_venue"
  /** Retention has expired the run's evidence. Its identity survives; the
   *  journal, attempts and receipts a replay reads do not. */
  | "expired";

export type RetryOutcome =
  | { ok: true; receipt: RetryReceipt; replayed: boolean }
  | {
      ok: false;
      code: RetryRefusal;
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
  /** This host and its pid probe. Reconciliation asks whether the process that
   *  CLAIMED a request id is still capable of dispatching it, so a suite has to
   *  be able to state a world where it is, or is not, without forking. */
  host?: string;
  isAlive?: (pid: number) => boolean;
  /** Today's declared host inventory. Injected so a suite can state a hosts
   *  file that CHANGED since the parent ran — which is the whole scenario a
   *  replay's placement guarantee exists for — without one on disk. */
  hosts?: () => HostsConfig;
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
    return {
      ok: false,
      code: "unknown_run",
      message: `odu: no run ${input.runId} in the catalog`,
    };
  }
  /**
   * AN EXPIRED RUN IS NOT REPLAYABLE, and the reason is what expiry deletes.
   *
   * Retention keeps a run's IDENTITY — manifest, owner, verdict, expiry — and
   * removes its EVIDENCE: attempts, events, receipts, the coordinator log. So
   * an expired run still reads back with a perfectly good manifest, passes the
   * `retryable` gate, passes the `repoRoot` gate, and passes the placement gate
   * because `hostPins` lives on the manifest and survives.
   *
   * What does not survive is the journal — and the journal is exactly what
   * narrows a run whose `scope.platforms` is empty down to the lanes it
   * actually had. `platformsFor` would fold an empty journal, find nothing, and
   * carry `[]` through under the reading "a run that died before publishing
   * anything"; the child then fans out over whatever today's hosts file lists.
   * A month-old run confined to one platform comes back across the fleet, with
   * every guard green.
   *
   * `run.wait` and `run.cancel` already refuse an expired run. This is the
   * third, and it belongs beside them rather than deeper: once the evidence is
   * gone there is nothing further down that can reconstruct it.
   */
  if (readExpiry(handle) !== null) {
    return {
      ok: false,
      code: "expired",
      message:
        `odu: run ${input.runId} has been expired by retention — its manifest ` +
        "survives but the journal a replay reads does not, so odu cannot " +
        "promise the replay would run where it ran. Start a fresh run.",
      suggestion: ["odu", "run", ...manifest.scope.selectors],
    };
  }
  if (input.requestId !== undefined && !isRequestId(input.requestId)) {
    return {
      ok: false,
      code: "bad_input",
      message:
        `odu: "${input.requestId}" is not a usable request id ` +
        "(letters, digits, dot, dash and underscore; 128 chars)",
    };
  }
  /**
   * The optimistic-concurrency guard — refuse unless the named node is on
   * exactly the attempt the caller read.
   *
   * Checked AFTER the receipt is resolved, not before, and the ordering is the
   * whole point. A guarded retry that SUCCEEDS moves the node to the next
   * attempt, so an identical repeat of that same request id — which is exactly
   * what an idempotency key invites, and what a lost reply forces — arrives to
   * find the precondition it already satisfied now false, and was refused
   * against its own effect. The recorded answer is the right one there; the
   * guard is for work not yet accepted. It still binds the request's identity,
   * because `expectAttempt` is in the digest: a repeat naming a DIFFERENT
   * attempt is a different request and is refused as a conflict.
   */
  const guardRefusal = (): RetryOutcome | null => {
    if (input.expectAttempt === undefined) return null;
    const recorded = attemptsFor(handle, input.expectAttempt.node);
    const latest = recorded[recorded.length - 1] ?? 0;
    if (latest === input.expectAttempt.attempt) return null;
    return {
      ok: false,
      code: "stale_attempt",
      message:
        `odu: ${input.expectAttempt.node} is on attempt ${latest}, not ` +
        `${input.expectAttempt.attempt} — this run has moved on since you read it`,
      suggestion: ["odu", "history", "show", "--run", input.runId],
    };
  };
  // No request id means no receipt to replay, so the guard is all there is and
  // it applies at once.
  if (input.requestId === undefined) {
    const refused = guardRefusal();
    if (refused !== null) return refused;
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
    });
    if (claim === null) {
      return {
        ok: false,
        code: "bad_input",
        message: `odu: could not record request ${input.requestId}`,
      };
    }
    if (claim.kind === "conflict") {
      return {
        ok: false,
        code: "request_conflict",
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
        // `undefined` selects the real host and the real pid probe — a default
        // parameter fires on it, so the seam costs no branch here.
        input.host,
        input.isAlive,
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
          code: "request_unresolved",
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
          code: "request_unresolved",
          message:
            `odu: request "${input.requestId}" was accepted and its outcome is UNKNOWN — ` +
            `${reconciled.reason}. Do not repeat it with a fresh id until you have ` +
            "checked whether it took effect: a second retry would be a second mutation.",
          suggestion: ["odu", "history", "show", "--run", input.runId],
        };
      }
      return {
        ok: false,
        code: "request_unresolved",
        message:
          `odu: request "${input.requestId}" was accepted and its outcome is not recorded. ` +
          "No run was started under it, this run's coordinator recorded no acceptance " +
          "for it, and it was never put on the wire — so nothing it asked for happened. " +
          "Retry with a fresh id.",
        suggestion: ["odu", "history", "show", "--run", input.runId],
      };
    }
    // Freshly claimed: this is NEW work, so the precondition applies to it.
    // Recorded through `finish`, like every other refusal, so the next
    // identical ask replays it rather than re-deriving it against a run that
    // has moved further still.
    const refused = guardRefusal();
    if (refused !== null) return finish(handle, input, refused, now);
    claimedRunId = claim.receipt.plannedRunId;
  }

  const requestId = input.requestId;
  /** One marker for both paths — a live rerun and a relaunch are both the
   *  moment this request stops being reversible. */
  const markDispatch =
    requestId === undefined
      ? undefined
      : (roots: readonly string[]) => markDispatched(handle, requestId, roots, now());
  const live = await tryLive(handle, manifest, input, digest, markDispatch, (message) =>
    input.warn?.(message),
  );
  if (live !== null && "partial" in live) {
    return finish(
      handle,
      input,
      {
        ok: false,
        code: "partial",
        message: live.partial,
        suggestion: ["odu", "history", "show", "--run", input.runId],
      },
      now,
    );
  }
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
      : (value as Extract<RetryOutcome, { ok: false }>);
  }
  return {
    ok: false,
    code: "request_unresolved",
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
  onDispatch?: (roots: readonly string[]) => void,
  warn?: (message: string) => void,
  // `null` — the live path declined entirely, so the finalized path is
  // selected. `{ partial }` — it acted, but not on everything it was asked
  // for, which is an ANSWER and must not fall through to a second attempt at
  // the same work.
): Promise<RetryReceipt | { partial: string } | null> {
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
    // The WHOLE root set, before the first one goes out. A reconciler that
    // learned the request's extent from the acceptances written so far would
    // see a prefix while this loop is still running.
    onDispatch?.(roots);
    const accepted: string[] = [];
    let recorded = true;
    for (const id of roots) {
      const result = await runUnary(
        dialed.client.surface.node.rerun({
          id,
          ...(input.requestId === undefined
            ? {}
            : { requestId: input.requestId, inputDigest: digest }),
          // The guard travels with the root it guards. A caller names ONE node
          // and an attempt; only the call for that node carries it, because the
          // coordinator checks it against that node's allocator.
          ...(input.expectAttempt !== undefined && input.expectAttempt.node === id
            ? { expectAttempt: input.expectAttempt.attempt }
            : {}),
        }),
      );
      if (result.refusal === "stale_attempt") {
        // ANSWERED. The node moved past the attempt the caller authorized, so
        // the request is over — it must not fall through to starting a whole
        // new run, which is the one thing the guard exists to prevent.
        return {
          partial:
            `odu: ${id} is on attempt ${result.attempt ?? "another"}, not ` +
            `${input.expectAttempt?.attempt} — this run has moved on since you read it`,
        };
      }
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
    const declined = roots.filter((id) => !accepted.includes(id));
    if (declined.length > 0) {
      // ONE RULE FOR THE WHOLE REQUEST, whichever path answers it. The
      // reconciliation fold already reports a part-applied retry as partial;
      // this path used to collect the roots that succeeded and say nothing
      // about the rest, so the very same lane replies meant "success" when the
      // first reply arrived and "partial" when it was lost and reconstructed.
      // A domain answer that depends on whether a reply was delivered is not a
      // domain answer.
      //
      // A refusal rather than a qualified success, for the reason the fold
      // gives: the request did not do what it was asked, and a caller reading
      // `ok: true` acts as if it did.
      return {
        partial:
          `odu: request applied in part — ${accepted.join(", ")} was re-run, ` +
          `${declined.join(", ")} was declined by its lane. The retry did not do ` +
          "everything it was asked for.",
      };
    }
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
/**
 * The platforms a replay may use — the parent's, PINNED, even when the parent
 * never named any.
 *
 * `scope.platforms: []` does not mean "no platforms". It means "whatever the
 * fanout resolves to", and the fanout resolves against today's hosts file — so
 * a platform added to that file after the parent ran would get the retried
 * selector dispatched onto it, on a run whose id says it is a replay. That is
 * the same widening the host pins exist to stop, arriving by a route no pin
 * covers, and it is reachable without anybody having typed `--host` at all.
 *
 * The parent's real platform set IS durable evidence, from two places, and both
 * are read because neither alone covers every record:
 *
 *   - the ROSTER, whose node ids are `<namepath>@<platform>`. Written at
 *     registration, so it is there for every run that got as far as having a
 *     shape — including ones recorded before odu journalled lanes at all.
 *   - the LANE lines, which cover the platform that had a lane but whose nodes
 *     were all skipped, and so never appeared in a roster id.
 *
 * A journal with neither cannot establish the set — a run that died before
 * publishing anything — and there the empty set is carried through unchanged.
 * That is the lesser evil on purpose: narrowing to nothing would make the child
 * fan out over no platforms and refuse, turning "we cannot prove where this
 * ran" into "this cannot be retried", for a run that very likely used the whole
 * fanout anyway.
 */
function platformsFor(handle: RunHandle, manifest: RunManifest): string[] {
  if (manifest.scope.platforms.length > 0) return [...manifest.scope.platforms];
  const fold = foldJournal(readJournal(handle).entries);
  const platforms = new Set<string>(fold.lanes.keys());
  for (const id of fold.roster) platforms.add(splitFanId(id).platform);
  return [...platforms].sort();
}

async function relaunch(
  handle: RunHandle,
  manifest: RunManifest,
  input: RetryInput,
  runId: string,
  catalog: CatalogOptions,
  onDispatch?: (roots: readonly string[]) => void,
): Promise<{ ok: true; receipt: RetryReceipt } | Extract<RetryOutcome, { ok: false }>> {
  if (!manifest.snapshot.retryable) {
    return {
      ok: false,
      code: "not_replayable",
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
      code: "not_replayable",
      message:
        `odu: run ${handle.runId} was started in ${manifest.repoRoot}, which is gone — ` +
        "a replay has to run where the run ran. Its logs are still readable.",
      suggestion: ["odu", "logs", "--run", handle.runId, input.selector],
    };
  }
  // WHERE the parent was allowed to run, replayed — or refused for want of the
  // evidence to say.
  //
  // A replay reproduces a run, and WHERE a run was allowed to happen is part of
  // what it was. This used to be `hostPins: []`, which is not "no pins were
  // asked for" but "do not carry the question", and the difference only shows
  // when the ambient hosts file has changed since: a parent confined to one box
  // came back fanned out across whatever the file lists today, silently, under
  // a run id that says it is a replay of the confined one.
  //
  // Absent evidence is REFUSED rather than read as an empty pin set. A record
  // written before odu recorded placement cannot distinguish the two, and the
  // failure mode of guessing wrong is unbounded: a retry of a run pinned to one
  // named machine dispatching work onto every machine in the pool.
  if (manifest.hostPins === undefined) {
    return {
      ok: false,
      code: "not_replayable",
      message:
        `odu: run ${handle.runId} predates placement evidence — its record does ` +
        "not say which hosts it was allowed to run on, so a replay cannot " +
        "promise to run where it ran. Start a fresh run, naming the placement " +
        "you want with --host.",
      suggestion: ["odu", "run", ...manifest.scope.selectors],
    };
  }
  const hostPins = [...manifest.hostPins];
  // The SELECTION the new run covers: the nodes asked for, with their
  // dependency closure (odu expands dependencies unless told not to). Recorded
  // platforms and root are carried through so the replay lands on the same
  // lanes; `noDeps` is deliberately NOT carried — a replay of one node needs
  // what that node needs, and a parent that skipped dependencies did not run
  // them for this child either.
  const scope: RunScope = {
    selectors: [input.selector],
    platforms: platformsFor(handle, manifest),
    ...(manifest.scope.root === undefined ? {} : { root: manifest.scope.root }),
    noDeps: false,
  };
  // CAN the recorded constraint still be stated? Not "is the box up" — that is
  // a question only an ssh dial answers, and asking it here would make recovery
  // a second scheduler, which is exactly what the port seam exists to prevent.
  // This asks the cheaper and more useful question: does today's declared
  // inventory still admit the placement this run had? A platform the hosts file
  // no longer configures, or a file that has become unreadable, makes the
  // parent's placement unstateable — and the honest answer is to refuse rather
  // than to launch a child that will resolve to somewhere else.
  //
  // The result is DISCARDED. The child re-resolves from the same inputs (it
  // inherits the daemon's environment, so `$ODU_HOSTS` resolves identically on
  // both sides); what happens here is a check, not a decision. A recovery that
  // picked the lanes would be the second scheduler by another route.
  try {
    fanoutPools((input.hosts ?? loadHosts)(), hostPins, scope.platforms);
  } catch (err) {
    return {
      ok: false,
      code: "no_venue",
      message:
        `odu: run ${handle.runId} cannot be replayed where it ran — ` +
        `${(err as Error).message}`,
      suggestion: ["odu", "hosts"],
    };
  }
  const request: LaunchRequest = {
    checkout: manifest.repoRoot,
    // The child publishes into the SAME catalog as its parent — otherwise a
    // relaunch under an injected root writes its coordinator log into the
    // ambient one, where the run it belongs to does not exist.
    catalog,
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
    // The parent's own constraint, verbatim. Carried for the same reason
    // `scope.platforms` is: a replay that resolved placement afresh would be a
    // different run wearing the same lineage.
    hostPins,
    // A REPLAY never takes a checkout from whatever is running there now. The
    // run it replays has finalized; the thing occupying that checkout is
    // somebody else's, and the honest answer is the coordinator's ordinary
    // busy-checkout refusal rather than a silent eviction.
    supersede: false,
  };
  // A LAUNCH IS A DISPATCH. Marked before the launcher is entered, for the same
  // reason the live path marks before its rerun call: from here on, a lost
  // answer and "nothing happened" stop being the same thing. A launcher that is
  // still running has not published a manifest yet, and reading that absence as
  // proof of no spawn is what let a repeat be told to use a fresh id while the
  // original launch was in flight — two coordinators for one request.
  // A relaunch acts on the run as a whole rather than on roots, so the
  // intended set is the selection it was asked for.
  onDispatch?.([...scope.selectors]);
  const receiptOfLaunch = await input.launcher(request);
  if (!receiptOfLaunch.ok) {
    return {
      ok: false,
      code: "launch_failed",
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


/** Re-exported so a caller can read a recorded receipt without learning a
 *  second import path for the one concept. */
export { readReceipt };
