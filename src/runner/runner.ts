/**
 * The odu lane runner — owns one platform's slice of the pipeline: the task
 * DAG, each node's child process, and each node's log tail, served as a
 * `@kolu/surface` over stdio. Grown from the mini-ci example runner (which
 * stays untouched as the reference substrate); the deltas that make it CI:
 *
 *   - **Spawns idle.** HostSession's argv is fixed (`odu-runner --stdio`), so
 *     per-run config arrives over the surface: `run.configure` validates,
 *     seeds the DAG, acks immediately, and reports workspace prep through the
 *     synthetic `_ci-setup` node (never a multi-minute blocking RPC).
 *   - **`_ci-setup` is a builtin node** every recipe depends on — the skip
 *     cascade, log stream, and dashboard rows treat setup like any node,
 *     mirroring justci's `_ci-setup@<platform>` bookkeeping context.
 *   - **Process-group kills.** A recipe node is `just --no-deps <namepath>`
 *     wrapping `nix develop -c …` wrapping the real work; killing only the
 *     direct child would orphan grandchildren that keep writing into the
 *     workspace. Nodes spawn `detached` and die as a group — every teardown
 *     path routes through one `GroupReaper` (SIGTERM → grace → SIGKILL; see
 *     reap.ts), including the runner's own death by signal (main.ts).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  implementSurface,
  inMemoryStore,
  type SurfaceHandlers,
} from "@kolu/surface/server";
import { Effect } from "effect";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";
import { createLogTail } from "../common/logTail";
import { validatePipeline } from "../common/spec";
import {
  type ConfigureInput,
  type ConfigureOutput,
  EMPTY_STATE,
  laneSurface,
  type NodeState,
  type NodeStatus,
  pendingNode,
  type PipelineState,
} from "../common/surface";
import {
  agentLeaseLockPath,
  claimLocal,
  type LocalHold,
  probeLocal,
} from "./leaseHold";
import { createGroupReaper } from "./reap";
import { prepareWorkspace } from "./workspace";

export const SETUP_NODE_ID = "_ci-setup";

export interface LaneRunner {
  /** The served surface: the flat `RpcGroup` `defineSurface` minted and the
   *  tag-keyed handler record `implementSurface` bound to it — the pair
   *  `serveOverStdio({ group, handlers })` takes. `implementSurface` asserts at
   *  boot that the two agree in BOTH directions (no advertised tag unbound, no
   *  handler at a tag the group never minted), which is what retired the
   *  `any`-typed oRPC router this field used to be. */
  group: RpcGroup.RpcGroup<Rpc.Any>;
  handlers: SurfaceHandlers;
  /** Kill running process groups and stop scheduling; cleans up this run's
   *  worktree when the pipeline settled green. */
  dispose(): void;
}

export function createLaneRunner(): LaneRunner {
  const stateStore = inMemoryStore<PipelineState>(EMPTY_STATE);
  const tail = createLogTail();

  /** Venue hold for this agent process — at most one; release on dispose. */
  let venueHold: LocalHold | null = null;
  /** Inbound stdio (incl. system.live) counts as a dead-man pulse. */
  const onStdinPulse = (): void => {
    venueHold?.noteActivity();
  };
  process.stdin.on("data", onStdinPulse);

  const runtime = implementSurface(laneSurface, {
    cells: {
      nodes: { store: stateStore },
    },
    streams: {
      nodeLog: { source: tail.streamSource },
    },
    // A procedure is now ONE arm — `({ input }) => Effect<Out>` — where it used
    // to be an `async` function. `Effect.sync` for the bodies that never
    // awaited, `Effect.promise` for the one that does (`claimLocal`). Nothing
    // here declares a failure channel: every "no" this surface says is a value
    // on the success side (`{ ok: false }`, `{ status: "error" }`), which is
    // what its schemas have always spelled. An unexpected throw stays a DEFECT
    // and dies loudly rather than masquerading as a member failure.
    procedures: {
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
                  // Exit so the coordinator session sees link death and
                  // `lease.lost` fires — flock is already free. This is a
                  // teardown path like any other: sweep recipe groups first
                  // (an agent can hold the venue lease AND run a lane).
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
            venueHold?.noteActivity();
            const lockPath = agentLeaseLockPath(input.lockPath);
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
  const children = new Map<string, ChildProcess>();
  // Owns the death of every recipe process group (reap.ts): tracked from
  // spawn, reaped (TERM → grace → KILL) on node exit / cancel / rerun, and
  // swept synchronously on dispose — the recipe trees are `detached`, so
  // nothing else would ever kill them.
  const reaper = createGroupReaper();
  /** Monotonic token per builtin-setup invocation — the async prep analogue
   *  of the child-identity guard on process nodes. */
  let setupGeneration = 0;
  let disposed = false;
  let config: ConfigureInput | undefined;
  let workspace: string | undefined;
  let cleanupWorkspace: (() => void) | undefined;

  const getState = (): PipelineState => stateStore.get();
  const statusOf = (id: string): NodeStatus | undefined =>
    getState().nodes[id]?.status;
  const setNode = (id: string, patch: Partial<NodeState>): void => {
    const cur = getState();
    const prev = cur.nodes[id];
    if (prev === undefined) return;
    ctx.cells.nodes.set({
      ...cur,
      nodes: { ...cur.nodes, [id]: { ...prev, ...patch } },
    });
  };

  // ── configure: seed the DAG, ack, let the scheduler take it ──
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
      // Commit identity is fan-in state: the coordinator stamps the
      // authoritative sha7/dirty onto `.ci/odu.sock` (what attach reads). A
      // lane only echoes the sha it was handed (none in workspace mode) and
      // never assesses tree dirtiness, so its copy is advisory.
      sha7: input.sha?.slice(0, 7) ?? "",
      dirty: false,
      order: [SETUP_NODE_ID, ...input.tasks.map((t) => t.id)],
      nodes,
    });
    tick();
    return { ok: true, error: null };
  };

  // ── scheduling (mini-ci semantics: fixed-point pass, skip cascade) ──
  const runnable = (node: NodeState): boolean =>
    node.status === "pending" &&
    node.needs.every((dep) => statusOf(dep) === "ok");
  const blocked = (node: NodeState): boolean =>
    node.status === "pending" &&
    node.needs.some((dep) => {
      const s = statusOf(dep);
      // 'errored' is coordinator-only (surface.ts) and unreachable in lane
      // state; kept so blocked() reads as the full failed-set and survives any
      // future in-lane errored. 'cancelled' is deliberate operator cancel —
      // dependents skip the same way as failed (juspay/odu#68).
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
          changed = true;
        } else if (runnable(node) && !children.has(id)) {
          if (id === SETUP_NODE_ID) runSetup();
          else spawnNode(node);
          changed = true;
        }
      }
    }
  };

  // ── the builtin setup node: workspace prep as a node, not an RPC ──
  const runSetup = (): void => {
    const cfg = config;
    if (cfg === undefined) return;
    const generation = ++setupGeneration;
    const startedAt = Date.now();
    setNode(SETUP_NODE_ID, { status: "running", startedAt });
    const live = (): boolean => !disposed && generation === setupGeneration;
    const finish = (ok: boolean): void => {
      if (!live()) return;
      setNode(SETUP_NODE_ID, {
        status: ok ? "ok" : "failed",
        exitCode: ok ? 0 : 1,
        durationMs: Date.now() - startedAt,
      });
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
      finish(exists);
      return;
    }

    void prepareWorkspace(
      // configure() validated origin+sha when workspace is null
      { origin: cfg.origin as string, sha: cfg.sha as string },
      (line) => {
        if (live()) tail.append(SETUP_NODE_ID, `${line}\n`);
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

  // ── recipe nodes: own process group, merged output ──
  const spawnNode = (node: NodeState): void => {
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
    const child = spawn(
      "bash",
      ["-o", "pipefail", "-c", `{ ${node.command}\n} 2>&1 | cat`],
      {
        cwd: workspace,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    children.set(node.id, child);
    if (child.pid !== undefined) reaper.track(child.pid);
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    const onOutput = (chunk: string): void => {
      if (children.get(node.id) !== child) return;
      tail.append(node.id, chunk);
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    const finish = (status: NodeStatus, exitCode: number | null): void => {
      if (children.get(node.id) !== child) return;
      children.delete(node.id);
      // The direct child is gone, but a stray it backgrounded (with its stdio
      // redirected, so `cat` still saw EOF) may survive in the group — reap it
      // rather than leaving the group unowned forever.
      if (child.pid !== undefined) reaper.reap(child.pid);
      setNode(node.id, {
        status,
        exitCode,
        durationMs: Date.now() - startedAt,
      });
      tick();
    };
    child.on("error", (err) => {
      if (children.get(node.id) === child) {
        tail.append(node.id, `\n[odu] spawn failed: ${err.message}\n`);
      }
      finish("failed", null);
    });
    child.on("exit", (code) => finish(code === 0 ? "ok" : "failed", code));
  };

  // Negative pid ⇒ the whole detached process group (just → nix develop →
  // bun → the recipe's own children), not only the shell at the top; the
  // reaper escalates SIGTERM → grace → SIGKILL so a TERM-ignoring tree still
  // dies.
  const killGroup = (child: ChildProcess): void => {
    if (child.pid !== undefined) reaper.reap(child.pid);
  };

  // ── rerun: reset target + transitive dependents, then reschedule ──
  const rerun = (id: string): boolean => {
    const initial = getState();
    if (disposed || initial.nodes[id] === undefined) return false;
    const toReset = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const candidate of initial.order) {
        if (toReset.has(candidate)) continue;
        const needs = initial.nodes[candidate]?.needs ?? [];
        if (needs.some((dep) => toReset.has(dep))) {
          toReset.add(candidate);
          grew = true;
        }
      }
    }
    for (const rid of toReset) {
      const child = children.get(rid);
      if (child !== undefined) {
        children.delete(rid);
        killGroup(child);
      }
      if (rid === SETUP_NODE_ID) setupGeneration += 1;
      tail.reset(rid, "");
      setNode(rid, {
        status: "pending",
        exitCode: null,
        startedAt: null,
        durationMs: null,
      });
    }
    tick();
    return true;
  };

  // ── cancel: stop one pending/running node; dependents skip via tick ──
  const cancel = (id: string): boolean => {
    const initial = getState();
    const node = initial.nodes[id];
    if (disposed || node === undefined) return false;
    // Idempotent: already cancelled is success (same as re-cancel platform).
    if (node.status === "cancelled") return true;
    if (node.status !== "pending" && node.status !== "running") return false;
    const child = children.get(id);
    if (child !== undefined) {
      children.delete(id);
      killGroup(child);
    }
    if (id === SETUP_NODE_ID) setupGeneration += 1;
    const startedAt = node.startedAt;
    const durationMs =
      startedAt !== null ? Date.now() - startedAt : null;
    tail.append(id, "\n[odu] cancelled by operator\n");
    setNode(id, {
      status: "cancelled",
      exitCode: null,
      durationMs,
    });
    tick();
    return true;
  };

  // ── dispose: the one teardown every exit path shares ──
  // Called on stdin EOF (main's post-serve line, before the framework-owned
  // exit), on death by signal (main's handlers), on the fatal-error exit, and
  // on venue-lease self-release (above). Idempotent — several of those can
  // stack on one exit. A hoisted function declaration so `onSelfRelease`
  // (defined earlier in this closure) can reach it.
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    process.stdin.off("data", onStdinPulse);
    if (venueHold !== null) {
      venueHold.release();
      venueHold = null;
    }
    // Synchronous sweep of EVERY group ever spawned — running nodes, but
    // also TERM-ignoring survivors of a cancel/rerun and strays left behind
    // by finished nodes. Synchronous because this runs on process-exit
    // paths (stdin EOF before the framework-owned exit; the signal handlers
    // in main.ts), where a timer-based escalation would never fire.
    children.clear();
    reaper.reapAllSync();
    // Keep the worktree when anything failed — it is the debugging trail;
    // the host tmpdir reaper owns the long tail.
    const state = getState();
    const settledGreen =
      state.order.length > 0 &&
      state.order.every((id) => state.nodes[id]?.status === "ok");
    if (settledGreen) cleanupWorkspace?.();
  }

  // `implementSurface` returns the group it advertises and the handlers bound
  // to it, already route-set-checked against each other — serve the pair.
  const { group, handlers } = runtime;

  return { group, handlers, dispose };
}
