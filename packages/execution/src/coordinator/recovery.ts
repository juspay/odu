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
  matchNodeIds,
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
        input.selector,
        catalog,
      );
      if (reconciled !== null) {
        const outcome: RetryOutcome = {
          ok: true,
          receipt: reconciled,
          replayed: true,
        };
        completeReceipt(handle, input.requestId, outcome, now());
        return outcome;
      }
      return {
        ok: false,
        message:
          `odu: request "${input.requestId}" was accepted and its outcome is not recorded. ` +
          "No run was started under it and no attempt began on this run since, so " +
          "nothing it asked for happened — retry with a fresh id.",
        suggestion: ["odu", "history", "show", "--run", input.runId],
      };
    }
    claimedRunId = claim.receipt.plannedRunId;
  }

  const live = await tryLive(handle, manifest, input);
  if (live !== null) {
    return finish(handle, input, { ok: true, receipt: live, replayed: false }, now);
  }
  const relaunched = await relaunch(
    handle,
    manifest,
    input,
    claimedRunId,
    catalog,
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
  selector: string,
  catalog: CatalogOptions,
): RetryReceipt | null {
  const relaunched = reconcileRelaunch(requestId, receipt.plannedRunId, catalog);
  if (relaunched !== null) return relaunched;
  return reconcileLive(requestId, receipt, handle, selector);
}

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
 * The live half: a node the selector names started a new attempt after this
 * request was accepted.
 *
 * The roster the selector is matched against comes from the journal, not from
 * a live dial — the run may well have finished since. `matchNodeIds` needs
 * only the id list, so a state carrying the roster and no node bodies answers
 * the same question the live path asked.
 */
function reconcileLive(
  requestId: string,
  receipt: ReceiptRecord,
  handle: RunHandle,
  selector: string,
): RetryReceipt | null {
  const journal = readJournal(handle);
  const manifest = readManifest(handle);
  if (manifest === null) return null;
  const roster = journal.entries.reduce<string[]>(
    (order, e) => (e.event.kind === "roster" ? [...e.event.order] : order),
    [],
  );
  const named = new Set(matchNodeIds({ order: roster, nodes: {} }, selector));
  const started = journal.entries.filter(
    (e) =>
      e.seq > receipt.journalAtAccept &&
      e.event.kind === "attempt_started" &&
      named.has(e.event.node),
  );
  if (started.length === 0) return null;
  const roots = [
    ...new Set(
      started.flatMap((e) =>
        e.event.kind === "attempt_started" ? [e.event.node] : [],
      ),
    ),
  ];
  return {
    request_id: requestId,
    mode: "live",
    effective_run: handle.runId,
    parent_run: null,
    roots,
    // Not recorded at the time and not reconstructable now: the dependants a
    // reset cleared are a property of the live DAG, which may have moved on.
    // Empty rather than guessed.
    reset_dependants: [],
    attempts: roots.map((node) => ({
      node,
      attempt: attemptsFor(handle, node).at(-1) ?? 1,
    })),
    scope: manifest.scope,
    sha: manifest.sha,
    cursor: formatCursor({ runId: handle.runId, seq: journal.highestSeq }),
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
    const accepted: string[] = [];
    for (const id of roots) {
      const result = await runUnary(dialed.client.surface.node.rerun({ id }));
      if (result.ok) accepted.push(id);
    }
    if (accepted.length === 0) return null;
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
