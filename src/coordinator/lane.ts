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
import { localhostSpawnEnv, pinLaneFace } from "./surfaceRemoteOpts";

const MAX_CONNECT_ATTEMPTS = 3;
const CONNECT_DEADLINE_MS = Number(
  process.env.ODU_LANE_CONNECT_TIMEOUT_MS ?? 30 * 60 * 1000,
);

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

export interface Lane {
  readonly platform: string;
  rerun(nodeId: string): Promise<boolean>;
  /** Cancel one lane-local node (pending/running → cancelled). */
  cancel(nodeId: string): Promise<boolean>;
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

  const attachLogs = (client: LaneClient): void => {
    for (const id of [SETUP_NAMEPATH, ...opts.tasks.map((t) => t.id)]) {
      void (async () => {
        try {
          for await (const frame of subscribe(
            client.surface.nodeLog.get({ id }),
            lifetime.signal,
          )) {
            if (closed || dead) return;
            opts.onLogFrame(id, frame);
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

  return {
    platform: opts.platform,
    rerun: (nodeId) => nodeCall("rerun", nodeId),
    cancel: (nodeId) => nodeCall("cancel", nodeId),
    close: (): void => {
      if (closed || dead) return;
      closed = true;
      teardown();
    },
  };
}
