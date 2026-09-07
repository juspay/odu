/**
 * `run.retry` — a live attempt or a linked replay, and odu decides which.
 *
 * The decision is NOT this module's and NOT the caller's: whether "run that
 * again" means resetting a node on a coordinator that is still up or starting a
 * fresh run from the recorded inputs is a fact about the run, and a caller that
 * chose would choose wrongly. So the policy lives behind a port (`./ports`'s
 * `RunRetrier`, bound at the root to `@odu/execution`'s retry policy) and this
 * module does the two things the SERVICE owns: refuse what cannot be a request,
 * and re-shape the receipt into the wire's vocabulary.
 *
 * The re-shape is where `mode` earns its place. A caller that asked about run A
 * and got a receipt for run B — because A had finalized and the retry started a
 * linked replay — must watch B from here on. `effectiveRun` is that answer, and
 * `parentRun` is what it replays. A caller that kept its old cursor is holding a
 * token for A, which is exactly the case `run.wait`'s cursor refusal exists to
 * catch.
 */

import type { CatalogOptions } from "@odu/run-history/store";
import {
  type RetryInput,
  type RetryReceipt,
  ServiceRefused,
} from "@odu/service-client/surface";
import { Effect } from "effect";
import { isRequestId } from "./requests";
import type { RetryOutcome, RetryRefusal, RunRetrier } from "./ports";

export interface RetryDeps {
  retry: RunRetrier;
  catalog?: CatalogOptions;
}

/**
 * The port's refusal code, in this surface's vocabulary.
 *
 * A total `Record`, so a code added to the port is a compile error here rather
 * than a silent fall-through to something plausible. Every arm but one is the
 * same word on both sides; `partial` is the one the wire has no name for — a
 * retry that acted on some of its roots and was declined for the rest is a bad
 * request in the sense that matters to a caller (it did not do what it was
 * asked), and the message carries which roots.
 */
const REFUSAL_OF: Record<RetryRefusal, ServiceRefused["code"]> = {
  bad_input: "bad_input",
  unknown_run: "unknown_run",
  not_replayable: "not_replayable",
  request_conflict: "request_conflict",
  request_unresolved: "request_unresolved",
  stale_attempt: "stale_attempt",
  partial: "bad_input",
  launch_failed: "launch_failed",
};

function answerOf(outcome: Extract<RetryOutcome, { ok: true }>): RetryReceipt {
  const receipt = outcome.receipt;
  return {
    requestId: receipt.request_id ?? "",
    mode: receipt.mode,
    replayed: outcome.replayed,
    effectiveRun: receipt.effective_run,
    parentRun: receipt.parent_run,
    roots: [...receipt.roots],
    resetDependants: [...receipt.reset_dependants],
    attempts: receipt.attempts.map((a) => ({ node: a.node, attempt: a.attempt })),
    scope: receipt.scope,
    sha: receipt.sha,
    cursor: receipt.cursor,
    ...(receipt.lifetime === undefined ? {} : { lifetime: receipt.lifetime }),
  };
}

export function retryRun(
  input: RetryInput,
  deps: RetryDeps,
): Effect.Effect<RetryReceipt, ServiceRefused> {
  return Effect.suspend(() => {
    if (!isRequestId(input.requestId)) {
      return Effect.fail(
        new ServiceRefused({
          code: "bad_input",
          message:
            `odu: "${input.requestId}" is not a usable request id ` +
            "(letters, digits, dot, dash and underscore; 128 chars)",
          runId: input.runId,
        }),
      );
    }
    return Effect.flatMap(
      Effect.promise(() =>
        deps.retry({
          runId: input.runId,
          selector: input.selector,
          requestId: input.requestId,
          ...(input.expectAttempt === undefined
            ? {}
            : { expectAttempt: input.expectAttempt }),
          ...(deps.catalog === undefined ? {} : { catalog: deps.catalog }),
        }),
      ),
      (outcome) =>
        outcome.ok
          ? Effect.succeed(answerOf(outcome))
          : Effect.fail(
              new ServiceRefused({
                code: REFUSAL_OF[outcome.code],
                message: outcome.message,
                runId: input.runId,
                ...(outcome.suggestion === undefined
                  ? {}
                  : { suggestion: [...outcome.suggestion] }),
              }),
            ),
    );
  });
}
