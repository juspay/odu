/**
 * Face-neutral settle-wait core — shared by the MCP `wait_for_settle` tool and
 * the plain-CLI `odu wait` face (same pattern as `coordinator/cancel.ts`).
 *
 * A fail-fast single blocking subscription over the agent-projected `nodes`
 * stream: block and return the verdict the instant a node goes red (fail-fast)
 * or the whole run settles. Host/protocol shells (MCP tool schema, CLI flags)
 * live outside this module and call `waitForSettle`.
 */

import { isDeadTransportError } from "@kolu/surface/client";
import { agentSummary, NON_TERMINAL_STATUSES } from "../cli/render";
import { gitRunContext } from "../common/git";
import { formatRef, type RunRecord } from "../common/runRecord";
import { liftUnposted, type OwedStatus } from "../common/surface";
import { readRunRecord } from "../coordinator/ledger";
import {
  noRunInProgressMessage,
  SOCKET_PATH,
} from "../coordinator/socket";
import {
  type AgentNodes,
  type AgentNodesReader,
  EMPTY_NODES,
  type ResolveRunContext,
} from "../mcp/agentSurface";

/** The loud refusal `wait_for_settle` raises instead of returning a semantically
 *  empty verdict: no run is live in this checkout, or the live run's commit
 *  doesn't match the caller's `expected_sha`. A typed error thrown from the
 *  handler — surface-mcp turns it into a failed `tools/call` carrying this
 *  message (the MCP analog of the CLI's stderr + non-zero exit), so the caller
 *  gets a loud error, never a `settled:false` nothing-verdict it can't tell
 *  apart from a real one (juspay/odu#49). */
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
  unposted: OwedStatus[];
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

/** The verdict a finalized record dictates, or null when the record can't
 *  settle the question. Two ways it can't:
 *
 *  - it is not terminal (`incomplete`) — a run torn down mid-flight, exactly
 *    the half-observed case the caller must not read as green. This also
 *    covers the stale `--linger` drain: the coordinator re-finalizes the
 *    moment a node resumes (run.ts `updateNode`), so a record that describes
 *    a run now back in flight says `incomplete` itself and no clock
 *    comparison is needed to detect it;
 *  - it is missing (the close beat the write, or no ordinal was reserved).
 *
 *  `outcome` is the authority for pass/fail and the node lists are for
 *  reporting only — but a record whose lists contradict its own outcome is no
 *  authority at all, so it settles nothing either (third way, below). That is
 *  `buildRunRecord`'s invariant; `RunRecordSchema` does not enforce it and the
 *  ledger reader is deliberately forgiving of odd files, so this reader states
 *  it rather than trusting a promise made in another module. */
function recordVerdict(rec: RunRecord | null): {
  passed: boolean;
  failed: string[];
  errored: string[];
  unposted: OwedStatus[];
} | null {
  if (rec === null) return null;
  if (rec.outcome !== "passed" && rec.outcome !== "failed") return null;
  const failed = rec.nodes.filter((n) => n.status === "failed").map((n) => n.id);
  const errored = rec.nodes
    .filter((n) => n.status === "errored")
    .map((n) => n.id);
  // `buildRunRecord` derives `outcome` from the nodes, but `RunRecordSchema`
  // cannot express that — it admits any (outcome, statuses) pair, including a
  // torn or hand-written file. So re-derive the whole invariant here and fall
  // back to the stream on ANY contradiction, rather than publishing one as a
  // verdict: every node terminal (a `passed` beside a still-`running` node is
  // exactly the half-observed run this path must never call green), `passed`
  // with no red node, and `failed` with at least one.
  if (rec.nodes.some((n) => NON_TERMINAL_STATUSES.has(n.status))) return null;
  // buildRunRecord never emits passed/failed with cancelled nodes (those are
  // `incomplete`) — refuse a hand-written or torn record that claims otherwise.
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

/** The run this verdict describes — identity ONLY, always from the frame. No
 *  frame reads the no-run sentinel from `EMPTY_NODES`. Kept apart from the
 *  posting debt below because the two answer to different authorities: identity
 *  is always the frame's, debt belongs to whoever answered pass/fail. Spreading
 *  both and overwriting one made the verdict's source depend on object-literal
 *  key order — invisible at the call site, and reverted by any tidy-up. */
function identityOf(
  snap: AgentNodes | undefined,
): Pick<SettleVerdict, "sha7" | "seq"> {
  const frame = snap ?? EMPTY_NODES;
  return { sha7: frame.sha7, seq: frame.seq };
}

/** The posting debt a FRAME reports. A record-sourced verdict uses the
 *  record's instead — see `recordVerdict`. */
function debtOf(snap: AgentNodes | undefined): OwedStatus[] {
  return (snap ?? EMPTY_NODES).unposted ?? [];
}

/** Does the live run's `observed` sha7 satisfy the caller's `expected` sha? A
 *  prefix match either way, case-insensitive, so a 7-char sha7 and a full
 *  40-char sha both match. An empty side never matches (a no-sha frame must not
 *  silently satisfy any expectation). */
function shaMatches(observed: string, expected: string): boolean {
  if (observed === "" || expected === "") return false;
  const o = observed.toLowerCase();
  const e = expected.toLowerCase();
  return o.startsWith(e) || e.startsWith(o);
}

/** A fail-fast single blocking subscription over the live `nodes` stream:
 *  block and return the verdict the instant a node goes red (fail-fast) or the
 *  whole run settles. */
export async function waitForSettle(opts: WaitOptions): Promise<SettleVerdict> {
  const failFast = opts.failFast ?? true;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const now = opts.now ?? Date.now;
  const started = now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Caller cancellation (MCP request cancelled) aborts the same controller so
  // the read loop tears down promptly rather than held until settle/timeout.
  const onCallerAbort = (): void => controller.abort();
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  let last: AgentNodes | undefined;
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
    const red = last !== undefined ? agentSummary(last) : emptyRed;
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
      ...identityOf(last),
      unposted: debtOf(last),
    };
  };

  /** End-of-stream verdict (clean close OR a dead-transport rejection): a live
   *  run that was observed, then the coordinator socket closed. Shared by the
   *  for-await clean exit and the transport-death catch so both paths refuse a
   *  false green the same way. */
  const streamEndedVerdict = (): SettleVerdict => {
    // Loop ended. If our controller is aborted, the stream ended *because* of
    // the timeout/cancel (the projected `nodes` stream swallows abort) — that's
    // an abort verdict, never a settled one.
    if (controller.signal.aborted) return abortedVerdict();
    // The stream ended with no settle and no abort. If we never observed a
    // LIVE run, there is none in this checkout — refuse LOUD, mirroring the
    // CLI (`odu status`), rather than an instant empty verdict a caller can't
    // tell apart from a real one (juspay/odu#49 ask 1).
    if (last === undefined || !last.run) {
      // Strip the `odu: ` prefix + trailing newline — CLI wait re-adds `odu: `,
      // MCP surfaces the body as the tool error message.
      throw new NoLiveRunError(
        noRunInProgressMessage(opts.socketPath ?? SOCKET_PATH)
          .replace(/^odu: /, "")
          .trimEnd(),
      );
    }
    // A live run WAS observed, but the coordinator then closed the socket
    // (crash, interrupt, or a close race) with nodes still pending/running.
    // A settled run normally publishes its terminal frame first; when the
    // close wins that race, the *record* the coordinator finalized on the
    // way out already holds the answer, so read it rather than report a
    // passing run as unsettled. `recordVerdict` decides whether the record
    // may answer at all (a terminal outcome — nothing else).
    const fromRecord = recordVerdict(
      ledgerRecord(opts.resolveRunContext ?? gitRunContext, last.sha7, last.seq),
    );
    if (fromRecord !== null) {
      // One authority supplies every field it knows — pass/fail, the red
      // node lists, and the posting debt it stamped at finalize.
      // incomplete/cancelled records never answer here (recordVerdict null).
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
        ...identityOf(last),
        unposted: fromRecord.unposted,
      };
    }
    // No usable record: fall back to the last snapshot, fail-closed. `settled`
    // only if it was already terminal, and `passed` requires that — a green
    // verdict never comes from a half-observed run.
    const red = agentSummary(last);
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
      ...identityOf(last),
      unposted: debtOf(last),
    };
  };

  try {
    for await (const snap of await opts.client.surface.nodes.get(undefined, {
      signal: controller.signal,
    })) {
      last = snap;
      // The pre-run / no-run snapshot (`run: false`, empty rows) is not a
      // settled verdict — keep waiting for a real run's frames.
      if (!snap.run) continue;
      // A live run whose commit doesn't match what the caller dispatched is
      // refused LOUD, not silently waited on (juspay/odu#49 ask 3).
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
    return streamEndedVerdict();
  } catch (err) {
    // A deliberate loud refusal ALWAYS propagates — never downgrade it to an
    // abort verdict. The `expected_sha`-mismatch throw happens inside the read
    // loop, whose unwinding awaits the async iterator's cleanup; if the timeout
    // fires in that window `controller.signal.aborted` is already true, and
    // without this guard the refusal would be swallowed into a generic
    // `timed_out` verdict — reintroducing the nothing-verdict juspay/odu#49
    // exists to kill.
    if (err instanceof NoLiveRunError) throw err;
    // An abort that surfaces as a rejection (rather than a clean end) is the
    // same timeout/cancel verdict.
    if (controller.signal.aborted) return abortedVerdict();
    // Peer process/socket death used to end the async iterator cleanly; newer
    // @kolu/surface rejects with SURFACE_STDIO_TRANSPORT_CLOSED. Treat that as
    // the same end-of-stream verdict (never a false green, never an uncaught).
    if (isDeadTransportError(err)) return streamEndedVerdict();
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}
