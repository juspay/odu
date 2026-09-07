/**
 * `run.wait` — bounded, resumable attention on one run.
 *
 * The whole answer already exists: PR 1's attention query folds a run's journal
 * into "what is red, is it settled, and where should you resume from", and
 * `odu wait --run` has been serving it from a terminal since. This module does
 * NOT compute a second one. It resolves the caller's run and cursor, hands both
 * to `waitForAttention`, and re-shapes the payload into the service's wire
 * vocabulary — which is a rename, not a derivation.
 *
 * That is the point rather than a shortcut. The acceptance gate says the same
 * run must look the same through every face, and the only way that is true is
 * if there is one fold under all of them. A service that re-derived
 * `actionable` would eventually disagree with `odu wait --run` about whether a
 * run had something to act on, and the disagreement would surface as a
 * developer and their agent arguing about a red node.
 *
 * **A red CI answer is a SUCCESS.** `reason: "failure"` travels on the output
 * channel, exits 0 through the CLI, and is a normal tool result to an agent.
 * Only a refusal — a cursor from another run, a run that does not exist — is a
 * declared error. Confusing the two is how "your tests failed" becomes "the
 * tool is broken".
 */

import { EXCERPT_BUDGET_BYTES } from "@odu/run-history/attention";
import {
  DEFAULT_ATTENTION_DEADLINE_MS,
  resolveCursor,
  waitForAttention,
} from "@odu/run-history/query";
import type { Attention } from "@odu/run-history/attention";
import { type CatalogOptions, handleFor, readManifest, readExpiry } from "@odu/run-history/store";
import { formatLogKey } from "@odu/service-client/logKey";
import {
  type AttentionAnswer,
  ServiceRefused,
  type WaitInput,
} from "@odu/service-client/surface";
import { Effect } from "effect";

export interface WaitDeps {
  catalog?: CatalogOptions;
  /** A caller's own cancellation — an HTTP disconnect, an MCP cancellation, a
   *  CLI Ctrl-C. It ends the OBSERVATION and nothing else: the run keeps going,
   *  because watching a run and running it are different acts and only one of
   *  them was cancelled. */
  signal?: AbortSignal;
}

/**
 * Re-shape the catalog's attention payload as this surface's answer.
 *
 * Every field is a rename or a re-address; nothing is recomputed. The one thing
 * that IS built here is `logKey`: the attention payload spells its `log_key` as
 * the argv triple `odu logs --run` takes, and this surface addresses a log by
 * one token, so the same three facts are re-encoded for the face that will echo
 * them back.
 */
export function answerOf(attention: Attention): AttentionAnswer {
  return {
    runId: attention.run.id,
    reason: reasonOf(attention),
    settled: attention.settled,
    passed: attention.passed,
    outcome: attention.outcome,
    actionable: attention.actionable,
    sha: attention.run.sha,
    scope: attention.scope,
    failures: attention.unresolved_failures.map((failure) => ({
      node: failure.node,
      attempt: failure.attempt,
      status: failure.status,
      exitCode: failure.exit_code,
      signal: failure.signal,
      platform: failure.placement.platform,
      host: failure.placement.host,
      logKey: formatLogKey({
        runId: attention.run.id,
        node: failure.node,
        attempt: failure.attempt,
      }),
      logComplete: failure.log_complete,
      logBytes: failure.log_bytes,
      excerpt: failure.excerpt,
      excerptSource: failure.excerpt_source,
      excerptTruncated: failure.excerpt_truncated,
    })),
    failuresTotal: attention.unresolved_failures_total,
    failuresOmitted: attention.failures_omitted,
    cursor: attention.cursor,
    remaining: attention.remaining,
    hasMore: attention.has_more,
    unreadableEvents: attention.unreadable_events,
    overBudget: attention.over_budget,
    reportingDebt: attention.reporting_debt.map((row) => ({
      context: row.context,
      lastError: row.last_error,
      attempts: row.attempts,
    })),
    endpoint: attention.endpoint,
  };
}

/**
 * The one word a caller branches on.
 *
 * `owner_lost` is kept as its own reason rather than folded into `failure`,
 * because the recovery differs: a failure is something to fix and retry, a lost
 * owner is a coordinator that is provably gone and never finalized, and the
 * only move is a fresh run. Collapsing them sends an agent looking for a broken
 * test that does not exist.
 */
function reasonOf(attention: Attention): AttentionAnswer["reason"] {
  if (attention.state === "owner_lost") return "owner_lost";
  if (attention.settled) return "settled";
  return attention.actionable ? "failure" : "still_running";
}

export function waitForRun(
  input: WaitInput,
  deps: WaitDeps = {},
): Effect.Effect<AttentionAnswer, ServiceRefused> {
  return Effect.suspend(() => {
    const catalog = deps.catalog ?? {};
    const handle = handleFor(input.runId, catalog);
    // A run this catalog has never heard of, told apart from one whose evidence
    // aged out: the first is a typo or a wrong catalog, the second is a real
    // run that is simply too old, and "start a new one" is right for only one
    // of them.
    if (readManifest(handle) === null) {
      const expiry = readExpiry(handle);
      return Effect.fail(
        new ServiceRefused(
          expiry === null
            ? {
                code: "unknown_run",
                message: `odu: no run ${input.runId} in the catalog`,
                runId: input.runId,
              }
            : {
                code: "expired",
                message:
                  `odu: run ${input.runId} existed and its evidence aged out ` +
                  "— its identity is all that is left",
                runId: input.runId,
              },
        ),
      );
    }
    const cursor = resolveCursor(handle, input.after);
    if (!cursor.ok) {
      return Effect.fail(
        new ServiceRefused({
          code: "bad_cursor",
          message: cursor.message,
          resync: cursor.resync,
          runId: input.runId,
        }),
      );
    }
    return Effect.map(
      // `Effect.callback`, not `Effect.promise`: a promise is UNINTERRUPTIBLE,
      // so a caller that walked away — an HTTP client that disconnected, an MCP
      // request that was cancelled, a browser tab that closed — left this poll
      // running to its full deadline with nobody to answer. Interruption is the
      // signal here, and the finalizer turns it into the abort the poll already
      // knows how to take. The RUN is untouched either way: ending an
      // observation and stopping CI are different acts, and only one of them
      // was asked for.
      Effect.callback<Attention>((resume) => {
        const controller = new AbortController();
        const stop = (): void => controller.abort();
        const outer = deps.signal;
        if (outer !== undefined) {
          if (outer.aborted) stop();
          else outer.addEventListener("abort", stop, { once: true });
        }
        void waitForAttention(handle, {
          after: cursor.cursor,
          deadlineMs: input.deadlineMs ?? DEFAULT_ATTENTION_DEADLINE_MS,
          settle: input.settle ?? false,
          excerptBytes: EXCERPT_BUDGET_BYTES,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          signal: controller.signal,
        }).then(
          (attention) => resume(Effect.succeed(attention)),
          (err: unknown) => resume(Effect.die(err)),
        );
        return Effect.sync(() => {
          controller.abort();
          outer?.removeEventListener("abort", stop);
        });
      }),
      answerOf,
    );
  });
}
