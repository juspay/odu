import {
  type AgentClient,
  makeSession,
  type SessionState,
  type SshProv,
  sshConnector,
} from "@kolu/surface-remote";
import {
  type LogStream,
  logStreamKey,
  SETUP_NAMEPATH,
} from "@odu/run-client/nodeId";
import { type NodeLogFrame, type PipelineState } from "@odu/run-client/surface";
import { absorbSealedLogAppend } from "../common/logTail";
import type { TaskSpec } from "../common/spec";
import { runUnary, subscribe } from "../common/effectEdge";
import { type LaneClient, laneSurface } from "../common/laneSurface";
import type { ResolveRunnerDrv } from "./runnerFlake";
import { withTimeout } from "../common/withTimeout";
import type { LogTarget } from "./nodeLogSink";
import { localhostSpawnEnv, pinLaneFace } from "./surfaceRemoteOpts";

import { uploadSnapshot, type LaneSnapshot } from "./snapshotTransport";

const MAX_CONNECT_ATTEMPTS = 3;
const CONNECT_DEADLINE_MS = Number(
  process.env.ODU_LANE_CONNECT_TIMEOUT_MS ?? 30 * 60 * 1000,
);

const LOG_DRAIN_IDLE_MS = 15_000;

const LOG_DRAIN_CEILING_MS = 30 * 60_000;

export interface LaneOptions {
  platform: string;
  host: string;
  tasks: TaskSpec[];
  pipelineName: string;
  origin: string | null;
  sha: string | null;
  workspace: string | null;
  snapshot?: LaneSnapshot | null;
  resolveDrvPath: ResolveRunnerDrv;
  onSetupLine: (line: string) => void;
  onNodes: (state: PipelineState) => void;
  onLogFrame: (nodeId: string, frame: NodeLogFrame, stream: LogStream) => void;
  onDead: (error: string) => void;
}

export type LaneDrain =
  | { reason: "complete" }
  | { reason: "idle"; idleMs: number; undrained: readonly [string, ...string[]] }
  | { reason: "gone"; undrained: readonly [string, ...string[]] };

export interface Lane {
  readonly platform: string;
  extend(tasks: TaskSpec[]): Promise<boolean>;
  rerun(nodeId: string): Promise<boolean>;
  cancel(nodeId: string): Promise<boolean>;
  drain(): Promise<LaneDrain>;
  close(): void;
}

export function runLaneDeath(
  announce: () => void,
  teardown: () => void,
  onDead: (error: string) => void,
  error: string,
): void {
  try {
    announce();
  } finally {
    try {
      teardown();
    } finally {
      onDead(error);
    }
  }
}

export function reportLogStreamDeath(opts: {
  silenced: boolean;
  transportDown: boolean;
  die: (error: string) => void;
  onLogFrame: (nodeId: string, frame: NodeLogFrame, stream: LogStream) => void;
  target: LogTarget;
  error: unknown;
}): void {
  if (opts.silenced) return;
  const message = (opts.error as Error).message;
  if (opts.transportDown) {
    opts.die(`log stream died (${opts.target.nodeId}): ${message}`);
  }
  try {
    opts.onLogFrame(
      opts.target.nodeId,
      { kind: "append", text: `\n[odu] log stream error: ${message}\n` },
      opts.target.stream,
    );
  } catch (err) {
    absorbSealedLogAppend(err);
  }
}

export function startLane(opts: LaneOptions): Lane {
  let closed = false;
  let dead = false;
  let attached = false;
  let disconnects = 0;
  const lifetime = new AbortController();
  let readyResolve: ((client: LaneClient) => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const ready = new Promise<LaneClient>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void ready.catch(() => {});

  const session = makeSession<AgentClient, SshProv>({
    initialConnection: "probing",
    connectOnce: sshConnector({
      surface: laneSurface,
      host: opts.host,
      binary: "odu-runner",
      resolveDrvPath: opts.resolveDrvPath,
      // Required (kolu#1884 / #1872): localhost arm refuses ambient inherit.
      localEnv: localhostSpawnEnv(),
    }),
    label: `host:${opts.host}`,
  });

  const logWaiters = new Set<() => void>();
  const wakeDrains = (): void => {
    for (const wake of [...logWaiters]) wake();
  };

  const die = (error: string): void => {
    if (dead || closed) return;
    dead = true;
    readyReject?.(new Error(error));
    runLaneDeath(
      () =>
        opts.onSetupLine(`[odu] lane ${opts.platform} died: ${error}`),
      teardown,
      opts.onDead,
      error,
    );
  };

  const teardown = (): void => {
    lifetime.abort();
    clearTimeout(deadline);
    session.destroy();
    wakeDrains();
  };

  const deadline = setTimeout(() => {
    if (!attached) die(`no runner attach within ${CONNECT_DEADLINE_MS}ms`);
  }, CONNECT_DEADLINE_MS);
  deadline.unref?.();

  let seenProgress = 0;
  session.onState((state: SessionState<SshProv>) => {
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
        let bundle = false;
        try {
          if (opts.snapshot != null && opts.workspace === null) {
            bundle = await uploadSnapshot(client.surface, opts.snapshot, opts.origin as string, opts.host, opts.onSetupLine);
          }
        } catch (error) { die(`snapshot upload failed: ${String(error)}`); return; }
        if (closed || dead) return;
        const ack = await runUnary(
          client.surface.run.configure({
            name: opts.pipelineName,
            origin: opts.origin,
            sha: opts.sha,
            workspace: opts.workspace,
            tasks: opts.tasks,
            ...(opts.snapshot == null ? {} : { snapshot: { commit: opts.snapshot.commit, requires: opts.snapshot.requires, bundle } }),
          }),
        );
        if (!ack.ok) {
          die(`configure rejected: ${ack.error ?? "unknown"}`);
          return;
        }
        attachLogs(client);
        readyResolve?.(client);
        continue;
      }
      opts.onNodes(state);
    }
    if (!closed && !dead) die("lane state stream ended");
  };

  const loggedIds = new Set([SETUP_NAMEPATH, ...opts.tasks.map((t) => t.id)]);
  const logComplete = new Set<string>();
  const streamsOf = (id: string): readonly LogStream[] =>
    id === SETUP_NAMEPATH ? ["recipe"] : ["recipe", "push"];

  const attachLog = (client: LaneClient, id: string, stream: LogStream): void => {
    const key = logStreamKey(id, stream);
    void (async () => {
        const frames = subscribe(
          client.surface.nodeLog.get({ id, stream }),
          lifetime.signal,
        );
        for (;;) {
          let next: IteratorResult<NodeLogFrame>;
          try {
            next = await frames.next();
          } catch (err) {
            const phase = session.currentState().phase;
            reportLogStreamDeath({
              silenced: lifetime.signal.aborted || closed || dead,
              transportDown: phase === "disconnected" || phase === "failed",
              die,
              onLogFrame: opts.onLogFrame,
              target: { nodeId: id, stream },
              error: err,
            });
            return;
          }
          if (next.done) return;
          const frame = next.value;
          if (closed || dead) return;
          if (frame.kind === "end") logComplete.add(key);
          else if (frame.kind === "snapshot") logComplete.delete(key);
          try {
            opts.onLogFrame(id, frame, stream);
          } catch (err) {
            absorbSealedLogAppend(err);
          }
          wakeDrains();
        }
    })();
  };

  const attachLogs = (client: LaneClient): void => {
    for (const id of loggedIds) {
      for (const stream of streamsOf(id)) attachLog(client, id, stream);
    }
  };

  const extend = async (tasks: TaskSpec[]): Promise<boolean> => {
    if (closed || dead || tasks.length === 0) return false;
    try {
      const client = await ready;
      const ack = await runUnary(client.surface.run.extend({ tasks }));
      if (!ack.ok) {
        die(`extend rejected: ${ack.error ?? "unknown"}`);
        return false;
      }
      for (const task of tasks) {
        loggedIds.add(task.id);
        for (const stream of streamsOf(task.id)) {
          attachLog(client, task.id, stream);
        }
      }
      return true;
    } catch {
      return false;
    }
  };

  void pump().catch((err: unknown) => {
    die((err as Error).message);
  });

  const nodeCall = async (
    op: "rerun" | "cancel",
    nodeId: string,
  ): Promise<boolean> => {
    if (session.currentClient() === null) return false;
    try {
      const client = await pinLaneFace(session);
      const result = await runUnary(client.surface.node[op]({ id: nodeId }));
      return result.ok;
    } catch {
      return false;
    }
  };

  const undrained = (): string[] =>
    [...loggedIds].filter((id) =>
      streamsOf(id).some((stream) => !logComplete.has(logStreamKey(id, stream))),
    );

  const answer = (reason: "idle" | "gone"): LaneDrain => {
    const [first, ...rest] = undrained();
    if (first === undefined) return { reason: "complete" };
    return reason === "idle"
      ? { reason, idleMs: LOG_DRAIN_IDLE_MS, undrained: [first, ...rest] }
      : { reason, undrained: [first, ...rest] };
  };

  const drain = async (): Promise<LaneDrain> => {
    if (closed || dead || undrained().length === 0) return answer("gone");
    let bump: (() => void) | undefined;
    let arrive: () => void = () => {};
    const nothingMoreIsComing = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const listener = (): void => {
      bump?.();
      if (undrained().length === 0 || closed || dead) arrive();
    };
    logWaiters.add(listener);
    const label = `lane ${opts.platform} log drain`;
    try {
      await withTimeout(nothingMoreIsComing, LOG_DRAIN_IDLE_MS, label, {
        heartbeat: (b) => {
          bump = b;
        },
        ceilingMs: LOG_DRAIN_CEILING_MS,
      });
      return answer("gone");
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith(`odu: ${label}`)) {
        throw e;
      }
      return answer("idle");
    } finally {
      logWaiters.delete(listener);
    }
  };

  return {
    platform: opts.platform,
    extend,
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
