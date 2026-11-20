import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  implementSurface,
  inMemoryStore,
  type SurfaceHandlers,
} from "@kolu/surface/server";
import { Effect } from "effect";
import type { Rpc, RpcGroup } from "effect/rpc";
import {
  EMPTY_STATE,
  type NodeState,
  type NodeStatus,
  type NodePush,
  pendingNode,
  type PipelineState,
} from "@odu/run-client/surface";
import { logStreamKey, SETUP_NAMEPATH } from "@odu/run-client/nodeId";
import { createLogTail } from "../common/logTail";
import { validatePipeline } from "../common/spec";
import {
  type ConfigureInput,
  type ConfigureOutput,
  laneSurface,
} from "../common/laneSurface";
import {
  agentLeaseLockPath,
  claimLocal,
  type LocalHold,
  probeLocal,
} from "./leaseHold";
import { transitiveDependents } from "../common/nodeId";
import { createGroupReaper } from "./reap";
import { hasSnapshot, narrateSnapshot, prepareWorkspace } from "./workspace";
import { createSnapshotUploads } from "./snapshotUpload";
import { runsOutsideWorkspace } from "../just/ingest";
import { describeFailure } from "@odu/cache/push";
import {
  createLanePusher,
  type LanePusher,
  pushConfigOf,
  PUSH_TOKEN_ENV,
} from "./pushResults";

export const SETUP_NODE_ID = SETUP_NAMEPATH;

export interface LaneRunner {
  group: RpcGroup.RpcGroup<Rpc.Any>;
  handlers: SurfaceHandlers;
  dispose(): void;
}

function recipeEnv(
  env: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (env === undefined) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === PUSH_TOKEN_ENV) continue;
    out[key] = value;
  }
  return out;
}

export function createLaneRunner(
  deps: {
    pusher?: LanePusher;
  } = {},
): LaneRunner {
  const uploads = createSnapshotUploads();
  const pusher = deps.pusher ?? createLanePusher();
  const stateStore = inMemoryStore<PipelineState>(EMPTY_STATE);
  const tail = createLogTail();
  const endNodeLogs = (id: string): void => {
    tail.end(id);
    tail.end(logStreamKey(id, "push"));
  };

  let venueHold: LocalHold | null = null;
  const onStdinPulse = (): void => {
    venueHold?.noteActivity();
  };
  process.stdin.on("data", onStdinPulse);

  const runtime = implementSurface(laneSurface, {
    cells: {
      nodes: { store: stateStore },
    },
    streams: {
      nodeLog: {
        source: ({ id, stream }) => tail.streamSource({ id: logStreamKey(id, stream) }),
      },
    },
    procedures: {
      snapshot: {
        has: ({ input }) => Effect.sync(() => ({ present: hasSnapshot(input.origin, input.commit) })),
        put: ({ input }) => Effect.sync(() => uploads.put(input)),
      },
      node: {
        rerun: ({ input }) =>
          Effect.sync(() => {
            venueHold?.noteActivity();
            return { ok: rerun(input.id) };
          }),
        cancel: ({ input }) =>
          Effect.sync(() => {
            venueHold?.noteActivity();
            return { ok: cancel(input.id) };
          }),
      },
      run: {
        configure: ({ input }) =>
          Effect.sync(() => {
            venueHold?.noteActivity();
            return configure(input);
          }),
        extend: ({ input }) =>
          Effect.sync(() => {
            venueHold?.noteActivity();
            return extend(input.tasks);
          }),
      },
      lease: {
        claim: ({ input }) =>
          Effect.promise(async () => {
            if (disposed) {
              return { status: "error" as const, error: "runner is disposed" };
            }
            if (venueHold !== null) {
              return {
                status: "error" as const,
                error: "agent already holds a venue lease",
              };
            }
            const lockPath = agentLeaseLockPath(input.lockPath);
            const result = await claimLocal(
              lockPath,
              { holder: input.holder, run: input.run },
              {
                onSelfRelease: (reason) => {
                  venueHold = null;
                  process.stderr.write(
                    `odu-runner: venue lease self-released (${reason})\n`,
                  );
                  dispose();
                  process.exit(0);
                },
              },
            );
            if (result.status === "held") {
              venueHold = result.hold;
              return { status: "held" as const };
            }
            if (result.status === "busy") {
              return {
                status: "busy" as const,
                heldBy: result.heldBy,
              };
            }
            return { status: "error" as const, error: result.error };
          }),
        probe: ({ input }) =>
          Effect.sync(() => {
            const lockPath = agentLeaseLockPath(input.lockPath);
            const own = venueHold?.probe(lockPath);
            if (own != null) return own;
            return probeLocal(lockPath);
          }),
        release: () =>
          Effect.sync(() => {
            if (venueHold !== null) {
              venueHold.release();
              venueHold = null;
            }
            return { ok: true };
          }),
      },
    },
  });

  const ctx = runtime.ctx;
  const reaper = createGroupReaper();
  interface Invocation {
    phase: "running" | "settled" | "closed";
    child: ChildProcess | null;
  }
  const invocations = new Map<string, Invocation>();
  const isCurrent = (id: string, inv: Invocation): boolean =>
    !disposed && invocations.get(id) === inv;
  const beginInvocation = (id: string): Invocation => {
    supersede(id);
    const inv: Invocation = { phase: "running", child: null };
    invocations.set(id, inv);
    return inv;
  };
  function supersede(id: string): void {
    const inv = invocations.get(id);
    if (inv === undefined) return;
    invocations.delete(id);
    if (inv.child !== null) killGroup(inv.child);
  }
  let disposed = false;
  let config: ConfigureInput | undefined;
  let workspace: string | undefined;
  let cleanupWorkspace: (() => void) | undefined;

  const getState = (): PipelineState => stateStore.get();
  const statusOf = (id: string): NodeStatus | undefined =>
    getState().nodes[id]?.status;
  /** Merge a patch onto one node. `drop` removes keys outright — a
   *  `Partial<NodeState>` cannot, because the wire's `optionalKey` fields
   *  reject a present-but-`undefined` spelling. */
  const setNode = (
    id: string,
    patch: Partial<NodeState>,
    drop: readonly (keyof NodeState)[] = [],
  ): void => {
    const cur = getState();
    const prev = cur.nodes[id];
    if (prev === undefined) return;
    const next: NodeState = { ...prev, ...patch };
    for (const key of drop) delete next[key];
    ctx.cells.nodes.set({
      ...cur,
      nodes: { ...cur.nodes, [id]: next },
    });
  };

  const configure = (input: ConfigureInput): ConfigureOutput => {
    if (disposed) return { ok: false, error: "runner is disposed" };
    if (config !== undefined) {
      return {
        ok: false,
        error: "runner is already configured (one run per lane process)",
      };
    }
    if (
      input.workspace === null &&
      (input.origin === null || input.sha === null)
    ) {
      return {
        ok: false,
        error: "configure needs either workspace or origin+sha",
      };
    }
    try {
      validatePipeline({ name: input.name, tasks: input.tasks });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    config = input;
    const nodes: Record<string, NodeState> = {
      [SETUP_NODE_ID]: pendingNode({
        id: SETUP_NODE_ID,
        name: SETUP_NODE_ID,
        command:
          input.workspace !== null
            ? `(workspace: ${input.workspace})`
            : `(fetch ${input.origin} @ ${input.sha?.slice(0, 7)})`,
        needs: [],
      }),
    };
    for (const task of input.tasks) {
      nodes[task.id] = pendingNode({
        id: task.id,
        name: task.name ?? task.id,
        command: task.command,
        needs: [...task.needs, SETUP_NODE_ID],
      });
    }
    ctx.cells.nodes.set({
      name: input.name,
      sha7: input.sha?.slice(0, 7) ?? "",
      dirty: false,
      order: [SETUP_NODE_ID, ...input.tasks.map((t) => t.id)],
      nodes,
    });
    tick();
    return { ok: true, error: null };
  };

  const extend = (tasks: ConfigureInput["tasks"]): ConfigureOutput => {
    if (disposed) return { ok: false, error: "runner is disposed" };
    const current = config;
    if (current === undefined) {
      return { ok: false, error: "runner is not configured" };
    }
    const combined = [...current.tasks, ...tasks];
    try {
      validatePipeline({ name: current.name, tasks: combined });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const state = getState();
    if (tasks.some((task) => state.nodes[task.id] !== undefined)) {
      return { ok: false, error: "extended task id already exists" };
    }
    const nodes = { ...state.nodes };
    for (const task of tasks) {
      nodes[task.id] = pendingNode({
        id: task.id,
        name: task.name ?? task.id,
        command: task.command,
        needs: [...task.needs, SETUP_NODE_ID],
      });
    }
    config = { ...current, tasks: combined };
    ctx.cells.nodes.set({
      ...state,
      order: [...state.order, ...tasks.map((task) => task.id)],
      nodes,
    });
    tick();
    return { ok: true, error: null };
  };

  const runnable = (node: NodeState): boolean =>
    node.status === "pending" &&
    node.needs.every((dep) => statusOf(dep) === "ok");
  const blocked = (node: NodeState): boolean =>
    node.status === "pending" &&
    node.needs.some((dep) => {
      const s = statusOf(dep);
      return (
        s === "failed" ||
        s === "skipped" ||
        s === "errored" ||
        s === "cancelled"
      );
    });

  const tick = (): void => {
    if (disposed) return;
    let changed = true;
    while (changed) {
      changed = false;
      const { order, nodes } = getState();
      for (const id of order) {
        const node = nodes[id];
        if (node === undefined || node.status !== "pending") continue;
        if (blocked(node)) {
          setNode(id, { status: "skipped" });
          endNodeLogs(id);
          changed = true;
        } else if (runnable(node) && invocations.get(id)?.phase !== "running") {
          if (id === SETUP_NODE_ID) runSetup();
          else spawnNode(node);
          changed = true;
        }
      }
    }
  };

  const runSetup = (): void => {
    const cfg = config;
    if (cfg === undefined) return;
    const inv = beginInvocation(SETUP_NODE_ID);
    const startedAt = Date.now();
    setNode(SETUP_NODE_ID, { status: "running", startedAt });
    const live = (): boolean => isCurrent(SETUP_NODE_ID, inv);
    const finish = (ok: boolean): void => {
      if (!live() || inv.phase !== "running") return;
      setNode(SETUP_NODE_ID, {
        status: ok ? "ok" : "failed",
        exitCode: ok ? 0 : 1,
        durationMs: Date.now() - startedAt,
      });
      inv.phase = "closed";
      endNodeLogs(SETUP_NODE_ID);
      tick();
    };

    if (cfg.workspace !== null) {
      const exists = existsSync(cfg.workspace);
      tail.append(
        SETUP_NODE_ID,
        exists
          ? `[odu] using provided workspace ${cfg.workspace}\n`
          : `[odu] provided workspace ${cfg.workspace} does not exist\n`,
      );
      if (exists) workspace = cfg.workspace;
      const verified = exists && (cfg.snapshot === undefined || narrateSnapshot(cfg.workspace, cfg.sha as string, cfg.snapshot.commit, line => tail.append(SETUP_NODE_ID, `${line}\n`)));
      finish(verified);
      return;
    }

    void prepareWorkspace(
      { origin: cfg.origin as string, sha: cfg.sha as string,
        ...(cfg.snapshot === undefined ? {} : { snapshot: {
          commit: cfg.snapshot.commit, requires: cfg.snapshot.requires,
          bundlePath: cfg.snapshot.bundle ? uploads.path(cfg.snapshot.commit) : null,
        } }),
      },
      (line) => {
        if (live() && inv.phase === "running") {
          tail.append(SETUP_NODE_ID, `${line}\n`);
        }
      },
    ).then((result) => {
      if (!live()) {
        result.cleanup();
        return;
      }
      if (result.ok && result.workspace !== null) {
        workspace = result.workspace;
        cleanupWorkspace = result.cleanup;
      }
      finish(result.ok);
    });
  };

  const spawnNode = (node: NodeState): void => {
    const inv = beginInvocation(node.id);
    const current = (): boolean => isCurrent(node.id, inv);
    const startedAt = Date.now();
    setNode(node.id, { status: "running", startedAt });
    // Node's 'pipe' stdio is an AF_UNIX socketpair, and Linux cannot open() a
    // socket by path — so anything that REOPENS its own output (cucumber's
    // `pretty:/dev/stderr` format, redirections via /proc/self/fd) dies with
    // ENXIO. justci's process-compose handed recipes real pipes; interposing
    // `| cat` restores that: the recipe's fd 1/2 become genuine pipe(2)s from
    // the shell, and only `cat` writes to the socketpair. pipefail keeps the
    // recipe's exit code; the newline before `}` terminates the group even if
    // the command ends in a comment.
    const task = config?.tasks.find((one) => one.id === node.id);
    const child = spawn(
      "bash",
      ["-o", "pipefail", "-c", `{ ${node.command}\n} 2>&1 | cat`],
      {
        cwd: workspace,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: {
          ...process.env,
          ...recipeEnv(task?.env),
        },
      },
    );
    inv.child = child;
    if (child.pid !== undefined) reaper.track(child.pid);
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    const onOutput = (chunk: string): void => {
      if (!current()) return;
      tail.append(node.id, chunk);
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    const taskEnv = task?.env;
    let closeSeen = false;
    let pushing = false;
    let pushStartedAt = 0;
    const endLog = (): void => {
      if (inv.phase === "closed") return;
      inv.phase = "closed";
      endNodeLogs(node.id);
    };
    const stamp = (
      status: NodeStatus,
      exitCode: number | null,
      push: NodePush | null,
      durationMs: number,
    ): void => {
      if (!current()) return;
      setNode(node.id, {
        status,
        exitCode,
        durationMs,
        ...(push === null ? {} : { push }),
      });
      if (closeSeen) endLog();
      tick();
    };
    const finish = (status: NodeStatus, exitCode: number | null): void => {
      // `exit` and `error` can BOTH fire for one invocation (a child that fails
      // to spawn emits no exit; one that spawns and dies emits no error), so the
      // phase — not a second flag beside it — is what makes the first one win.
      if (!current() || inv.phase !== "running") return;
      inv.phase = "settled";
      if (child.pid === undefined) endLog();
      if (child.pid !== undefined) reaper.reap(child.pid);
      const durationMs = Date.now() - startedAt;
      const pushConfig = status === "ok" ? pushConfigOf(taskEnv) : null;
      if (pushConfig === null || workspace === undefined) {
        stamp(status, exitCode, null, durationMs);
        return;
      }
      if (runsOutsideWorkspace(task?.workdir)) {
        if (current()) {
          tail.append(
            node.id,
            `\n[odu] not pushing: this recipe runs in ${task?.workdir ?? ""} ` +
              "(set working-directory), outside the run's workspace\n",
          );
        }
        stamp(status, exitCode, null, durationMs);
        return;
      }
      const workdir = task?.workdir === undefined ? workspace : join(workspace, task.workdir);
      pushing = true;
      pushStartedAt = Date.now();
      void pusher
        .push(workdir, pushConfig, {
          note: (line) => {
            if (current()) tail.append(node.id, `${line}\n`);
          },
          begin: () => {
            pushStartedAt = Date.now();
            if (current()) {
              setNode(node.id, { push: { state: "pushing" }, durationMs });
            }
          },
          say: (line) => {
            if (current()) tail.append(logStreamKey(node.id, "push"), `${line}\n`);
          },
        })
        .then((pushed) => {
          pushing = false;
          stamp(
            "ok",
            exitCode,
            pushed === null
              ? null
              : { state: "pushed", ...pushed, durationMs: Date.now() - pushStartedAt },
            durationMs,
          );
        })
        .catch((err: unknown) => {
          pushing = false;
          const message = err instanceof Error ? err.message : String(err);
          const detail = describeFailure(err);
          if (current()) {
            tail.append(logStreamKey(node.id, "push"), `\n[odu] push failed: ${detail}\n`);
          }
          stamp(
            "failed",
            exitCode,
            { state: "failed", message, durationMs: Date.now() - pushStartedAt },
            durationMs,
          );
        });
    };
    child.on("error", (err) => {
      if (current()) {
        tail.append(node.id, `\n[odu] spawn failed: ${err.message}\n`);
      }
      finish("failed", null);
    });
    child.on("exit", (code) => finish(code === 0 ? "ok" : "failed", code));
    // `close`, not `exit`: exit fires when the process dies, close only once
    // its stdio has drained, so the last chunks of a recipe's output — its
    // summary, the part worth reading — arrive between the two. Ending the log
    // here is what makes "I have all of this node's output" a fact the
    // coordinator can wait on instead of a race it loses (juspay/odu#87).
    child.on("close", () => {
      if (!current() || inv.phase === "closed") return;
      closeSeen = true;
      if (pushing) return;
      endLog();
    });
  };

  // Negative pid ⇒ the whole detached process group (just → nix develop →
  // bun → the recipe's own children), not only the shell at the top.
  const killGroup = (child: ChildProcess): void => {
    if (child.pid !== undefined) reaper.reap(child.pid);
  };

  const rerun = (id: string): boolean => {
    const initial = getState();
    if (disposed || initial.nodes[id] === undefined) return false;
    const toReset = new Set<string>([
      id,
      ...transitiveDependents(
        initial.order,
        (cid) => initial.nodes[cid]?.needs ?? [],
        id,
      ),
    ]);
    for (const rid of toReset) {
      supersede(rid);
      tail.reset(rid, "");
      tail.reset(logStreamKey(rid, "push"), "");
      setNode(
        rid,
        {
          status: "pending",
          exitCode: null,
          startedAt: null,
          durationMs: null,
        },
        ["push"],
      );
    }
    tick();
    return true;
  };

  const cancel = (id: string): boolean => {
    const initial = getState();
    const node = initial.nodes[id];
    if (disposed || node === undefined) return false;
    if (node.status === "cancelled") return true;
    if (node.status !== "pending" && node.status !== "running") return false;
    supersede(id);
    const startedAt = node.startedAt;
    const durationMs =
      startedAt !== null ? Date.now() - startedAt : null;
    tail.append(id, "\n[odu] cancelled by operator\n");
    setNode(id, {
      status: "cancelled",
      exitCode: null,
      durationMs,
    });
    endNodeLogs(id);
    tick();
    return true;
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    uploads.dispose();
    process.stdin.off("data", onStdinPulse);
    if (venueHold !== null) {
      venueHold.release();
      venueHold = null;
    }
    invocations.clear();
    reaper.reapAllSync();
    const state = getState();
    const settledGreen =
      state.order.length > 0 &&
      state.order.every((id) => state.nodes[id]?.status === "ok");
    if (settledGreen) cleanupWorkspace?.();
  }

  const { group, handlers } = runtime;

  return { group, handlers, dispose };
}
