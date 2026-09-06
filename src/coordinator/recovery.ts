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

import { dialRun } from "@odu/run-client/dial";
import type { PipelineState } from "@odu/run-client/surface";
import { mintRunId } from "@odu/run-history/ids";
import {
  claimReceipt,
  completeReceipt,
  digestOf,
  isRequestId,
  readReceipt,
} from "@odu/run-history/receipts";
import type { RunManifest, RunScope } from "@odu/run-history/schema";
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
      return {
        ok: true,
        replayed: true,
        receipt: claim.receipt.result as RetryReceipt,
      };
    }
    if (claim.kind === "in_flight") {
      const reconciled = reconcile(handle, claim.receipt.plannedRunId, catalog);
      if (reconciled !== null) {
        const completed = completeReceipt(
          handle,
          input.requestId,
          reconciled,
          now(),
        );
        return {
          ok: true,
          replayed: true,
          receipt: (completed?.result as RetryReceipt) ?? reconciled,
        };
      }
      return {
        ok: false,
        message:
          `odu: request "${input.requestId}" was accepted and its outcome is not recorded; ` +
          "no run was started under it, so nothing was done — retry with a fresh id",
        suggestion: ["odu", "history", "show", "--run", input.runId],
      };
    }
    claimedRunId = claim.receipt.plannedRunId;
  }

  const live = await tryLive(handle, manifest, input);
  if (live !== null) {
    return finish(handle, input, live, now);
  }
  const relaunched = await relaunch(
    handle,
    manifest,
    input,
    claimedRunId,
    catalog,
  );
  if (!relaunched.ok) return relaunched;
  return finish(handle, input, relaunched.receipt, now);
}

/** Record the answer against the request id, when there is one, and hand it
 *  back. One place, so a receipt cannot be written on one path and forgotten
 *  on the other. */
function finish(
  handle: RunHandle,
  input: RetryInput,
  receipt: RetryReceipt,
  now: () => number,
): RetryOutcome {
  if (input.requestId !== undefined) {
    completeReceipt(handle, input.requestId, receipt, now());
  }
  return { ok: true, receipt, replayed: false };
}

/**
 * Did the pre-minted run actually get started?
 *
 * The reconciliation, and the reason a lost reply is not a lost mutation: if a
 * run exists in the catalog under the id the receipt planned, the spawn
 * happened and the answer can be reconstructed from the run itself. If it does
 * not, nothing was started under that id — which is not the same as "nothing
 * happened", because a LIVE retry leaves no run of its own, so the caller is
 * told exactly that rather than being handed a guess.
 */
function reconcile(
  _handle: RunHandle,
  plannedRunId: string,
  catalog: CatalogOptions,
): RetryReceipt | null {
  if (plannedRunId === "") return null;
  const planned = handleFor(plannedRunId, catalog);
  const manifest = readManifest(planned);
  if (manifest === null) return null;
  return {
    request_id: null,
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
 * Try the live path. `null` means the run is not live, or would not take the
 * mutation — which is the SIGNAL that selects the finalized path, not an error.
 *
 * Every refusal from the live coordinator lands here as `null` on purpose. An
 * `ok: false` from `node.rerun` means "I will not do that" — the node is
 * unknown to me, or its lane is gone, or I am shutting down — and every one of
 * those is a reason to fall through to a fresh run rather than a reason to
 * fail the caller's request.
 */
async function tryLive(
  handle: RunHandle,
  manifest: RunManifest,
  input: RetryInput,
): Promise<RetryReceipt | null> {
  const endpoint = manifest.owner.endpoint;
  if (endpoint === null) return null;
  const dial = input.dial ?? dialRun;
  const dialed = await dial(endpoint);
  if (dialed === null) return null;
  try {
    const state = await firstFrame(dialed.client.surface.nodes.get(undefined));
    if (state === undefined || state.order.length === 0) return null;
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
