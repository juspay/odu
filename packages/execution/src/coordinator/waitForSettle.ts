import { dirname } from "node:path";
import { STREAM_RETRY_DELAY_MS } from "@kolu/surface/client";
import { isDeadTransportError } from "@kolu/surface/errors";
import type { OwedStatus } from "@odu/run-client/surface";
import { SOCKET_PATH } from "@odu/run-client/dial";
import { deadRun, describeDeadRun } from "@odu/run-client/deadRun";
import { agentSummary, NON_TERMINAL_STATUSES } from "../common/verdict";
import { subscribe } from "../common/effectEdge";
import { gitRunContext } from "../common/git";
import {
  formatRef,
  liftUnposted,
  type RunRecord,
} from "@odu/run-history/legacy/record";
import { readRunRecord } from "@odu/run-history/legacy/ledger";
import { noRunInProgressMessage } from "../coordinator/socket";
import {
  type AgentNodes,
  type AgentNodesReader,
  EMPTY_NODES,
  type ResolveRunContext,
} from "../common/agentNodes";

/** The loud refusal `wait_for_settle` raises instead of returning a semantically
 *  empty verdict: no run is live in this checkout, or the live run's commit
 *  doesn't match the caller's `expected_sha`. */
export class NoLiveRunError extends Error {}

export interface SettleVerdict {
  /** Every node reached a terminal state within the timeout. */
  settled: boolean;
  /** Settled with no red node *and* no operator-cancelled node. `false` while
   *  a red node exists, any node is `cancelled` (juspay/odu#68), or on timeout. */
  passed: boolean;
  failed: string[];
  errored: string[];
  /** Nodes the operator cancelled mid-run (status `cancelled`); never red,
   *  but a non-empty list means the run is not a clean pass. */
  cancelled_nodes: string[];
  /** Returned early because a node went red (fail-fast), before the slow
   *  lanes finished. */
  fail_fast_tripped: boolean;
  timed_out: boolean;
  /** The caller cancelled the wait (the MCP request was cancelled) before the
   *  run settled or timed out. */
  cancelled: boolean;
  duration_ms: number;
  /** The run this verdict describes: `sha7` its 7-char commit, `seq` its
   *  ordinal among runs of that commit (`<sha7>#<seq>`), so a caller can match
   *  the verdict to the run it dispatched rather than a previously-settled one
   *  (juspay/odu#49 ask 2). `seq` is null when no ordinal was reserved — a wait
   *  that observed no run frame, or the rare case the coordinator couldn't
   *  reserve one (the verdict then carries `sha7` but no unique `<sha7>#<seq>`). */
  sha7: string;
  seq: number | null;
  /** Full owed GitHub status rows not yet confirmed (juspay/odu#61).
   *  Reporting debt does not block settle — the test verdict stays the truth. */
  unposted: readonly OwedStatus[];
}

export interface WaitOptions {
  client: AgentNodesReader;
  timeoutMs?: number;
  /** Return the instant a node goes red, rather than waiting for the whole
   *  run to settle (default true — the "e2e failed, drill in now" loop). */
  failFast?: boolean;
  /** Refuse loudly unless the live run's `sha7` prefix-matches this (the tool's
   *  `expected_sha`, juspay/odu#49 ask 3). Undefined skips the check. */
  expectedSha?: string;
  /** Socket path cited in loud no-run refusals (tests / non-default sockets).
   *  Defaults to the checkout's `.ci/odu.sock`. */
  socketPath?: string;
  /** Caller cancellation (MCP request cancelled): aborts the read loop and
   *  returns the cancelled verdict promptly. */
  signal?: AbortSignal;
  /** Injected clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Where am I checked out — the SAME injection seam the projection's durable
   *  log reads its identity through (`agentSurface.ResolveRunContext`), so the
   *  tool doesn't probe the process's git itself and tests drive the shipping
   *  code path rather than a second, differently-shaped stub. Defaults to
   *  `gitRunContext`, exactly as `mcp.ts` already does for the projection. */
  resolveRunContext?: ResolveRunContext;
}

/** The finalized record for `sha7#seq`, read from this checkout's ledger — one
 *  addressed file read, not a scan of every run of every commit. The
 *  coordinator writes it as it exits, so it is the authority on a run whose
 *  socket is already gone. */
function ledgerRecord(
  resolve: ResolveRunContext,
  sha7: string,
  seq: number | null,
): RunRecord | null {
  if (seq === null) return null;
  const ctx = resolve();
  return ctx === null ? null : readRunRecord(ctx.repoRoot, sha7, seq);
}

function recordVerdict(rec: RunRecord | null): {
  passed: boolean;
  failed: string[];
  errored: string[];
  unposted: readonly OwedStatus[];
} | null {
  if (rec === null) return null;
  if (rec.outcome !== "passed" && rec.outcome !== "failed") return null;
  const failed = rec.nodes.filter((n) => n.status === "failed").map((n) => n.id);
  const errored = rec.nodes
    .filter((n) => n.status === "errored")
    .map((n) => n.id);
  if (rec.nodes.some((n) => NON_TERMINAL_STATUSES.has(n.status))) return null;
  if (rec.nodes.some((n) => n.status === "cancelled")) return null;
  const red = failed.length + errored.length;
  if (rec.outcome === "passed" && red > 0) return null;
  if (rec.outcome === "failed" && red === 0) return null;
  return {
    passed: rec.outcome === "passed",
    failed,
    errored,
    unposted: liftUnposted(rec.unposted ?? []),
  };
}

function identityOf(
  snap: AgentNodes | undefined,
): Pick<SettleVerdict, "sha7" | "seq"> {
  const frame = snap ?? EMPTY_NODES;
  return { sha7: frame.sha7, seq: frame.seq };
}

function debtOf(snap: AgentNodes | undefined): readonly OwedStatus[] {
  return (snap ?? EMPTY_NODES).unposted ?? [];
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });
}

function shaMatches(observed: string, expected: string): boolean {
  if (observed === "" || expected === "") return false;
  const o = observed.toLowerCase();
  const e = expected.toLowerCase();
  return o.startsWith(e) || e.startsWith(o);
}

export async function waitForSettle(opts: WaitOptions): Promise<SettleVerdict> {
  const failFast = opts.failFast ?? true;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  if (opts.expectedSha !== undefined && opts.expectedSha === "") {
    throw new NoLiveRunError("expected_sha must be a non-empty commit sha");
  }
  // setTimeout's delay is a signed 32-bit int — values above 2^31-1 clamp to
  // ~1ms and would return an instant false timed_out verdict (odu#49 class).
  const MAX_TIMEOUT_MS = 2_147_483_647;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new NoLiveRunError(
      `timeout_ms ${timeoutMs} exceeds the platform timer limit (${MAX_TIMEOUT_MS})`,
    );
  }
  const now = opts.now ?? Date.now;
  const started = now();

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(timeoutMs, MAX_TIMEOUT_MS),
  );
  const onCallerAbort = (): void => controller.abort();
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  let lastLiveRunFrame: AgentNodes | undefined;
  // The abort verdict (timeout vs caller-cancel), reused whether the read loop
  // throws on abort or ends cleanly — B's projected `nodes` stream (over A's
  // `nodes` cell) swallows the abort and ends the iterable rather than
  // rejecting, so both paths must classify an aborted controller as
  // timeout/cancel, not as a settled run.
  const emptyRed = {
    failed: [] as string[],
    errored: [] as string[],
    cancelled: [] as string[],
  };
  const abortedVerdict = (): SettleVerdict => {
    const cancelled = opts.signal?.aborted === true;
    const red =
      lastLiveRunFrame !== undefined ? agentSummary(lastLiveRunFrame) : emptyRed;
    return {
      settled: false,
      passed: false,
      failed: red.failed,
      errored: red.errored,
      cancelled_nodes: red.cancelled,
      fail_fast_tripped: false,
      timed_out: !cancelled,
      cancelled,
      duration_ms: now() - started,
      ...identityOf(lastLiveRunFrame),
      unposted: debtOf(lastLiveRunFrame),
    };
  };

  const streamEndedVerdict = async (): Promise<SettleVerdict> => {
    if (controller.signal.aborted) return abortedVerdict();
    const sock = opts.socketPath ?? SOCKET_PATH;
    if (lastLiveRunFrame === undefined) {
      const dead = await deadRun(dirname(dirname(sock)), { socketPath: sock });
      if (dead !== null) throw new NoLiveRunError(describeDeadRun(dead));
      throw new NoLiveRunError(
        noRunInProgressMessage(sock)
          .replace(/^odu: /, "")
          .trimEnd(),
      );
    }
    const fromRecord = recordVerdict(
      ledgerRecord(
        opts.resolveRunContext ?? gitRunContext,
        lastLiveRunFrame.sha7,
        lastLiveRunFrame.seq,
      ),
    );
    if (fromRecord !== null) {
      return {
        settled: true,
        passed: fromRecord.passed,
        failed: fromRecord.failed,
        errored: fromRecord.errored,
        cancelled_nodes: [],
        fail_fast_tripped: false,
        timed_out: false,
        cancelled: false,
        duration_ms: now() - started,
        ...identityOf(lastLiveRunFrame),
        unposted: fromRecord.unposted,
      };
    }
    const dead = await deadRun(dirname(dirname(sock)), { socketPath: sock });
    if (dead !== null) throw new NoLiveRunError(describeDeadRun(dead));
    const red = agentSummary(lastLiveRunFrame);
    return {
      settled: red.done,
      passed:
        red.done &&
        red.failed.length + red.errored.length === 0 &&
        red.cancelled.length === 0,
      failed: red.failed,
      errored: red.errored,
      cancelled_nodes: red.cancelled,
      fail_fast_tripped: false,
      timed_out: false,
      cancelled: false,
      duration_ms: now() - started,
      ...identityOf(lastLiveRunFrame),
      unposted: debtOf(lastLiveRunFrame),
    };
  };

  try {
    for (;;) {
      let delivered = false;
      try {
        // The subscription is the WAIT: a `Stream` registers nothing until it is
        // pulled, so the settle watcher is armed by this loop's first `next()`, not
        // by the call that produced the stream value. `subscribe` wires the
        // controller's abort to closing the subscription (fiber interruption), which
        // is what the `{ signal }` call option used to do — there is no signal on a
        // surface call any more (kolu PLAN D10/#18).
        for await (const snap of subscribe(
          opts.client.surface.nodes.get(undefined),
          controller.signal,
        )) {
          delivered = true;
          if (!snap.run) continue;
          lastLiveRunFrame = snap;
          if (
            opts.expectedSha !== undefined &&
            !shaMatches(snap.sha7, opts.expectedSha)
          ) {
            throw new NoLiveRunError(
              `no live run matching ${opts.expectedSha} (this checkout is running ${formatRef(snap.sha7, snap.seq)})`,
            );
          }
          const { done, failed, errored, cancelled: cancelledNodes } =
            agentSummary(snap);
          if (failFast && failed.length + errored.length > 0) {
            return {
              settled: done,
              passed: false,
              failed,
              errored,
              cancelled_nodes: cancelledNodes,
              fail_fast_tripped: !done,
              timed_out: false,
              cancelled: false,
              duration_ms: now() - started,
              ...identityOf(snap),
              unposted: debtOf(snap),
            };
          }
          if (done) {
            return {
              settled: true,
              passed:
                failed.length + errored.length === 0 && cancelledNodes.length === 0,
              failed,
              errored,
              cancelled_nodes: cancelledNodes,
              fail_fast_tripped: false,
              timed_out: false,
              cancelled: false,
              duration_ms: now() - started,
              ...identityOf(snap),
              unposted: debtOf(snap),
            };
          }
        }
        if (delivered) return await streamEndedVerdict();
        if (controller.signal.aborted) return abortedVerdict();
      } catch (err) {
        // A deliberate loud refusal ALWAYS propagates.
        if (err instanceof NoLiveRunError) throw err;
        if (controller.signal.aborted) return abortedVerdict();
        // Peer process/socket death used to end the async iterator cleanly; the
        // surface fails it instead. The discriminant is the error's `_tag`
        // (`SurfaceStdioTransportClosed` / `SurfaceTransportRetired`), read
        // through the shared predicate rather than compared against a magic code
        // string — which also survives a second `effect` module instance, where
        // an `instanceof` would silently stop recognising it.
        if (!isDeadTransportError(err)) throw err;
      }
      if (!delivered) {
        await pause(STREAM_RETRY_DELAY_MS, controller.signal);
        if (controller.signal.aborted) return abortedVerdict();
      }
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}
