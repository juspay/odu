/**
 * `odu run` — the coordinator. One process owns the whole run, mirroring the
 * lease wrapper's constraint (the flock lives in `ci/pu/run.sh`, which
 * parents exactly one coordinator):
 *
 *   strict gate → HEAD snapshot → `just` DAG ingest → fan lanes out per
 *   platform (an ssh session each) → merge lane state into one fan-in surface
 *   served on `.ci/odu.sock` → write per-SHA logs + post commit statuses on
 *   transitions → verdict.
 *
 * Status posting and `--progress json` are both *diff-driven off the fan-in
 * state*, so every observer derives from the same source of truth the
 * dashboards attach to.
 */

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { implementSurface, inMemoryStore } from "@kolu/surface/server";
import { isLocalHost, resolveSystem } from "@kolu/surface-remote";
import { bold, dim, green, link, magenta, red } from "../cli/ansi";
import { formatGoDuration } from "../common/duration";
import { gitTopLevel } from "../common/git";
import { createLogTail } from "../common/logTail";
import { fanId, onPlatform, splitFanId } from "../common/nodeId";
import type { TaskSpec } from "../common/spec";
import {
  EMPTY_HEADER,
  type NodeState,
  oduSurface,
  pendingNode,
  type PipelineState,
  type RunHeader,
  STATUS_META,
} from "../common/surface";
import { commitLabel, createDisplay, progressEvent } from "./display";
import { laneTasks, loadJustPipeline, parseSelector } from "../just/ingest";
import { loadHosts, localFallbackNote, resolveLanes } from "./hosts";
import { type Lane, startLane } from "./lane";
import { missingRunnerError, resolveRunnerFlake } from "./runnerFlake";
import { cancelRun } from "./cancel";
import { allocateSeq, writeRunRecord } from "./ledger";
import { buildRunRecord, projectNodes } from "../common/runRecord";
import { SOCKET_PATH, serveSocket } from "./socket";
import {
  fetchUrlFor,
  logPathFor,
  parseGithubRemote,
  repoSlug,
  StatusPoster,
  statusFor,
} from "./statuses";

const SETUP = "_ci-setup";

export interface RunArgs {
  selectors: string[];
  platforms: string[];
  hostPins: string[];
  root?: string;
  noDeps: boolean;
  noStrict: boolean;
  noSnapshot: boolean;
  noPost: boolean;
  progressJson: boolean;
  /** Cancel a run already live in this checkout before starting, instead of
   *  refusing on the one-run lock — "stop this, run the fixed commit". */
  supersede: boolean;
  /** Keep the coordinator serving after the run drains, so a node can be
   *  rerun post-settle; exit only on cancel / signal / idle backstop. */
  linger: boolean;
}

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`odu: git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function tryGit(repo: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function runCommand(args: RunArgs): Promise<number> {
  // Resolve where the generic lane runner comes from before any side effect
  // (worktree snapshot, socket) — a misbuilt binary with no runner flake should
  // refuse instantly, not after pinning HEAD. Throws when ODU_RUNNER_FLAKE is
  // unset; there is no override or fallback to the repo under test.
  const runnerFlake = resolveRunnerFlake(process.env);

  const repoRoot = gitTopLevel();
  if (repoRoot === null) {
    throw new Error(
      "odu: git rev-parse --show-toplevel failed: not a git checkout",
    );
  }

  // ── modes (the justci flag table: strict by default) ──
  const snapshotMode = !args.noStrict && !args.noSnapshot;
  const posting = snapshotMode && !args.noPost;
  const dirty = git(repoRoot, ["status", "--porcelain"]) !== "";
  if (snapshotMode && dirty) {
    process.stderr.write(
      "odu: working tree is dirty — strict mode refuses it.\n" +
        "Commit (or stash) first, or pass --no-strict for a dev iteration run.\n",
    );
    return 1;
  }

  const sha = git(repoRoot, ["rev-parse", "HEAD"]);
  const sha7 = sha.slice(0, 7);

  // ── HEAD pin: the run sees the commit, never the live tree ──
  let snapshotDir: string | null = null;
  if (snapshotMode) {
    snapshotDir = mkdtempSync(join(tmpdir(), `odu-${sha7}-`));
    git(repoRoot, ["worktree", "add", "--detach", snapshotDir, "HEAD"]);
  }
  const specSource = snapshotDir ?? repoRoot;

  const cleanupSnapshot = (): void => {
    if (snapshotDir === null) return;
    tryGit(repoRoot, ["worktree", "remove", "--force", snapshotDir]);
    rmSync(snapshotDir, { recursive: true, force: true });
    snapshotDir = null;
  };
  // The cancel / linger / signal teardown exits via `process.exit` (in
  // `shutdown`), which bypasses the `finally` below — so also reclaim the HEAD
  // snapshot on process exit. Idempotent (guards on `snapshotDir`) and sync, so
  // it's safe both here and as an exit handler.
  process.once("exit", cleanupSnapshot);

  // Every lane orchestrate builds, registered the instant it's constructed so
  // this `finally` can tear down a lane's session that its own `lane.close()`
  // never reached — an EARLY-THROW out of orchestrate (e.g. one lane built, a
  // later lane's setup throws) that skips the normal per-lane teardown. The
  // natural-completion path (`for … lane.close()` after `allSettled`) and the
  // cancel/signal `shutdown()` path already close every lane; `shutdown()` exits
  // via `process.exit`, which BYPASSES this `finally`, so those two paths stand
  // on their own and this sweep only covers the throw-before-close gap the old
  // module-global `destroyAllSessions()` used to. `lane.close()` is a guarded
  // no-op once a lane is closed/dead (its `session.destroy()` is idempotent), so
  // re-sweeping an already-closed lane here is harmless.
  const createdLanes = new Set<Lane>();
  try {
    return await orchestrate(
      args,
      {
        repoRoot,
        specSource,
        runnerFlake,
        sha,
        sha7,
        posting,
        snapshotMode,
        dirty,
      },
      createdLanes,
    );
  } finally {
    cleanupSnapshot();
    for (const lane of createdLanes) lane.close();
  }
}

interface RunContext {
  repoRoot: string;
  specSource: string;
  /** Flake-ref the generic lane runner (`odu-runner`) is resolved from — odu's
   *  own flake, NOT specSource (the repo under test). See runnerFlake.ts. */
  runnerFlake: string;
  sha: string;
  sha7: string;
  posting: boolean;
  snapshotMode: boolean;
  /** Working tree has uncommitted changes (only reachable when !snapshotMode). */
  dirty: boolean;
}

async function orchestrate(
  args: RunArgs,
  ctx: RunContext,
  /** runCommand-owned registry of every lane this call builds, so its `finally`
   *  can sweep sessions on an early-throw path (see the call site). Populated
   *  here at construction; the natural + shutdown paths still close each lane
   *  themselves. */
  createdLanes: Set<Lane>,
): Promise<number> {
  const { repoRoot, specSource, runnerFlake, sha, sha7 } = ctx;
  // Where stdout points picks the face: NDJSON for the /do contract, an
  // in-place live matrix on a TTY, transition lines + heartbeats for a pipe.
  // The live face is the shared interactive view (same one `attach` paints):
  // it pulls the focused node's log from this run's in-memory `tail`, and its
  // keys drive `rerunNode` and `shutdown` — the source-agnostic seam. Keys are
  // only live when stdin is a TTY (an output-only `run` keeps the matrix, no
  // raw mode). `json`/`plain` ignore the live opts and keep the byte contract
  // `/do` and kolu CI depend on — untouched.
  const display = args.progressJson
    ? createDisplay("json")
    : process.stdout.isTTY === true
      ? createDisplay("live", {
          interactive: process.stdin.isTTY === true,
          hookStderr: true,
          openLog: (id, sig) => tail.streamSource({ id }, sig),
          rerun: (id) => void rerunNode(id),
          onQuit: () => shutdown(130),
        })
      : createDisplay("plain");
  const info = (msg: string): void => {
    display.info(msg);
  };

  // ── DAG + lanes ──
  const spec = loadJustPipeline(specSource, { root: args.root });
  const hostsConfig = loadHosts();
  // Zero configured lanes means a bare `odu run` with no hosts anywhere — the
  // newcomer path. Running on this machine is the overwhelmingly common intent,
  // so default to a localhost lane on the current system rather than erroring.
  // (A localhost lane dials no one; it's the zero-config default, not a baked-in
  // remote host.) An explicit `--platform` with no host still errors earlier in
  // resolveLanes — the operator asking for a lane we can't build.
  let lanesByPlatform = resolveLanes(
    hostsConfig,
    args.hostPins,
    args.platforms,
  );
  if (Object.keys(lanesByPlatform).length === 0) {
    const system = await resolveSystem("localhost");
    info(localFallbackNote(system));
    lanesByPlatform = { [system]: "localhost" };
  }
  const selectors = args.selectors.map(parseSelector);
  for (const selector of selectors) {
    if (
      selector.platform !== undefined &&
      lanesByPlatform[selector.platform] === undefined
    ) {
      throw new Error(
        `odu: selector platform "${selector.platform}" is not in the fanout ` +
          `(${Object.keys(lanesByPlatform).join(", ") || "no lanes"})`,
      );
    }
  }

  const platforms = Object.keys(lanesByPlatform).sort();
  const tasksByPlatform = new Map<string, TaskSpec[]>();
  for (const platform of platforms) {
    const tasks = laneTasks(spec, platform, selectors, args.noDeps);
    if (tasks.length > 0) tasksByPlatform.set(platform, tasks);
  }
  if (tasksByPlatform.size === 0) {
    throw new Error("odu: nothing to run (no lane has a matching recipe)");
  }

  // ── forge coordinates ──
  const originUrl = tryGit(repoRoot, ["remote", "get-url", "origin"]);
  const github = originUrl !== null ? parseGithubRemote(originUrl) : null;
  if (ctx.posting && github === null) {
    throw new Error(
      "odu: posting commit statuses needs a github.com origin remote " +
        "(pass --no-post for non-GitHub strict runs)",
    );
  }
  for (const [platform, host] of Object.entries(lanesByPlatform)) {
    if (!tasksByPlatform.has(platform)) continue;
    if (!isLocalHost(host) && originUrl === null) {
      throw new Error(
        `odu: remote lane ${platform}=${host} needs an origin remote to fetch from`,
      );
    }
    // Live-tree mode (no snapshot) only honors a dirty tree on localhost: a
    // remote lane fetches the committed HEAD, so on a dirty tree it would
    // silently test stale code while local lanes test your edits. Refuse it
    // rather than hand back a misleading verdict.
    if (!ctx.snapshotMode && ctx.dirty && !isLocalHost(host)) {
      throw new Error(
        `odu: live-tree mode (--no-snapshot/--no-strict) on a dirty tree only ` +
          `applies to localhost lanes — remote lane ${platform}=${host} would ` +
          `fetch the committed HEAD (${ctx.sha7}), not your uncommitted changes. ` +
          `Commit and push first, or slice to local platforms with --platform.`,
      );
    }
  }

  const poster = new StatusPoster({
    owner: github?.owner ?? "",
    repo: github?.repo ?? "",
    sha,
    enabled: ctx.posting,
    onLine: info,
  });

  // ── fan-in state: one PipelineState keyed `<node>@<platform>` ──
  const order: string[] = [];
  const nodes: Record<string, NodeState> = {};
  const laneStart = new Map<string, number>();
  for (const platform of [...tasksByPlatform.keys()].sort()) {
    const tasks = tasksByPlatform.get(platform) ?? [];
    const setupId = fanId(SETUP, platform);
    order.push(setupId);
    nodes[setupId] = pendingNode({
      id: setupId,
      name: setupId,
      command: `(provision ${lanesByPlatform[platform]})`,
      needs: [],
    });
    for (const task of tasks) {
      const id = fanId(task.id, platform);
      order.push(id);
      nodes[id] = pendingNode({
        id,
        name: task.id,
        command: task.command,
        needs: [...task.needs, SETUP].map((dep) => fanId(dep, platform)),
      });
    }
  }

  const store = inMemoryStore<PipelineState>({
    name: spec.name,
    sha7,
    dirty: ctx.dirty,
    order,
    nodes,
  });
  // The run environment (lane→host map + commit link + start clock), published
  // on the surface so an `attach`-er paints the same matrix `run` does. Filled
  // in once the lanes resolve (below), before the socket starts serving.
  const headerStore = inMemoryStore<RunHeader>(EMPTY_HEADER);

  // ── per-node local logs: the in-memory tail (late socket subscribers) plus
  //    the durable per-SHA file (.ci/<sha7>/<plat>/<node>.log, justci's layout).
  //    The tail is the shared primitive; durability is this coordinator's
  //    addition, layered on top of each tail mutation. ──
  const tail = createLogTail();
  const fileFor = (id: string): string => join(repoRoot, logPathFor(sha7, id));
  const appendLocal = (id: string, text: string): void => {
    tail.append(id, text);
    const file = fileFor(id);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, text);
  };
  const resetLocal = (id: string, text: string): void => {
    tail.reset(id, text);
    const file = fileFor(id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };

  // ── the fan-in surface (status / logs / attach dial this) ──
  const lanes = new Map<string, Lane>();
  // Route a rerun request to the owning lane. A bare lane-local id (no `@`)
  // carries no platform: splitFanId reports it as the "unknown" sentinel, which
  // has no lane, so the request is unroutable — `false`, same as a missing
  // lane. The surface's `node.rerun` and the live view's `r` key both call this.
  const rerunNode = async (id: string): Promise<boolean> => {
    const { namepath, platform } = splitFanId(id);
    const lane = platform === "unknown" ? undefined : lanes.get(platform);
    if (lane === undefined) return false;
    return lane.rerun(namepath);
  };

  // ── teardown: the single path every cancel-shaped interrupt shares ──
  // Defined above the surface so the `run.cancel` mutation can drive the very
  // same teardown a SIGINT does. `closeSocket` is hoisted (assigned once the
  // socket serves, below) so this closure can reference it before it exists.
  let closeSocket: () => void = () => {};
  // Writes this run's durable record to the ledger. Hoisted like `closeSocket`:
  // a no-op until the run identity is allocated (after a possible --supersede,
  // below), then driven by every terminal path — natural completion, each
  // linger drain, and the shared `shutdown` teardown — so an interrupted or
  // cancelled run still leaves a record (marked incomplete).
  let finalizeRunRecord: (state: PipelineState) => void = () => {};
  // Linger's idle backstop: a settled-but-lingering coordinator self-reaps
  // after `idleMs` with no new work, so a forgotten `--linger` run can't hold
  // the checkout lock forever. Cleared the instant a node (re)starts.
  const idleMs = lingerIdleMs();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearIdle = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  // Linger hook: invoked on every settle (each drain, including post-rerun);
  // null in the default mode where the run exits on its first settle.
  let onSettledEach: (() => void) | null = null;

  let shuttingDown = false;
  // The single shutdown every interrupt source shares: SIGTERM/SIGINT, the live
  // view's `q` (via `onQuit`), and the `run.cancel` surface mutation a second
  // process drives (`odu cancel`, the MCP `cancel` tool, a `--supersede` start).
  // An interrupted coordinator must not strand `Running:` contexts as eternally
  // pending checks, and must hand the terminal back. Natural completion does NOT
  // pass through here — it falls through to the verdict below.
  const shutdown = (code: number, reason = "interrupted"): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearIdle();
    // Snapshot the state at the instant the interrupt lands — *before* posting,
    // settling, or letting the still-open lanes mutate it further. The record
    // must describe the run as it was when cancelled: any node still
    // pending/running here makes the outcome `incomplete`. If we instead read
    // `store.get()` after `poster.settle()` (below), a lane that happens to
    // finish naturally during that window would flip the record to passed/failed
    // for a run the operator cancelled — contradicting the incomplete semantics.
    const interruptedState = store.get();
    info(`odu: ${reason} — finalizing posted statuses before exit`);
    for (const context of poster.pendingContexts()) {
      poster.post({
        state: "error",
        context,
        description: `Errored (${reason}): ${logPathFor(sha7, context)}`,
      });
    }
    void poster.settle().then(() => {
      for (const lane of lanes.values()) lane.close();
      // Record this run before the socket closes: a superseding run waits on
      // that close to confirm we're gone, so writing first guarantees our
      // record is on disk before it allocates its own (next) seq. Use the
      // interrupt-time snapshot (not a fresh `store.get()`) so a lane that drained
      // during the settle window can't rewrite a cancelled run's verdict. Refresh
      // the timing sidecar from the same snapshot so this terminal path leaves the
      // same paired durable state every other terminal path writes.
      writeTimingSidecar(interruptedState);
      finalizeRunRecord(interruptedState);
      closeSocket();
      display.stop(interruptedState);
      process.exit(code);
    });
  };

  const runtime = implementSurface(oduSurface, {
    cells: { nodes: { store }, header: { store: headerStore } },
    streams: {
      nodeLog: { source: tail.streamSource },
    },
    procedures: {
      node: {
        rerun: async ({ input }) => ({ ok: await rerunNode(input.id) }),
      },
      run: {
        // A second process asked this run to stop. Drive the shared teardown
        // and ack at once — the caller confirms the run is gone by the socket
        // closing, not by this reply (the process exits as the queue drains).
        cancel: async () => {
          shutdown(130, "cancelled");
          return { ok: true };
        },
      },
    },
  });
  // `implementSurface` now returns the FINAL top-level router (the framework
  // owns its own in-memory channel and the oRPC finalize) — serve it directly.
  const router = runtime.router;

  // ── observers: progress stream + commit statuses, diffed per transition ──
  const emitProgress = (id: string, node: NodeState): void => {
    const event = progressEvent(sha7, id, node);
    if (event === null) return;
    display.transition(event, node);
  };

  let settled: () => void = () => {};
  const allSettled = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const checkSettled = (): void => {
    const state = store.get();
    const done = state.order.every((id) => {
      const status = state.nodes[id]?.status;
      return status !== "pending" && status !== "running";
    });
    if (done) {
      settled();
      onSettledEach?.();
    }
  };

  const updateNode = (id: string, patch: Partial<NodeState>): void => {
    const cur = store.get();
    const prev = cur.nodes[id];
    if (prev === undefined) return;
    const next = { ...prev, ...patch };
    if (
      next.status === prev.status &&
      next.exitCode === prev.exitCode &&
      next.durationMs === prev.durationMs
    ) {
      return;
    }
    runtime.ctx.cells.nodes.set({
      ...cur,
      nodes: { ...cur.nodes, [id]: next },
    });
    display.update(store.get());
    if (next.status !== prev.status) {
      // A node (re)starting means work resumed — disarm linger's idle backstop
      // so it can't reap a run that just got a rerun.
      if (next.status === "running") clearIdle();
      emitProgress(id, next);
      const payload = statusFor(id, next.status, next.durationMs, sha7);
      if (payload !== null) poster.post(payload);
      checkSettled();
    }
  };

  // The _ci-setup node's lifecycle is coordinator-owned, not lane-mirrored:
  // its `running` start is stamped when the coordinator begins provisioning
  // (laneStart, below), and its duration is coordinator-measured because our
  // _ci-setup brackets provision+fetch+worktree, which precedes the lane
  // stream. From the lane we take only the terminal verdict (ok/failed).
  const finishSetup = (
    platform: string,
    status: NodeState["status"],
    exitCode: number | null,
  ): void => {
    const id = fanId(SETUP, platform);
    // Freeze the duration at the first terminal transition: lane frames keep
    // arriving for the rest of the run, and re-deriving Date.now() − start
    // on each one silently inflates the settled number.
    const current = store.get().nodes[id]?.status;
    if (current !== "pending" && current !== "running") return;
    const startedAt = laneStart.get(platform) ?? Date.now();
    updateNode(id, {
      status,
      exitCode,
      startedAt,
      durationMs: Date.now() - startedAt,
    });
  };

  // ── socket + lanes ──
  mkdirSync(join(repoRoot, ".ci"), { recursive: true });

  const commitUrl =
    github !== null
      ? `https://github.com/${github.owner}/${github.repo}/commit/${sha}`
      : null;
  // One run-start wall-clock, captured here and carried on the header so every
  // face (live matrix + attach) counts elapsed from the same instant. Commit
  // identity (pipeline name + sha7 + dirty) is already on `store`'s state.
  const header: RunHeader = {
    commitUrl,
    lanes: [...tasksByPlatform.keys()].sort().map((platform) => ({
      platform,
      host: lanesByPlatform[platform] as string,
    })),
    hostsSource: hostsConfig.source,
    startedAt: Date.now(),
  };
  // Supersede: cancel a run already live in this checkout (and confirm its
  // socket is gone) before we bind the lock, so "stop this, run the fixed
  // commit" is one invocation. A no-op when nothing is live. Gate on the
  // confirmation — same as the MCP path — so a stuck old run fails with a
  // supersede-specific message rather than `serveSocket`'s opaque lock error.
  if (args.supersede) {
    const { confirmed } = await cancelRun(join(repoRoot, SOCKET_PATH));
    if (!confirmed) {
      process.stderr.write(
        "odu: supersede — the run already in progress here did not shut down in time.\n",
      );
      return 1;
    }
  }
  // ── run identity — the durable record's (repo, sha, seq) ──
  // Allocated *after* a possible --supersede cancel: a superseded run writes
  // its own record before its socket closes (the teardown above), so by the
  // time we get here that record is on disk and we take the next seq rather
  // than colliding on it. `repo` is the GitHub owner/repo or null for a
  // local-only checkout; `seq` distinguishes repeat runs of one commit.
  const repo = github !== null ? repoSlug(github) : null;
  const seq = allocateSeq(repoRoot, sha7);
  finalizeRunRecord = (state: PipelineState): void => {
    try {
      writeRunRecord(
        repoRoot,
        sha7,
        buildRunRecord({
          repo,
          sha,
          seq,
          dirty: ctx.dirty,
          startedAt: header.startedAt,
          finishedAt: Date.now(),
          lanes: header.lanes,
          state,
        }),
      );
    } catch {
      // best-effort: the run history is a convenience, never a gate — a failed
      // record write must not fail the run or mask its verdict.
    }
  };

  // Publish before serving so an `attach` connecting in the first instant reads
  // the real header, not the EMPTY_HEADER default.
  headerStore.set(header);
  closeSocket = await serveSocket(router, join(repoRoot, SOCKET_PATH));

  display.start(store.get(), header);
  display.update(store.get());

  for (const platform of [...tasksByPlatform.keys()].sort()) {
    const host = lanesByPlatform[platform] as string;
    const tasks = tasksByPlatform.get(platform) ?? [];
    const setupId = fanId(SETUP, platform);
    laneStart.set(platform, Date.now());
    updateNode(setupId, { status: "running", startedAt: Date.now() });

    const local = isLocalHost(host);
    const lane = startLane({
      platform,
      host,
      tasks,
      pipelineName: spec.name,
      origin: local || originUrl === null ? null : fetchUrlFor(originUrl),
      sha: local ? null : sha,
      workspace: local ? specSource : null,
      resolveDrvPath: async () => {
        const attr = `${runnerFlake}#packages.${platform}.odu-runner.drvPath`;
        const result = spawnSync(
          "nix",
          ["eval", "--raw", "--accept-flake-config", attr],
          { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
        );
        if (result.status !== 0) {
          // A flake that doesn't export odu-runner gets a directed message
          // (name the flake + the split); any other eval failure keeps the raw
          // stderr so unrelated breakage isn't masked.
          const directed = missingRunnerError(
            runnerFlake,
            platform,
            result.stderr,
          );
          if (directed !== null) throw new Error(directed);
          throw new Error(`nix eval odu-runner drv failed:\n${result.stderr}`);
        }
        return result.stdout.trim();
      },
      onSetupLine: (line) => appendLocal(setupId, `${line}\n`),
      onNodes: (laneState) => {
        for (const laneId of laneState.order) {
          const laneNode = laneState.nodes[laneId];
          if (laneNode === undefined) continue;
          if (laneId === SETUP) {
            // The coordinator owns _ci-setup's timing (finishSetup); from the
            // lane we mirror only its terminal verdict, leaving the
            // coordinator-stamped `running` start untouched until then.
            const terminal =
              laneNode.status !== "pending" && laneNode.status !== "running";
            if (terminal) {
              finishSetup(platform, laneNode.status, laneNode.exitCode);
            }
            continue;
          }
          updateNode(fanId(laneId, platform), {
            status: laneNode.status,
            exitCode: laneNode.exitCode,
            startedAt: laneNode.startedAt,
            durationMs: laneNode.durationMs,
          });
        }
      },
      onLogFrame: (laneId, frame) => {
        const id = fanId(laneId, platform);
        if (frame.kind === "append") {
          appendLocal(id, frame.text);
        } else if (laneId === SETUP) {
          // Never reset _ci-setup: the coordinator's provision lines precede
          // the lane stream and must survive the lane's snapshot frame.
          if (frame.text !== "") appendLocal(id, frame.text);
        } else if (frame.text !== "" || tail.logFor(id).buffer !== "") {
          resetLocal(id, frame.text);
        }
      },
      onDead: (error) => {
        const state = store.get();
        for (const id of state.order) {
          if (!onPlatform(id, platform)) continue;
          const status = state.nodes[id]?.status;
          if (status === "running") {
            appendLocal(id, `\n[odu] lane died: ${error}\n`);
            const startedAt = state.nodes[id]?.startedAt ?? Date.now();
            updateNode(id, {
              status: "errored",
              durationMs: Date.now() - startedAt,
            });
          } else if (status === "pending") {
            updateNode(id, { status: "skipped" });
          }
        }
      },
    });
    // Register the session for the runCommand `finally` sweep the instant it
    // exists — before `lanes.set` — so a throw later in this loop still leaves
    // every already-built lane reachable for teardown.
    createdLanes.add(lane);
    lanes.set(platform, lane);
  }

  // `shutdown` (the shared teardown) is defined above the surface so the
  // `run.cancel` mutation can drive it; here we only attach the OS signals.
  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(130));

  // ── verdict artifacts ──
  // The per-node timing sidecar report.sh scrapes — durations odu owns in its
  // state cell, written directly rather than re-parsed from logs. Refreshed on
  // every settle in linger mode (a post-rerun drain updates it); written once on
  // a normal run's completion. Best-effort: a missing sidecar only degrades the
  // metrics comment.
  const writeTimingSidecar = (state: PipelineState): void => {
    try {
      // Derive the node field set from the one shared projection; the sidecar
      // adds only its own axes — recipe/platform (splitFanId) and the node's
      // `startedAt` (not on RunNode) — so a per-node field change lands once.
      const timingLines = projectNodes(state).map((node) => {
        const { namepath, platform } = splitFanId(node.id);
        return JSON.stringify({
          node: node.id,
          recipe: namepath,
          platform,
          status: node.status,
          startedAt: state.nodes[node.id]?.startedAt ?? null,
          durationMs: node.durationMs,
          exitCode: node.exitCode,
        });
      });
      const timingsFile = join(repoRoot, ".ci", sha7, "timings.jsonl");
      mkdirSync(dirname(timingsFile), { recursive: true });
      writeFileSync(timingsFile, `${timingLines.join("\n")}\n`);
    } catch {
      // best-effort: a missing sidecar only degrades the metrics comment
    }
  };

  // Any red node (failed/errored) → the process exit code.
  const verdictCode = (state: PipelineState): number =>
    state.order.some((id) => {
      const node = state.nodes[id];
      return node !== undefined && STATUS_META[node.status].isRed;
    })
      ? 1
      : 0;

  // The human verdict summary — foreground completion only, never mid-linger
  // where the live display still owns the screen. Returns the exit code.
  const printVerdict = (state: PipelineState): number => {
    const counts = { ok: 0, failed: 0, errored: 0, skipped: 0 };
    const shaLabel = commitLabel({ sha7, dirty: ctx.dirty });
    const lines: string[] = [
      dim(
        `── ci run summary @ ${
          commitUrl !== null ? link(shaLabel, commitUrl) : shaLabel
        } ──`,
      ),
    ];
    for (const id of state.order) {
      const node = state.nodes[id];
      if (node === undefined) continue;
      if (node.status === "ok") counts.ok += 1;
      else if (node.status === "failed") counts.failed += 1;
      else if (node.status === "errored") counts.errored += 1;
      else if (node.status === "skipped") counts.skipped += 1;
      const color =
        node.status === "ok"
          ? green
          : node.status === "errored"
            ? magenta
            : node.status === "failed"
              ? red
              : dim;
      const glyph = color(STATUS_META[node.status].glyph);
      const dur =
        node.durationMs !== null
          ? ` ${dim(formatGoDuration(node.durationMs))}`
          : "";
      const logRef =
        node.status === "failed" || node.status === "errored"
          ? dim(`  ${logPathFor(sha7, id)}`)
          : "";
      lines.push(`  ${glyph} ${id.padEnd(44)} ${node.status}${dur}${logRef}`);
    }
    const code = verdictCode(state);
    lines.push(
      `${counts.ok} ok · ${counts.failed} failed · ${counts.errored} errored · ${counts.skipped} skipped — ${
        code > 0 ? bold(red("FAILED")) : bold(green("OK"))
      }`,
    );
    process.stderr.write(`${lines.join("\n")}\n`);
    return code;
  };

  if (args.linger) {
    // Keep the coordinator serving past settle so a node can be rerun after the
    // run drains (the flake-retry sub-case the agent loop wants). Refresh the
    // sidecar on every drain and arm the idle backstop; exit only via cancel /
    // signal / idle — all of which route through `shutdown`, which exits us.
    onSettledEach = (): void => {
      writeTimingSidecar(store.get());
      finalizeRunRecord(store.get());
      if (idleMs > 0) {
        clearIdle();
        idleTimer = setTimeout(
          () => shutdown(verdictCode(store.get()), "idle"),
          idleMs,
        );
        idleTimer.unref?.();
      }
    };
    // A run that already drained before we reached here fires the hook once.
    checkSettled();
    await new Promise<void>(() => {});
    return 0; // unreachable: shutdown() exits the process
  }

  await allSettled;

  for (const lane of lanes.values()) lane.close();
  // Record this run *before* releasing the socket lock — every node is already
  // terminal (allSettled), so the state is final. A superseding/next run waits
  // on the socket close to confirm we're gone and only then `allocateSeq()`s, so
  // writing the record first guarantees our `<seq>.json` is on disk before
  // anyone can allocate the next seq, and two runs can't collide on one file.
  // Mirrors the shutdown path's lock-before-record-release ordering.
  const finalState = store.get();
  writeTimingSidecar(finalState);
  finalizeRunRecord(finalState);
  closeSocket();
  await poster.settle();

  display.stop(finalState);
  return printVerdict(finalState);
}

/** Idle backstop for a `--linger` run: after the run drains, the coordinator
 *  self-reaps after this long with no new work, so a forgotten lingering run
 *  can't hold the checkout's one-run lock forever. `ODU_LINGER_IDLE_MS=0`
 *  disables it (linger until cancel/signal only); default 30 minutes. */
function lingerIdleMs(): number {
  const raw = process.env.ODU_LINGER_IDLE_MS;
  if (raw === undefined || raw === "") return 30 * 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30 * 60 * 1000;
}
