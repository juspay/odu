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
import {
  EMPTY_STATE,
  type NodeState,
  type NodeStatus,
  pendingNode,
  type PipelineState,
} from "@odu/run-client/surface";
import { SETUP_NAMEPATH } from "@odu/run-client/nodeId";
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
import { prepareWorkspace } from "./workspace";

/** Lane-local setup node id — same namepath as fan-in `_ci-setup@plat`. */
export const SETUP_NODE_ID = SETUP_NAMEPATH;

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
            const lockPath = agentLeaseLockPath(input.lockPath);
            // The coordinator probes its own hold every two seconds. Answering
            // that question by spawnSync-ing flock blocks this runner's event
            // loop, which can starve the transport keep-alive under load and
            // turn a healthy lease into a false link death. The hold child is
            // already the authority for this exact lock and identity.
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
  // Owns the death of every recipe process group (reap.ts): tracked from
  // spawn, reaped (TERM → grace → KILL) on node exit / cancel / rerun, and
  // swept synchronously on dispose — the recipe trees are `detached`, so
  // nothing else would ever kill them.
  const reaper = createGroupReaper();
  /** One START of one node, and the whole of that start's state.
   *
   *  IDENTITY IS THE RECORD. A rerun or a cancel REPLACES a node's entry, so
   *  every closure still holding the old one fails `isCurrent` forever after,
   *  on every handler, with nothing to compare and no counter to keep. That is
   *  the distinction map-membership could not make: a child keeps delivering
   *  output *after* it has finished — `exit` fires when the process dies,
   *  `close` only once its stdio has drained, and both the tail of a recipe's
   *  output and its log's `end` frame live in that window (juspay/odu#87) — so
   *  "this one finished" and "this one was replaced" must not be the same fact.
   *
   *  `phase` names the three states an invocation actually has, so no
   *  combination of separate flags can spell one the domain does not:
   *    running — spawned, or (for the builtin setup node) preparing;
   *    settled — status stamped, stdio still draining;
   *    closed  — log terminal published; nothing more will ever be written.
   *
   *  `child` is null for the setup node, whose work is async prep rather than a
   *  process — one mechanism covering both node kinds, as the generation
   *  counter it replaces did. */
  interface Invocation {
    phase: "running" | "settled" | "closed";
    child: ChildProcess | null;
  }
  const invocations = new Map<string, Invocation>();
  const isCurrent = (id: string, inv: Invocation): boolean =>
    !disposed && invocations.get(id) === inv;
  /** Begin an invocation of `id`, superseding whatever held it. */
  const beginInvocation = (id: string): Invocation => {
    supersede(id);
    const inv: Invocation = { phase: "running", child: null };
    invocations.set(id, inv);
    return inv;
  };
  /** Retire whatever invocation holds `id`: kill its process group and drop the
   *  record, so nothing it left behind can write into the log the next one
   *  opens. The counter this replaces spelled both verbs — "begin invocation N"
   *  and "invalidate whatever is current" — with one call whose meaning was the
   *  caller's choice to keep or discard its return value. */
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

  /** Add tasks after configure without replacing any state already earned.
   * The combined DAG is validated as one value before it is published. */
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

  // ── scheduling (mini-ci semantics: fixed-point pass, skip cascade) ──
  const runnable = (node: NodeState): boolean =>
    node.status === "pending" &&
    node.needs.every((dep) => statusOf(dep) === "ok");
  const blocked = (node: NodeState): boolean =>
    node.status === "pending" &&
    node.needs.some((dep) => {
      const s = statusOf(dep);
      // 'errored' is coordinator-only (@odu/run-client/surface) and unreachable in lane
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
          // A skipped node never runs, so its (empty) log is complete the
          // instant it is skipped. Terminal status and log terminal stay in
          // lockstep on EVERY path, so a reader can wait on all nodes alike.
          tail.end(id);
          changed = true;
        } else if (runnable(node) && invocations.get(id)?.phase !== "running") {
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
      // Setup writes its narration synchronously through `tail.append`, so
      // reaching a terminal status IS the last of its output.
      inv.phase = "closed";
      tail.end(SETUP_NODE_ID);
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
        // Narration belongs to a prep that is still running: a superseded one
        // must not write into the log its replacement opened, and a finished
        // one has already published its terminal.
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

  // ── recipe nodes: own process group, merged output ──
  const spawnNode = (node: NodeState): void => {
    const inv = beginInvocation(node.id);
    /** This invocation is still the node's current one — i.e. no rerun/cancel
     *  has replaced it. The record stays in the map across `exit`, because the
     *  child's stdio keeps delivering until `close` and output in that window
     *  belongs to this node; it leaves only on SUPERSESSION. */
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
    const child = spawn(
      "bash",
      ["-o", "pipefail", "-c", `{ ${node.command}\n} 2>&1 | cat`],
      {
        cwd: workspace,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: {
          ...process.env,
          ...(config?.tasks.find((task) => task.id === node.id)?.env ?? {}),
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
    const finish = (status: NodeStatus, exitCode: number | null): void => {
      // `exit` and `error` can BOTH fire for one invocation (a child that fails
      // to spawn emits no exit; one that spawns and dies emits no error), so the
      // phase — not a second flag beside it — is what makes the first one win.
      if (!current() || inv.phase !== "running") return;
      inv.phase = "settled";
      // Backstop for a child that never spawned. The status obligation has two
      // producers (`exit` and `error`, because a spawn failure emits no exit);
      // the log terminal has one, `close`. A child with no pid has no stdio to
      // drain, so this is the last moment its (empty) log is complete — and a
      // log left unterminated here would cost a 15s drain and then a truncation
      // notice stamped on a node that finished, which is the class of lie the
      // notice exists to prevent.
      if (child.pid === undefined) {
        inv.phase = "closed";
        tail.end(node.id);
      }
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
      inv.phase = "closed";
      tail.end(node.id);
    });
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
    // Same DAG closure as CLI multi-rerun collapse (`transitiveDependents`).
    const toReset = new Set<string>([
      id,
      ...transitiveDependents(
        initial.order,
        (cid) => initial.nodes[cid]?.needs ?? [],
        id,
      ),
    ]);
    for (const rid of toReset) {
      // Supersede whatever invocation held this node — a running child, an
      // in-flight setup prep, or a finished child whose `close` has yet to
      // fire — so none of them can write into the log this rerun just opened.
      supersede(rid);
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
    // The supersession above already silenced the killed child, so this
    // cancel line is the log's last word.
    tail.end(id);
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
    invocations.clear();
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
