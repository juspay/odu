/**
 * `run.cancel` — stop a run, a node, or a lane, and say which.
 *
 * **Cancelling is a DOMAIN act, and it is the only one here.** An HTTP client
 * disconnecting, an MCP request being cancelled and a CLI taking a Ctrl-C all
 * end an OBSERVATION: the caller stops watching, and the run carries on. That
 * asymmetry is deliberate and it is the difference between a tool that is safe
 * to interrupt and one where closing a tab kills CI. Nothing in this module is
 * reachable from a dropped connection; it is reachable only from a call that
 * explicitly asked for it.
 *
 * **The endpoint comes from the ownership record, never from the manifest.**
 * `.ci/odu.sock` is scoped to a CHECKOUT, and a checkout serves one run after
 * another — so dialling the address a finished run registered under would
 * cancel whatever is serving that path NOW, while answering with the id of the
 * run the caller named. The manifest's `registeredBy` is stamped once and never
 * cleared; `owner.json` is the copy a heartbeat refreshes and a clean exit
 * clears, so it is the one that can say "nothing is serving this".
 *
 * **A run with no live coordinator is an ANSWER, not a failure.** There is
 * nothing to stop, the caller is told so with `effective: "nothing"` and the
 * reason, and the exit is a success — because the request was understood and
 * answered. A refusal is for a request odu declines.
 */

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
  if (readManifest(handle) === null) {
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
    // A cancel never creates a run, so there is nothing to pre-mint. The field
    // is required by the receipt record (a retry's whole reconciliation rests
    // on it), and the empty string is what "this request could never have
    // produced a run" looks like — which is also what stops a reconciler
    // looking for one.
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
    // An in-flight cancel whose answer was lost. Unlike a start, re-issuing is
    // SAFE — cancelling twice cancels once — so the honest move is to fall
    // through and ask again rather than to refuse a caller who is trying to
    // stop something.
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
  const outcome = await deps.cancel({ endpoint: owner.endpoint, scope: input.scope });
  const result: CancelResult = {
    runId: input.runId,
    requestId: input.requestId,
    replayed: false,
    // What was ACTUALLY cancelled, echoed rather than assumed. A lane cancel
    // that the coordinator declined (a platform it has no lane for) says
    // `nothing` and why — a cheerful ok there would leave a caller believing it
    // had stopped work that is still running.
    effective: outcome.ok ? input.scope.kind : "nothing",
    detail: outcome.detail,
  };
  completeReceipt(deps.requests, input.requestId, result, deps.now());
  return { result };
}

/** Rebuild a recorded answer, or `null` when this build cannot read it. */
function replayOf(stored: unknown, requestId: string): CancelResult | null {
  if (stored === null || typeof stored !== "object") return null;
  const value = stored as Partial<CancelResult>;
  if (typeof value.runId !== "string" || typeof value.effective !== "string") {
    return null;
  }
  return { ...(value as CancelResult), requestId, replayed: true };
}
