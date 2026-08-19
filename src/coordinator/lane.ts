/**
 * One platform's lane, coordinator side: provision the runner closure on the
 * host (the ssh session: warm probe → remote-store provisioning → spawn over
 * ssh), configure the run over the surface, and pump node state + logs back.
 *
 * Lanes are **one-shot** (design review): the first link death after attach
 * is terminal — the runner process died with the pipe, taking live state
 * with it, and Phase 1 explicitly defers runner-restart survival. The lane
 * reports `onDead` and the coordinator marks unfinished nodes `errored`
 * rather than letting the session's reconnect loop respawn a fresh idle
 * runner that would silently re-run completed work. Pre-attach, a bounded
 * number of connect attempts (a down host fails fast instead of retrying
 * forever on ssh's exit 255).
 */

import {
  type AgentClient,
  makeSession,
  type SessionState,
  type SshProv,
  sshConnector,
} from "@kolu/surface-remote";
import { endedAfter } from "../common/logTail";
import { SETUP_NAMEPATH } from "../common/nodeId";
import type { TaskSpec } from "../common/spec";
import { runUnary, subscribe } from "../common/effectEdge";
import {
  type LaneClient,
  laneSurface,
  type NodeLogFrame,
  type PipelineState,
} from "../common/surface";
import type { ResolveRunnerDrv } from "./runnerFlake";
import { withTimeout } from "../common/withTimeout";
import { localhostSpawnEnv, pinLaneFace } from "./surfaceRemoteOpts";

const MAX_CONNECT_ATTEMPTS = 3;
const CONNECT_DEADLINE_MS = Number(
  process.env.ODU_LANE_CONNECT_TIMEOUT_MS ?? 30 * 60 * 1000,
);

/** How long a lane may go completely SILENT during the end-of-run log drain
 *  before what it still owes is declared lost. Not a budget for the drain — a
 *  lane with a huge backlog on a slow link keeps every second it needs, because
 *  each frame that lands resets the clock. This bounds only the failure case: a
 *  lane that has stopped talking altogether and will not resume.
 *
 *  It lives HERE, beside `CONNECT_DEADLINE_MS`, because "how long may this
 *  transport be unresponsive before we call it dead" is a property of the ssh
 *  link, not of the DAG the orchestrator runs over it.
 *
 *  Must stay comfortably above the runner's post-exit stdio-close latency
 *  (`TERM_GRACE_MS` in src/runner/reap.ts, 2s): a recipe that backgrounds a
 *  process holding its stdio delays `close` — and so the log's `end` — until
 *  the reaper escalates. Fall below it and a completed node is stamped
 *  truncated, which is exactly the lie that notice exists to prevent. */
const LOG_DRAIN_IDLE_MS = 15_000;

export interface LaneOptions {
  platform: string;
  host: string;
  /** Recipe tasks for this lane — the runner prepends `_ci-setup` itself. */
  tasks: TaskSpec[];
  pipelineName: string;
  /** Fetch source for remote lanes; null when `workspace` is provided. */
  origin: string | null;
  sha: string | null;
  /** Pre-existing checkout (the coordinator's HEAD snapshot) for localhost
   *  lanes; null for remote lanes. */
  workspace: string | null;
  resolveDrvPath: ResolveRunnerDrv;
  /** Provision / lifecycle lines — land in `_ci-setup@<platform>`'s log. */
  onSetupLine: (line: string) => void;
  onNodes: (state: PipelineState) => void;
  onLogFrame: (nodeId: string, frame: NodeLogFrame) => void;
  /** Terminal lane death (never called after `close()`). */
  onDead: (error: string) => void;
}

/** Why a lane stopped owing output, and what it still owes.
 *
 *  The reason is part of the ANSWER because only the lane knows it, and a
 *  caller that has to guess writes the guess into a durable log: a bare list of
 *  unfinished nodes cannot tell "went quiet mid-stream" from "was cancelled out
 *  from under us", and stamping a measured silence that never elapsed makes the
 *  truncation notice itself untrustworthy — which defeats the point of having
 *  one. */
export type LaneDrain =
  /** Every node delivered its log terminal; nothing is owed, and there is no
   *  loss to describe — which is why this arm carries no list at all. */
  | { reason: "complete" }
  /** The lane went silent with output still owed. `idleMs` is the silence that
   *  actually elapsed, carried on the answer so a truncation notice quotes a
   *  measured number instead of the caller re-deriving one. */
  | { reason: "idle"; idleMs: number; undrained: readonly [string, ...string[]] }
  /** The lane was closed or died, so nothing further was ever coming; its own
   *  cancel/death line is already in each affected node's log and is the honest
   *  account of why. No stopwatch ran, so no duration is offered. */
  | { reason: "gone"; undrained: readonly [string, ...string[]] };

export interface Lane {
  readonly platform: string;
  rerun(nodeId: string): Promise<boolean>;
  /** Cancel one lane-local node (pending/running → cancelled). */
  cancel(nodeId: string): Promise<boolean>;
  /**
   * Wait until every node on this lane has streamed its log to completion —
   * i.e. each `nodeLog` subscription has seen the terminal `end` frame — and
   * resolve with the ids of any that did not.
   *
   * A node's status and its output travel on two different streams, and the
   * status one wins: a recipe's last chunks are still in flight through the
   * runner's channel and the stdio wire when its node already reads `ok`. So a
   * run that tears its lanes down the instant the DAG settles throws that
   * backlog away — silently, and worst on exactly the long noisy recipes whose
   * logs you need, because they build the largest backlog. That is the bug in
   * juspay/odu#87, where a 3m42s `e2e` node kept its head and lost its summary.
   *
   * Bounded by SILENCE, not by a wall clock: as long as frames keep arriving
   * the drain keeps waiting, however big the backlog, so a slow link costs
   * time rather than output. `LOG_DRAIN_IDLE_MS` with nothing arriving means
   * the lane has stopped talking and never will — give up and name the nodes,
   * so the caller can mark the truncation in the log instead of leaving it to
   * be discovered. The bound is the lane's own (see the constant): a caller
   * that had to pass it in would have to know the drain is silence-bounded at
   * all, and would then be picking the ssh link's liveness threshold.
   */
  drain(): Promise<LaneDrain>;
  /** Graceful teardown at end of run — never triggers `onDead`. */
  close(): void;
}

export function startLane(opts: LaneOptions): Lane {
  let closed = false;
  let dead = false;
  let attached = false;
  let disconnects = 0;
  /** ONE cancellation scope for every subscription this lane opens — the state
   *  pump and the per-node log taps. Under Effect a subscription is a fiber and
   *  unsubscribing is closing it, so the array of per-stream `AbortController`s
   *  this used to keep has nothing left to distinguish: teardown wants them all
   *  gone at once, and that is exactly one abort. */
  const lifetime = new AbortController();

  const session = makeSession<AgentClient, SshProv>({
    // The ssh connector opens at its first provisioning phase: the arch/warm
    // realise probe (`probing`), advancing to `provisioning` itself only on a
    // cold host.
    initialConnection: "probing",
    // The surface travels as a VALUE now, not a type argument: Effect RPC needs
    // the flat `RpcGroup` to build the wire client, which oRPC could conjure
    // from a type alone. It is also what makes the dialled face and the served
    // group provably the same tag set.
    connectOnce: sshConnector({
      surface: laneSurface,
      host: opts.host,
      binary: "odu-runner",
      resolveDrvPath: opts.resolveDrvPath,
      // Required (kolu#1884 / #1872): localhost arm refuses ambient inherit.
      // Unused on a real ssh host. See surfaceRemoteOpts.localhostSpawnEnv.
      localEnv: localhostSpawnEnv(),
    }),
    label: `host:${opts.host}`,
  });

  /** Every in-flight drain's progress listener. A SET, not a slot: two drains
   *  on one lane are a legal question, and a second must not disarm the first
   *  by overwriting its callback — nothing in `drain`'s type says it is
   *  single-shot, and `--linger` already calls back on every settle. Woken by
   *  each log frame (the liveness signal) and by teardown (the lane going
   *  away), which are the only two things that can change a drain's answer. */
  const logWaiters = new Set<() => void>();
  const wakeDrains = (): void => {
    for (const wake of [...logWaiters]) wake();
  };

  const die = (error: string): void => {
    if (dead || closed) return;
    dead = true;
    opts.onSetupLine(`[odu] lane ${opts.platform} died: ${error}`);
    teardown();
    opts.onDead(error);
  };

  const teardown = (): void => {
    lifetime.abort();
    clearTimeout(deadline);
    session.destroy();
    // A lane going away is an EVENT, not something a drain should discover by
    // polling: whatever it is still owed is never coming now.
    wakeDrains();
  };

  const deadline = setTimeout(() => {
    if (!attached) die(`no runner attach within ${CONNECT_DEADLINE_MS}ms`);
  }, CONNECT_DEADLINE_MS);
  deadline.unref?.();

  let seenProgress = 0;
  session.onState((state: SessionState<SshProv>) => {
    // The session's `log` is CURRENT-episode-scoped (reset on each down→up
    // reconnect), so a shrink means a fresh episode began — rewind the cursor
    // before slicing so a reconnect's early lines aren't skipped.
    if (state.log.length < seenProgress) seenProgress = 0;
    for (const entry of state.log.slice(seenProgress)) {
      opts.onSetupLine(entry.line);
    }
    seenProgress = state.log.length;
    if (closed || dead) return;
    if (state.phase === "failed") {
      die(state.error);
      return;
    }
    if (state.phase === "disconnected") {
      if (attached) {
        // One-shot: the runner died with the pipe; its state is gone.
        die(state.error);
        return;
      }
      disconnects += 1;
      if (disconnects >= MAX_CONNECT_ATTEMPTS) {
        die(
          `could not reach ${opts.host} (${disconnects} attempts): ${state.error}`,
        );
      }
    }
  });

  const pump = async (): Promise<void> => {
    const client = await pinLaneFace(session);

    // First RPC must be cheap (a cold configure would trip the connect
    // watchdog): pump the nodes cell; flip the session to connected on the
    // first frame; configure once, after.
    //
    // Note the laziness this depends on: `nodes.get(...)` only makes a stream
    // VALUE — nothing is dialled until the loop's first pull. Which is the
    // order we want, and the same order the old `await …get()` produced, but
    // for a different reason worth naming.
    let configured = false;
    for await (const state of subscribe(
      client.surface.nodes.get(undefined),
      lifetime.signal,
    )) {
      if (closed || dead) return;
      if (!configured) {
        configured = true;
        attached = true;
        session.markConnected();
        const ack = await runUnary(
          client.surface.run.configure({
            name: opts.pipelineName,
            origin: opts.origin,
            sha: opts.sha,
            workspace: opts.workspace,
            tasks: opts.tasks,
          }),
        );
        if (!ack.ok) {
          die(`configure rejected: ${ack.error ?? "unknown"}`);
          return;
        }
        attachLogs(client);
        continue; // the pre-configure EMPTY_STATE frame carries nothing
      }
      opts.onNodes(state);
    }
    if (!closed && !dead) die("lane state stream ended");
  };

  /** Every node this lane taps a log for — the runner prepends `_ci-setup`
   *  itself, and ends the log of every node it owns, skipped ones included. */
  const loggedIds = [SETUP_NAMEPATH, ...opts.tasks.map((t) => t.id)];
  /** Nodes whose log stream has delivered its terminal `end` frame. */
  const logComplete = new Set<string>();

  const attachLogs = (client: LaneClient): void => {
    for (const id of loggedIds) {
      void (async () => {
        try {
          for await (const frame of subscribe(
            client.surface.nodeLog.get({ id }),
            lifetime.signal,
          )) {
            if (closed || dead) return;
            // Completion is not a latch: a rerun re-opens the node's log, and
            // the snapshot that starts its new output withdraws it again. The
            // table itself is the tail's — this lane tracks a REMOTE log by the
            // same rule the tail applies to a local one, from one definition.
            if (endedAfter(logComplete.has(id), frame)) logComplete.add(id);
            else logComplete.delete(id);
            // Every frame is forwarded, `end` included — the fan-in serves the
            // same three-frame protocol to attach clients, so completion is a
            // fact readers downstream get too, not one this lane keeps.
            opts.onLogFrame(id, frame);
            wakeDrains();
          }
        } catch (err) {
          // A torn-down subscription reports NOTHING: an interruption is not a
          // failure, so `subscribe` ends the loop cleanly rather than throwing.
          // Anything that lands here is the feed genuinely dying, and the lane
          // says so in the node's own log rather than swallowing it.
          if (lifetime.signal.aborted || closed || dead) return;
          opts.onLogFrame(id, {
            kind: "append",
            text: `\n[odu] log stream error: ${(err as Error).message}\n`,
          });
        }
      })();
    }
  };

  void pump().catch((err: unknown) => {
    die((err as Error).message);
  });

  const nodeCall = async (
    op: "rerun" | "cancel",
    nodeId: string,
  ): Promise<boolean> => {
    // `currentClient()` is the liveness-blind "dialing-or-connected" pointer,
    // read here only to avoid opening a dial for a mutation nobody can serve;
    // the typed face is rebuilt off the CURRENT dispatch rather than cached,
    // since a face outlives no reconnect.
    if (session.currentClient() === null) return false;
    try {
      const client = await pinLaneFace(session);
      const result = await runUnary(client.surface.node[op]({ id: nodeId }));
      return result.ok;
    } catch {
      return false;
    }
  };

  /** Nodes still owing output — the drain's remaining work, and its answer. */
  const undrained = (): string[] => loggedIds.filter((id) => !logComplete.has(id));

  /** The drain's answer, built from what the lane actually still owes rather
   *  than from the branch that noticed: a lane that went quiet having
   *  nonetheless delivered every terminal is `complete`, and only a genuinely
   *  non-empty loss can wear a losing reason. The type carries that coupling,
   *  so no consumer has to re-derive "did I actually lose anything". */
  const answer = (reason: "idle" | "gone"): LaneDrain => {
    const [first, ...rest] = undrained();
    if (first === undefined) return { reason: "complete" };
    return reason === "idle"
      ? { reason, idleMs: LOG_DRAIN_IDLE_MS, undrained: [first, ...rest] }
      : { reason, undrained: [first, ...rest] };
  };

  const drain = async (): Promise<LaneDrain> => {
    // A lane that is closed or dead will never send another frame: whatever
    // has not arrived never will, and saying so at once beats idling out.
    if (closed || dead) return answer("gone");
    if (undrained().length === 0) return { reason: "complete" };
    // Three events feeding one combinator: a frame arriving (which may complete
    // the drain, and always restarts the silence clock), the lane going away,
    // and the idle bound expiring. `withTimeout`'s heartbeat is what makes the
    // bound an IDLE one — the same primitive, and the same reason for it, as
    // the lease's cold-host provisioning pin.
    let bump: (() => void) | undefined;
    let arrive: () => void = () => {};
    const nothingMoreIsComing = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const listener = (): void => {
      bump?.();
      // Either every terminal has landed, or the lane went away with output
      // still owed. Which one it was is not this callback's to decide — it is
      // read off what is still owed, once, in `answer`.
      if (undrained().length === 0 || closed || dead) arrive();
    };
    logWaiters.add(listener);
    try {
      await withTimeout(
        nothingMoreIsComing,
        LOG_DRAIN_IDLE_MS,
        `lane ${opts.platform} log drain`,
        {
          heartbeat: (b) => {
            bump = b;
          },
        },
      );
      // The wait ended before the idle bound: a lane that went away mid-drain is
      // `gone`, not silent — the run has its cancel/death narration already and
      // must not be told a stopwatch ran that never did.
      return answer("gone");
    } catch {
      return answer("idle");
    } finally {
      logWaiters.delete(listener);
    }
  };

  return {
    platform: opts.platform,
    rerun: (nodeId) => nodeCall("rerun", nodeId),
    cancel: (nodeId) => nodeCall("cancel", nodeId),
    drain,
    close: (): void => {
      if (closed || dead) return;
      closed = true;
      teardown();
    },
  };
}
