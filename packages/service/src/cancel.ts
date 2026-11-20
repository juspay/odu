import { currentOwner, ownerProvablyAlive } from "@odu/run-history/owner";
import { type CatalogOptions, handleFor, readExpiry, readManifest } from "@odu/run-history/store";
import {
  type CancelInput,
  type CancelResult,
  ServiceRefused,
} from "@odu/service-client/surface";
import { Effect } from "effect";
import type { RunCanceller } from "./ports";
import {
  claimReceipt,
  completeReceipt,
  digestOf,
  isRequestId,
  markDispatched,
  type ReceiptStore,
} from "./requests";

export interface CancelDeps {
  cancel: RunCanceller;
  requests: ReceiptStore;
  catalog?: CatalogOptions;
  now: () => number;
}

const refuse = (
  code: ServiceRefused["code"],
  message: string,
  runId?: string,
): ServiceRefused =>
  new ServiceRefused({ code, message, ...(runId === undefined ? {} : { runId }) });

export function cancelRun(
  input: CancelInput,
  deps: CancelDeps,
): Effect.Effect<CancelResult, ServiceRefused> {
  return Effect.suspend(() => Effect.promise(() => run(input, deps))).pipe(
    Effect.flatMap((outcome) =>
      "refusal" in outcome
        ? Effect.fail(outcome.refusal)
        : Effect.succeed(outcome.result),
    ),
  );
}

export async function stopLiveRun(
  runId: string,
  deps: { cancel: RunCanceller; catalog?: CatalogOptions; now: () => number },
): Promise<
  | { kind: "stopped" }
  | { kind: "declined"; detail: string }
  | { kind: "unresolved"; detail: string }
> {
  const handle = handleFor(runId, deps.catalog ?? {});
  const manifest = readManifest(handle);
  const owner = currentOwner(handle.dir);
  if (manifest === null || owner === null || owner.endpoint === null) {
    return { kind: "stopped" };
  }
  if (ownerProvablyAlive(handle.dir, deps.now()) === false) return { kind: "stopped" };
  const outcome = await deps.cancel({
    endpoint: owner.endpoint,
    runId,
    expect: { sha: manifest.sha, seq: manifest.seq },
    scope: { kind: "run" },
  });
  if (outcome.kind === "cancelled") return { kind: "stopped" };
  return { kind: outcome.kind, detail: outcome.detail };
}

async function run(
  input: CancelInput,
  deps: CancelDeps,
): Promise<{ result: CancelResult } | { refusal: ServiceRefused }> {
  const catalog = deps.catalog ?? {};
  if (!isRequestId(input.requestId)) {
    return {
      refusal: refuse(
        "bad_input",
        `odu: "${input.requestId}" is not a usable request id ` +
          "(letters, digits, dot, dash and underscore; 128 chars)",
        input.runId,
      ),
    };
  }
  const handle = handleFor(input.runId, catalog);
  const manifest = readManifest(handle);
  if (manifest === null) {
    return {
      refusal:
        readExpiry(handle) === null
          ? refuse(
              "unknown_run",
              `odu: no run ${input.runId} in the catalog`,
              input.runId,
            )
          : refuse(
              "expired",
              `odu: run ${input.runId} existed and its evidence aged out`,
              input.runId,
            ),
    };
  }

  const digest = digestOf([
    input.runId,
    input.scope.kind,
    input.scope.kind === "node" ? input.scope.node : "",
    input.scope.kind === "lane" ? input.scope.platform : "",
  ]);
  const claim = claimReceipt(deps.requests, {
    requestId: input.requestId,
    kind: "cancel",
    digest,
    plannedRunId: "",
    now: deps.now(),
  });
  if (claim === null) {
    return {
      refusal: refuse(
        "bad_input",
        `odu: could not record request ${input.requestId}`,
        input.runId,
      ),
    };
  }
  if (claim.kind === "conflict") {
    return {
      refusal: refuse(
        "request_conflict",
        `odu: request id "${input.requestId}" was already used to cancel ` +
          "something else — use a fresh id, or repeat the original request exactly",
        input.runId,
      ),
    };
  }
  if (claim.kind === "replay" || claim.kind === "in_flight") {
    const replayed = replayOf(claim.receipt.result, input.requestId);
    if (replayed !== null) return { result: replayed };
  }

  const owner = currentOwner(handle.dir);
  const alive = ownerProvablyAlive(handle.dir, deps.now());
  if (owner === null || owner.endpoint === null || alive === false) {
    const result: CancelResult = {
      runId: input.runId,
      requestId: input.requestId,
      replayed: false,
      effective: "nothing",
      detail:
        owner === null
          ? "this run has no ownership record — nothing has ever served it"
          : owner.endpoint === null
            ? "this run's coordinator finished and closed its socket"
            : "this run's coordinator is provably gone",
    };
    completeReceipt(deps.requests, input.requestId, result, deps.now());
    return { result };
  }

  markDispatched(deps.requests, input.requestId, [input.scope.kind], deps.now());
  const outcome = await deps.cancel({
    endpoint: owner.endpoint,
    runId: input.runId,
    expect: { sha: manifest.sha, seq: manifest.seq },
    scope: input.scope,
  });
  if (outcome.kind === "unresolved") {
    return {
      refusal: refuse(
        "request_unresolved",
        `odu: the cancel was sent to run ${input.runId}'s coordinator and its ` +
          `outcome is UNKNOWN — ${outcome.detail}. Ask again with the same ` +
          "request id: cancelling twice cancels once.",
        input.runId,
      ),
    };
  }
  const result: CancelResult = {
    runId: input.runId,
    requestId: input.requestId,
    replayed: false,
    effective: outcome.kind === "cancelled" ? input.scope.kind : "nothing",
    detail: outcome.detail,
  };
  completeReceipt(deps.requests, input.requestId, result, deps.now());
  return { result };
}

function replayOf(stored: unknown, requestId: string): CancelResult | null {
  if (stored === null || typeof stored !== "object") return null;
  const value = stored as Partial<CancelResult>;
  if (typeof value.runId !== "string" || typeof value.effective !== "string") {
    return null;
  }
  return { ...(value as CancelResult), requestId, replayed: true };
}
