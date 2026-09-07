/**
 * `run.read` and `run.wait` — attention on one run, with and without the wait.
 *
 * TWO VERBS, ONE ANSWER. "What is this run's state" has a single answer shape,
 * and the difference between the two is entirely whether the service holds the
 * call open: they share the resolution (which run, and does this cursor belong
 * to it), the fold, and the re-shaping below. A second shape for the
 * non-blocking case would be a second thing to keep true, and it would go wrong
 * for the caller that alternates between them.
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
  readAttention,
  resolveCursor,
  waitForAttention,
} from "@odu/run-history/query";
import type { Attention, AttentionQuery } from "@odu/run-history/attention";
import type { Cursor } from "@odu/run-history/ids";
import {
  type CatalogOptions,
  handleFor,
  readManifest,
  readExpiry,
  type RunHandle,
} from "@odu/run-history/store";
import { formatLogKey } from "@odu/service-client/logKey";
import {
  type AttentionAnswer,
  type ReadInput,
  ServiceRefused,
  type WaitInput,
} from "@odu/service-client/surface";
import { Effect } from "effect";

/** What a one-shot read needs: a catalog to look in, and nothing else. There is
 *  no `signal` here because there is nothing to interrupt — the read is a fold
 *  over files that are already on disk. */
export interface ReadDeps {
  catalog?: CatalogOptions;
}

export interface WaitDeps extends ReadDeps {
  /**
   * A SECOND route out of the poll, for a caller holding one.
   *
   * Cancelling ends the OBSERVATION and nothing else: the run keeps going,
   * because watching a run and running it are different acts and only one of
   * them was cancelled.
   *
   * **In production nothing passes this, and that is correct rather than an
   * oversight.** A real caller's disconnect — an HTTP client that went away, an
   * MCP cancellation, a browser tab that closed — arrives as an INTERRUPT of
   * the fiber this Effect is running on, and the poll's own finalizer turns
   * that into the abort below. Wiring a signal in as well would be a second
   * path to the same teardown, and the one that could disagree.
   *
   * It stays because a suite has to be able to state "the caller walked away"
   * at a chosen moment without forking a process to interrupt. That is a TEST
   * seam, said plainly, rather than a production knob nobody turns.
   */
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

/**
 * THE SHARED CORE of both reads: which run, from where, and can this caller's
 * cursor be used on it.
 *
 * Every refusal `run.read` and `run.wait` can produce is decided here, once.
 * Two copies of these three checks would be two chances to disagree about
 * whether a cursor belongs to a run — and the pair they would disagree on is
 * exactly the pair a caller alternates between: read to see, wait to follow.
 */
type Resolution =
  | { ok: true; handle: RunHandle; cursor: Cursor | null }
  | { ok: false; refusal: ServiceRefused };

function resolve(
  runId: string,
  after: string | undefined,
  catalog: CatalogOptions,
): Resolution {
  const handle = handleFor(runId, catalog);
  // A run this catalog has never heard of, told apart from one whose evidence
  // aged out: the first is a typo or a wrong catalog, the second is a real
  // run that is simply too old, and "start a new one" is right for only one
  // of them.
  if (readManifest(handle) === null) {
    const expiry = readExpiry(handle);
    return {
      ok: false,
      refusal: new ServiceRefused(
        expiry === null
          ? {
              code: "unknown_run",
              message: `odu: no run ${runId} in the catalog`,
              runId,
            }
          : {
              code: "expired",
              message:
                `odu: run ${runId} existed and its evidence aged out ` +
                "— its identity is all that is left",
              runId,
            },
      ),
    };
  }
  const cursor = resolveCursor(handle, after);
  if (!cursor.ok) {
    return {
      ok: false,
      refusal: new ServiceRefused({
        code: "bad_cursor",
        message: cursor.message,
        resync: cursor.resync,
        runId,
      }),
    };
  }
  return { ok: true, handle, cursor: cursor.cursor };
}

/** The query both reads run, built once from the caller's paging. `limit` is
 *  spread rather than spelled as `undefined`, because the fold reads an absent
 *  limit as "the default page" and a present one as a request. */
function queryOf(
  cursor: Cursor | null,
  limit: number | undefined,
): AttentionQuery {
  return {
    after: cursor,
    excerptBytes: EXCERPT_BUDGET_BYTES,
    ...(limit === undefined ? {} : { limit }),
  };
}

/**
 * `run.read` — the same question as `run.wait`, asked without waiting.
 *
 * ONE ANSWER SHAPE, deliberately: this returns the identical
 * `AttentionAnswer`, because "what is this run's state" has one answer and a
 * second shape for the non-blocking case would be a second thing to keep true.
 * The difference between the two verbs is entirely whether the service holds
 * the call open — the resolution, the fold and the re-shaping are shared, so
 * a run cannot look one way to a reader and another to a follower.
 *
 * This is what `odu history show` is. It used to open the catalog in the
 * caller's own process, beside a daemon reading the same files.
 */
export function readRun(
  input: ReadInput,
  deps: ReadDeps = {},
): Effect.Effect<AttentionAnswer, ServiceRefused> {
  return Effect.suspend(() => {
    const resolved = resolve(input.runId, input.after, deps.catalog ?? {});
    if (!resolved.ok) return Effect.fail(resolved.refusal);
    // `Effect.sync` rather than `Effect.promise`: this is a fold over files
    // that are already on disk, so there is nothing to interrupt and nothing
    // to await.
    return Effect.sync(() =>
      answerOf(
        readAttention(resolved.handle, queryOf(resolved.cursor, input.limit)),
      ),
    );
  });
}

/**
 * `run.wait` — the read above, held open until the run has something to say.
 *
 * The LOOP itself is `waitForAttention`'s, not a second one written here: it is
 * the same `readAttention` this module's one-shot calls, re-run behind a size
 * fingerprint until the answer is worth returning or the deadline lands. A
 * deadline loop spelled at this layer would be a second policy about what
 * "worth returning" means, and the two would diverge on the case that matters —
 * a caller with a cursor, which wakes for new events rather than for the red it
 * has already been shown.
 */
export function waitForRun(
  input: WaitInput,
  deps: WaitDeps = {},
): Effect.Effect<AttentionAnswer, ServiceRefused> {
  return Effect.suspend(() => {
    const resolved = resolve(input.runId, input.after, deps.catalog ?? {});
    if (!resolved.ok) return Effect.fail(resolved.refusal);
    const query = queryOf(resolved.cursor, input.limit);
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
        void waitForAttention(resolved.handle, {
          ...query,
          deadlineMs: input.deadlineMs ?? DEFAULT_ATTENTION_DEADLINE_MS,
          settle: input.settle ?? false,
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
