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
export type RetryRefusal =
  | "bad_input"
  | "unknown_run"
  | "not_replayable"
  | "request_conflict"
  | "request_unresolved"
  | "stale_attempt"
  | "partial"
  | "launch_failed"
  | "no_venue"
  | "expired";

export type RetryOutcome =
  | { ok: true; receipt: RetryReceipt; replayed: boolean }
  | {
      ok: false;
      code: RetryRefusal;
      message: string;
      suggestion?: string[];
    };

export interface RetryInput {
  runId: string;
  selector: string;
  requestId?: string;
  expectAttempt?: { node: string; attempt: number };
  catalog?: CatalogOptions;
  launcher: RunLauncher;
  dial?: typeof dialRun;
  host?: string;
  isAlive?: (pid: number) => boolean;
  hosts?: () => HostsConfig;
  warn?: (message: string) => void;
  now?: () => number;
}

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
  if (readExpiry(handle) !== null) {
    return {
      ok: false,
      code: "expired",
      message:
        `odu: run ${input.runId} has been expired by retention — its manifest ` +
        "survives but the journal a replay reads does not, so odu cannot " +
        "promise the replay would run where it ran. Start a fresh run.",
      suggestion: ["odu", "ci", "run", ...manifest.scope.selectors],
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
      suggestion: ["odu", "ci", "history", "show", "--run", input.runId],
    };
  };
  if (input.requestId === undefined) {
    const refused = guardRefusal();
    if (refused !== null) return refused;
  }

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
      return replayOf(claim.receipt.result);
    }
    if (claim.kind === "in_flight") {
      const reconciled = reconcile(
        input.requestId,
        claim.receipt,
        handle,
        catalog,
        now(),
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
        const outcome: RetryOutcome = {
          ok: false,
          code: "request_unresolved",
          message: reconciled.message,
          suggestion: ["odu", "ci", "history", "show", "--run", input.runId],
        };
        completeReceipt(handle, input.requestId, outcome, now());
        return outcome;
      }
      if (reconciled.kind === "unresolved") {
        return {
          ok: false,
          code: "request_unresolved",
          message:
            `odu: request "${input.requestId}" was accepted and its outcome is UNKNOWN — ` +
            `${reconciled.reason}. Do not repeat it with a fresh id until you have ` +
            "checked whether it took effect: a second retry would be a second mutation.",
          suggestion: ["odu", "ci", "history", "show", "--run", input.runId],
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
        suggestion: ["odu", "ci", "history", "show", "--run", input.runId],
      };
    }
    const refused = guardRefusal();
    if (refused !== null) return finish(handle, input, refused, now);
    claimedRunId = claim.receipt.plannedRunId;
  }

  const requestId = input.requestId;
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
        suggestion: ["odu", "ci", "history", "show", "--run", input.runId],
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
async function tryLive(
  handle: RunHandle,
  manifest: RunManifest,
  input: RetryInput,
  digest: string,
  onDispatch?: (roots: readonly string[]) => void,
  warn?: (message: string) => void,
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
      return null;
    }
    const roots = minimalRerunRoots(state, targets);
    if (roots.length === 0) return null;
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
          ...(input.expectAttempt !== undefined && input.expectAttempt.node === id
            ? { expectAttempt: input.expectAttempt.attempt }
            : {}),
        }),
      );
      if (result.refusal === "stale_attempt") {
        return {
          partial:
            `odu: ${id} is on attempt ${result.attempt ?? "another"}, not ` +
            `${input.expectAttempt?.attempt} — this run has moved on since you read it`,
        };
      }
      if (result.ok) {
        accepted.push(id);
        if (result.recorded !== true) recorded = false;
      }
    }
    if (accepted.length === 0) return null;
    const declined = roots.filter((id) => !accepted.includes(id));
    if (declined.length > 0) {
      return {
        partial:
          `odu: request applied in part — ${accepted.join(", ")} was re-run, ` +
          `${declined.join(", ")} was declined by its lane. The retry did not do ` +
          "everything it was asked for.",
      };
    }
    if (input.requestId !== undefined && !recorded) {
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
        `${manifest.snapshot.contentSha === undefined ? (manifest.snapshot.dirty ? "dirty working tree" : "live working tree") : `working-tree snapshot ${manifest.snapshot.contentSha.slice(0, 7)} of ${manifest.sha.slice(0, 7)}`}, ` +
        (manifest.snapshot.contentSha === undefined
          ? "whose inputs were never committed. Its logs are still readable; start a new run against a commit instead."
          : "which is not replayable. Its logs are still readable; start a new run."),
      suggestion: ["odu", "ci", "run", ...manifest.scope.selectors],
    };
  }
  if (!existsSync(manifest.repoRoot)) {
    return {
      ok: false,
      code: "not_replayable",
      message:
        `odu: run ${handle.runId} was started in ${manifest.repoRoot}, which is gone — ` +
        "a replay has to run where the run ran. Its logs are still readable.",
      suggestion: ["odu", "ci", "logs", "--run", handle.runId, input.selector],
    };
  }
  if (manifest.hostPins === undefined) {
    return {
      ok: false,
      code: "not_replayable",
      message:
        `odu: run ${handle.runId} predates placement evidence — its record does ` +
        "not say which hosts it was allowed to run on, so a replay cannot " +
        "promise to run where it ran. Start a fresh run, naming the placement " +
        "you want with --host.",
      suggestion: ["odu", "ci", "run", ...manifest.scope.selectors],
    };
  }
  const hostPins = [...manifest.hostPins];
  if (manifest.hostsFile === undefined) {
    return {
      ok: false,
      code: "not_replayable",
      message:
        `odu: run ${handle.runId} predates inventory evidence — its record does ` +
        "not say which hosts file it resolved placement against, so a replay " +
        "cannot promise to run where it ran. Start a fresh run.",
      suggestion: ["odu", "ci", "run", ...manifest.scope.selectors],
    };
  }
  const hostsFile = manifest.hostsFile;
  const scope: RunScope = {
    selectors: [input.selector],
    platforms: platformsFor(handle, manifest),
    ...(manifest.scope.root === undefined ? {} : { root: manifest.scope.root }),
    noDeps: false,
  };
  try {
    fanoutPools(
      (input.hosts ?? (() => loadHosts(hostsFile)))(),
      hostPins,
      scope.platforms,
    );
  } catch (err) {
    return {
      ok: false,
      code: "no_venue",
      message:
        `odu: run ${handle.runId} cannot be replayed where it ran — ` +
        `${(err as Error).message}`,
      suggestion: ["odu", "ci", "hosts"],
    };
  }
  const request: LaunchRequest = {
    checkout: manifest.repoRoot,
    catalog,
    runId,
    parentRunId: handle.runId,
    requestId: input.requestId ?? null,
    scope,
    expectedSha: manifest.sha,
    noStrict: manifest.snapshot.mode === "live",
    noSnapshot: manifest.snapshot.mode === "live",
    noPost: true,
    hostPins,
    hostsFile,
    actor: manifest.actor ?? null,
    supersede: false,
    linger: false,
    push: null,
    pushSkipped: null,
    pushKeyWarning: null,
    checkoutMoved: null,
  };
  onDispatch?.([...scope.selectors]);
  const receiptOfLaunch = await input.launcher(request);
  if (!receiptOfLaunch.ok) {
    return {
      ok: false,
      code: "launch_failed",
      message: `odu: could not start the replay run — ${receiptOfLaunch.error ?? "unknown error"}`,
      suggestion: ["odu", "ci", "run", ...scope.selectors],
    };
  }
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

export { readReceipt };
