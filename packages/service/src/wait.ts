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

export interface ReadDeps {
  catalog?: CatalogOptions;
}

export interface WaitDeps extends ReadDeps {
  signal?: AbortSignal;
}

/** Re-shape the catalog's attention payload as this surface's answer. */
export function answerOf(attention: Attention): AttentionAnswer {
  return {
    runId: attention.run.id,
    reason: reasonOf(attention),
    settled: attention.settled,
    passed: attention.passed,
    outcome: attention.outcome,
    actionable: attention.actionable,
    sha: attention.run.sha,
    dirty: attention.run.dirty,
    ...(attention.run.content_sha == null ? {} : { contentSha: attention.run.content_sha }),
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
    ...(attention.actor === undefined ? {} : { actor: attention.actor }),
    // The payload holds the two counts apart (`stored`, `present`) and the
    // ANSWER has published their sum as `paths` since 2.5. Both go out — the
    // total under the name every existing reader already uses, the
    // already-present half beside it — so a 2.5 client keeps decoding and a
    // 2.6 one can subtract.
    ...(attention.push === undefined
      ? {}
      : {
          push: {
            target: attention.push.target,
            skipped: attention.push.skipped,
            keyWarning: attention.push.keyWarning,
            paths: attention.push.stored + attention.push.present,
            present: attention.push.present,
            bytes: attention.push.bytes,
            failedOn: attention.push.failedOn,
          },
        }),
  };
}

function reasonOf(attention: Attention): AttentionAnswer["reason"] {
  if (attention.state === "owner_lost") return "owner_lost";
  if (attention.settled) return "settled";
  return attention.actionable ? "failure" : "still_running";
}

type Resolution =
  | { ok: true; handle: RunHandle; cursor: Cursor | null }
  | { ok: false; refusal: ServiceRefused };

function resolve(
  runId: string,
  after: string | undefined,
  catalog: CatalogOptions,
): Resolution {
  const handle = handleFor(runId, catalog);
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

/** `run.read` — the same question as `run.wait`, asked without waiting. */
export function readRun(
  input: ReadInput,
  deps: ReadDeps = {},
): Effect.Effect<AttentionAnswer, ServiceRefused> {
  return Effect.suspend(() => {
    const resolved = resolve(input.runId, input.after, deps.catalog ?? {});
    if (!resolved.ok) return Effect.fail(resolved.refusal);
    return Effect.sync(() =>
      answerOf(
        readAttention(resolved.handle, queryOf(resolved.cursor, input.limit)),
      ),
    );
  });
}

export function waitForRun(
  input: WaitInput,
  deps: WaitDeps = {},
): Effect.Effect<AttentionAnswer, ServiceRefused> {
  return Effect.suspend(() => {
    const resolved = resolve(input.runId, input.after, deps.catalog ?? {});
    if (!resolved.ok) return Effect.fail(resolved.refusal);
    const query = queryOf(resolved.cursor, input.limit);
    return Effect.map(
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
