/**
 * `odu run` — the coordinator. One process owns the whole run, including the
 * venue lease (ssh-held flock per remote host — juspay/odu#54): lock lifetime
 * equals run lifetime, so crash / SIGKILL free the box when the connection
 * drops.
 *
 *   strict gate → HEAD snapshot → `just` DAG ingest → free checkout
 *   (supersede/refuse) → reserve seq → lease one free host per platform → fan
 *   lanes out (an ssh session each) → merge lane state into one fan-in surface
 *   served on `.ci/odu.sock` → write per-SHA logs + post commit statuses on
 *   transitions → verdict → release leases.
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
import { isLocalHost } from "@kolu/surface-remote";
import { bold, dim, green, link, magenta, red } from "../cli/ansi";
import { formatGoDuration } from "../common/duration";
import { gitTopLevel } from "../common/git";
import { createLogTail } from "../common/logTail";
import { fanId, onPlatform, splitFanId } from "../common/nodeId";
import type { TaskSpec } from "../common/spec";
import {
  EMPTY_HEADER,
  EMPTY_POSTING,
  type NodeState,
  oduSurface,
  pendingNode,
  type PipelineState,
  type RunHeader,
  type UnpostedEntry,
  STATUS_META,
} from "../common/surface";
import { commitLabel, createDisplay, progressEvent } from "./display";
import { laneTasks, loadJustPipeline, parseSelector } from "../just/ingest";
import { fanoutPools, loadHosts, shortHost } from "./hosts";
import { type Lane, startLane } from "./lane";
import {
  type LeaseHandle,
  leaseLanes,
  localHolderId,
} from "./lease";
import {
  liveHeldPlatforms,
  upsertPlatformLease,
  removePlatformLease,
} from "./leaseRecord";
import { resolveRunnerFlake, runnerDrvResolver } from "./runnerFlake";
import { cancelRun } from "./cancel";
import {
  liveRunLockPid,
  signalRunLockHolder,
  tryAcquireRunLock,
  waitForRunLockFree,
  type RunLockHandle,
} from "./checkoutLock";
import { releaseReservation, reserveNextSeq, writeRunRecord } from "./ledger";
import { buildRunRecord, projectNodes } from "../common/runRecord";
import { checkoutPaths, serveSocket, tryDialSocket } from "./socket";
import {
  fetchUrlFor,
  interruptStatus,
  logPathFor,
  parseGithubRemote,
  repoSlug,
  postingEqual,
  StatusPoster,
  statusFor,
  unpostedNote,
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
  /** When every host in a platform's pool is busy, fail immediately instead
   *  of waiting in line for a free machine (juspay/odu#54). */
  noWait: boolean;
}

/**
 * One-run-per-checkout prelude — runs *before* any venue lease claim so a
 * single-host pool can't deadlock: the live run holds the only remote flock,
 * and a waiter that claimed first would block forever and never reach cancel.
 *
 * Checks both the attach socket *and* the PID run-lock: lease wait happens
 * before `serveSocket`, so a live socket alone misses concurrent starters
 * that are still queued on the venue pool.
 *
 * Mirrors MCP `startRun`: supersede cancels-then-confirms (socket when up,
 * SIGTERM on the run-lock holder when only the lease wait is live); without
 * supersede a live socket/lock is an immediate refuse.
 * Exported for unit tests that assert cancel-before-claim ordering.
 *
 * Takes BOTH checkout paths (`checkoutPaths(repoRoot)`) rather than deriving
 * the lock from the socket: the supersede path SIGTERMs the lock holder, and a
 * lock inferred from a relative socket path aims that signal at whatever
 * checkout the process is cwd'd into.
 */
export async function ensureCheckoutFree(
  paths: { socketPath: string; lockPath: string },
  supersede: boolean,
  deps: {
    cancel?: typeof cancelRun;
    dial?: typeof tryDialSocket;
    signalLock?: typeof signalRunLockHolder;
    waitLockFree?: typeof waitForRunLockFree;
    liveLockPid?: typeof liveRunLockPid;
  } = {},
): Promise<
  | { ok: true }
  | { ok: false; reason: "live" | "supersede-timeout"; message: string }
> {
  const { socketPath, lockPath } = paths;
  const dial = deps.dial ?? tryDialSocket;
  const cancel = deps.cancel ?? cancelRun;
  const signalLock = deps.signalLock ?? signalRunLockHolder;
  const waitLockFree = deps.waitLockFree ?? waitForRunLockFree;
  const liveLockPid = deps.liveLockPid ?? liveRunLockPid;

  const refuseLive = {
    ok: false as const,
    reason: "live" as const,
    message:
      "odu: a run is already in progress in this checkout\n" +
      "(pass --supersede to cancel it and start fresh)",
  };

  if (supersede) {
    // Prefer graceful surface cancel when the socket is up; always clear a
    // lease-waiting holder that never reached serveSocket.
    const supersedeTimeout = {
      ok: false as const,
      reason: "supersede-timeout" as const,
      message:
        "odu: supersede — the run already in progress here did not shut down in time.",
    };
    const { confirmed } = await cancel(socketPath);
    if (!confirmed) return supersedeTimeout;
    if (liveLockPid(lockPath) !== null) {
      signalLock(lockPath, "SIGTERM");
      if (!(await waitLockFree(lockPath))) return supersedeTimeout;
    }
    return { ok: true };
  }

  const existing = await dial(socketPath);
  if (existing !== null) {
    existing.close();
    return refuseLive;
  }
  if (liveLockPid(lockPath) !== null) return refuseLive;
  return { ok: true };
}

/**
 * Interrupt stop-work seam for cancel vs venue-lease-loss.
 *
 * - `before-settle` + `exclusivityLost`: stop lanes/holds *now* — the remote
 *   flock is already free (`lease.lost`); another coordinator can claim while
 *   we still have ssh build sessions open if we wait on status settle.
 * - `after-settle`: always stop (idempotent). For cancel/SIGINT the hold is
 *   still ours during settle, so exclusivity covers GH status finalization;
 *   for lease-loss this is a no-op second pass after the early stop.
 *
 * Exported so unit tests can assert the lease-lost path invokes stop before
 * settle completes (not only that `lease.lost` resolves).
 */
export function applyInterruptStopWork(
  phase: "before-settle" | "after-settle",
  exclusivityLost: boolean,
  stop: () => void,
): void {
  // before-settle: only on exclusivity loss (flock already free).
  // after-settle: always (idempotent second pass after lease-loss early stop).
  if (phase === "after-settle" || exclusivityLost) stop();
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
  // Venue leases (ssh-held flock per remote host). Owned here so the `finally`
  // and the process-exit path both free them — crash/SIGKILL still frees via
  // the OS closing the ssh channel (the remote read hits EOF).
  const acquiredLeases: LeaseHandle[] = [];
  // Checkout run-lock (PID file under `.ci/`). Claimed inside orchestrate
  // immediately after ensureCheckoutFree and held for the whole run — including
  // the unbounded venue-lease wait before serveSocket. `finally` + process-exit
  // both release so a second starter never co-queues during lease wait.
  const runLock: { handle: RunLockHandle | null } = { handle: null };
  // runCommand-owned holder for the seq this run reserved, so the `finally` can
  // reclaim an orphaned reservation sentinel on an early-throw — the same
  // early-throw-cleanup convention as `createdLanes` / `cleanupSnapshot`
  // (releaseReservation is a guarded no-op once the seq was finalized).
  const reservation: { seq: number | null } = { seq: null };
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
      acquiredLeases,
      reservation,
      runLock,
    );
  } finally {
    cleanupSnapshot();
    for (const lane of createdLanes) lane.close();
    for (const lease of acquiredLeases) lease.release();
    acquiredLeases.length = 0;
    runLock.handle?.release();
    runLock.handle = null;
    if (reservation.seq !== null) {
      releaseReservation(repoRoot, sha7, reservation.seq);
    }
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
  /** runCommand-owned venue leases; populated once pools are claimed, released
   *  on every terminal path (finally + shutdown). */
  acquiredLeases: LeaseHandle[],
  /** runCommand-owned holder for the reserved seq, so its `finally` can reclaim
   *  an orphaned reservation sentinel on an early-throw. Set once reserved. */
  reservation: { seq: number | null },
  /** runCommand-owned checkout run-lock; claimed right after ensureCheckoutFree
   *  and released in runCommand's finally / process exit. */
  runLock: { handle: RunLockHandle | null },
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
  // Zero resolved pools means a bare `odu run` with no hosts anywhere — no
  // config file, no `--host` pin, no `--platform` slice. Defaulting that to a
  // localhost lane silently turned a fanout into a local fork-bomb on a
  // production workstation (juspay/odu#46), so `fanoutPools` refuses it loudly
  // instead — running locally stays available only as an explicit decision
  // (a `"…": "localhost"` entry or `--host PLAT=localhost`). An explicit
  // `--platform` with no host still errors earlier in resolvePools.
  // Values are *pools* (one or more hosts per platform); `leaseLanes` below
  // picks a free machine and holds the venue lock for the run (juspay/odu#54).
  // Pools AND the file they were declared in, as one value: `leaseLanes` names
  // that file in its refusals, so provenance travels with the pools rather than
  // being re-attached by hand at the lease call.
  const resolvedPools = fanoutPools(hostsConfig, args.hostPins, args.platforms);
  const poolsByPlatform = resolvedPools.hosts;
  const selectors = args.selectors.map(parseSelector);
  for (const selector of selectors) {
    if (
      selector.platform !== undefined &&
      poolsByPlatform[selector.platform] === undefined
    ) {
      throw new Error(
        `odu: selector platform "${selector.platform}" is not in the fanout ` +
          `(${Object.keys(poolsByPlatform).join(", ") || "no lanes"})`,
      );
    }
  }

  const platforms = Object.keys(poolsByPlatform).sort();
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
  // Pool-level prechecks (before lease): a pool that can only land on a remote
  // needs an origin; a dirty live-tree run refuses any pool that still has a
  // remote candidate (it might lease that box and silently test committed HEAD).
  for (const platform of tasksByPlatform.keys()) {
    const pool = poolsByPlatform[platform] ?? [];
    const remotes = pool.filter((h) => !isLocalHost(h));
    if (remotes.length === pool.length && originUrl === null) {
      throw new Error(
        `odu: remote lane ${platform}=[${remotes.join(", ")}] needs an origin remote to fetch from`,
      );
    }
    if (!ctx.snapshotMode && ctx.dirty && remotes.length > 0) {
      throw new Error(
        `odu: live-tree mode (--no-snapshot/--no-strict) on a dirty tree only ` +
          `applies to localhost lanes — remote host(s) in ${platform} pool ` +
          `(${remotes.join(", ")}) would fetch the committed HEAD (${ctx.sha7}), ` +
          `not your uncommitted changes. Commit and push first, pin localhost ` +
          `with --host ${platform}=localhost, or slice to local platforms.`,
      );
    }
  }

  // ── one-run-per-checkout BEFORE any venue lease ──
  // Cancel/refuse first so a single-host pool cannot deadlock: the live run
  // holds the only remote flock, and a waiter that claimed first would block
  // forever without ever reaching supersede cancel (or fail later at
  // serveSocket after waiting the whole prior run). Same order as MCP startRun.
  // The PID run-lock (claimed immediately below) covers the whole lease-wait
  // window; serveSocket remains the attach surface, not the sole exclusivity
  // gate.
  const { socketPath, lockPath } = checkoutPaths(repoRoot);
  const checkout = await ensureCheckoutFree(
    { socketPath, lockPath },
    args.supersede,
  );
  if (!checkout.ok) {
    process.stderr.write(`${checkout.message}\n`);
    return 1;
  }

  // Exclusive claim for this process — closes the TOCTOU between the free
  // check and serveSocket (which can be minutes of venue wait). A second
  // starter that lost the race refuses here rather than co-queuing.
  const claimed = tryAcquireRunLock(lockPath);
  if (claimed === null) {
    process.stderr.write(
      "odu: a run is already in progress in this checkout\n" +
        "(pass --supersede to cancel it and start fresh)\n",
    );
    return 1;
  }
  runLock.handle = claimed;

  // ── run identity — the durable record's (repo, sha, seq) ──
  // Reserved *after* a possible --supersede cancel (above): a superseded run
  // writes its own record before its socket closes, so by the time we get here
  // that record is on disk and the exclusive reservation advances past it.
  // Also *before* the venue lease so the holder label can carry `sha7#seq`
  // (and so a setup failure after claim still leaves a claimed seq to reclaim).
  // `repo` is the GitHub owner/repo or null for a local-only checkout.
  const repo = github !== null ? repoSlug(github) : null;
  // Atomically SELECT-and-RESERVE the seq durably BEFORE the socket serves, so
  // the seq is on disk the instant it can become observable via the surface, and
  // is claimed with an exclusive create so no two runs ever hold the same slot
  // (see `reserveNextSeq`). A published `<sha7>#<seq>` is therefore globally
  // unique: even a coordinator SIGKILLed after publishing but before
  // `finalizeRunRecord` leaves its reservation on disk, so the next run of this
  // commit advances past it (juspay/odu#49). `null` means the reservation write
  // failed — the run proceeds WITHOUT a seq (no identity claim, no record)
  // rather than gating on a history write, so `seq` stays absent on the surface.
  const seq = reserveNextSeq(repoRoot, sha7);
  // Hand the reserved seq to runCommand's early-throw cleanup: if this run
  // throws before serving/finalizing, its `finally` reclaims the orphaned
  // sentinel (releaseReservation leaves a finalized record untouched).
  reservation.seq = seq;

  // ── venue lease: one free machine per platform, lock held for the run ──
  // Two layers (juspay/odu#54 CR1):
  //   1) Agent-held: `odu lease` / MCP lease left a live holder in
  //      `.ci/odu-lease.json` → use that host, skip claim/release entirely
  //      (iterate fix→run without re-queue).
  //   2) Run auto-lease: claim for the rest, release on run exit.
  // `--host` pins still force a claim path (override agent hold).
  // After checkout free + run-lock + seq reserve so supersede can't deadlock.
  const activePlatforms = [...tasksByPlatform.keys()].sort();
  const runLabel = seq !== null ? `${sha7}#${seq}` : sha7;
  const pinPlatforms = new Set(
    args.hostPins.map((p) => p.split("=")[0]).filter((x): x is string => !!x),
  );
  const agentHeld = liveHeldPlatforms(repoRoot);
  const lanesByPlatform: Record<string, string> = {};
  const platformsToClaim: string[] = [];
  for (const platform of activePlatforms) {
    if (pinPlatforms.has(platform)) {
      platformsToClaim.push(platform);
      continue;
    }
    const held = agentHeld[platform];
    if (held !== undefined) {
      lanesByPlatform[platform] = held;
      info(
        `${platform}: using agent-held ${held} (odu lease — lock untouched on run exit)`,
      );
      continue;
    }
    platformsToClaim.push(platform);
  }
  if (platformsToClaim.length > 0) {
    // Observable wait: record waiting state for platforms we're about to claim
    // so `odu hosts` / re-reads of the lease file see the line (CR2).
    for (const platform of platformsToClaim) {
      upsertPlatformLease(repoRoot, platform, {
        host: null,
        holderPid: process.pid,
        since: Date.now(),
        state: "waiting",
        waitingBehind: null,
        run: runLabel,
      });
    }
    try {
      const claimed = await leaseLanes({
        pools: resolvedPools,
        platforms: platformsToClaim,
        identity: { holder: localHolderId(), run: runLabel },
        noWait: args.noWait,
        onLine: info,
        resolveDrvPath: (platform) =>
          runnerDrvResolver(runnerFlake, platform),
      });
      for (const [p, h] of Object.entries(claimed.lanes)) {
        lanesByPlatform[p] = h;
      }
      acquiredLeases.push(...claimed.leases);
    } finally {
      // Drop run-owned waiting records (this pid). Agent-held platforms were
      // never in platformsToClaim, so their records stay.
      for (const platform of platformsToClaim) {
        removePlatformLease(repoRoot, platform);
      }
    }
  }

  // ── fan-in state: one PipelineState keyed `<node>@<platform>` ──
  // Poster is bound after `implementSurface` so `onHealth` publishes onto the
  // cell from construction (no deferred rebinding).
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
    posting: EMPTY_POSTING,
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
  // a no-op until `finalizeRunRecord` is wired after the surface exists (seq is
  // already reserved above), then driven by every terminal path — natural
  // completion, each linger drain, and the shared `shutdown` teardown — so an
  // interrupted or cancelled run still leaves a record (marked incomplete).
  // `unposted` is the GitHub reporting debt still owed after finalize (or the
  // live debt on a mid-linger refresh).
  let finalizeRunRecord: (
    state: PipelineState,
    unposted?: ReadonlyArray<UnpostedEntry>,
  ) => void = () => {};
  // Has a record for this run already been written? Only then can a resumed
  // node leave a stale verdict on disk, so `updateNode` re-finalizes only in
  // that case — a run that has never drained has nothing on disk to correct,
  // and writing one early would list a live run in `odu runs`.
  let recordWritten = false;
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
  // Hoisted: cancel procedure + lease.lost wire before the real body is assigned
  // (poster is constructed after implementSurface so onHealth is live).
  let shutdown: (
    code: number,
    reason?: string,
    opts?: { exclusivityLost?: boolean },
  ) => void = () => {};

  // Fail closed if a remote hold dies mid-run (ssh drop, optional MAX_HOLD,
  // remote kill): exclusivity is gone and another laptop can claim the same
  // flock. Intentional `release()` does not fire `lost`.
  for (const lease of acquiredLeases) {
    void lease.lost?.then(() => {
      shutdown(1, `venue lease lost on ${shortHost(lease.host)}`, {
        exclusivityLost: true,
      });
    });
  }

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

  // Poster after fan-in cell exists: onHealth is real from construction.
  const poster = new StatusPoster({
    owner: github?.owner ?? "",
    repo: github?.repo ?? "",
    sha,
    enabled: ctx.posting,
    onLine: info,
    onHealth: (health) => {
      const cur = store.get();
      if (postingEqual(cur.posting, health)) return;
      runtime.ctx.cells.nodes.set({ ...cur, posting: health });
      // Surface cell alone does not repaint the live TUI warning strip.
      display.update(store.get());
    },
  });
  // Read-before-write: contexts GitHub already shows in the desired state
  // become no-ops (eliminates the restart "pending wave").
  if (ctx.posting && github !== null) {
    await poster.seed();
  }

  // The single shutdown every interrupt source shares: SIGTERM/SIGINT, the live
  // view's `q` (via `onQuit`), the `run.cancel` surface mutation a second
  // process drives (`odu cancel`, the MCP `cancel` tool, a `--supersede` start),
  // and venue `lease.lost` (remote hold died — flock already free). An interrupted
  // coordinator must not strand `Running:` contexts as eternally pending checks,
  // and must hand the terminal back. Natural completion does NOT pass through
  // here — it falls through to the verdict below.
  //
  // `exclusivityLost`: when true (lease.lost only), stop lanes and drop local
  // hold handles *before* awaiting poster.settle — the flock is already free so
  // another coordinator can claim immediately. Cancel/SIGINT leave exclusivity
  // intact until after settle (still holding the remote flock), then release.
  shutdown = (
    code: number,
    reason = "interrupted",
    opts: { exclusivityLost?: boolean } = {},
  ): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearIdle();
    const exclusivityLost = opts.exclusivityLost === true;
    const stopWork = (): void => {
      for (const lane of lanes.values()) lane.close();
      // Free venue leases so the remote flock drops immediately rather than
      // waiting for the OS to reap our ssh children on process death (crash
      // paths still free via connection close — this is the clean path). On
      // lease.lost the flock is already free; release still reaps local hold
      // children so we do not leave heartbeats running.
      for (const lease of acquiredLeases) lease.release();
      acquiredLeases.length = 0;
    };
    // Fail-closed on exclusivity loss: stop fanout work before any settle wait.
    applyInterruptStopWork("before-settle", exclusivityLost, stopWork);
    // Snapshot the state at the instant the interrupt lands — *before* posting,
    // settling, or letting the still-open lanes mutate it further. The record
    // must describe the run as it was when cancelled: any node still
    // pending/running here makes the outcome `incomplete`. If we instead read
    // `store.get()` after `poster.settle()` (below), a lane that happens to
    // finish naturally during that window would flip the record to passed/failed
    // for a run the operator cancelled — contradicting the incomplete semantics.
    // On lease.lost, lanes are already closed above so the snapshot cannot race
    // with further fanout progress either.
    const interruptedState = store.get();
    info(`odu: ${reason} — finalizing posted statuses before exit`);
    for (const context of poster.pendingContexts()) {
      poster.post(interruptStatus(context, reason, sha7));
    }
    void poster.finalize().then((unposted) => {
      applyInterruptStopWork("after-settle", exclusivityLost, stopWork);
      // Record this run before the socket closes: a superseding run waits on
      // that close to confirm we're gone, so writing first guarantees our
      // record is on disk before it allocates its own (next) seq. Use the
      // interrupt-time snapshot (not a fresh `store.get()`) so a lane that drained
      // during the settle window can't rewrite a cancelled run's verdict. Refresh
      // the timing sidecar from the same snapshot so this terminal path leaves the
      // same paired durable state every other terminal path writes.
      writeTimingSidecar(interruptedState);
      finalizeRunRecord(interruptedState, unposted);
      closeSocket();
      display.stop(interruptedState);
      process.exit(code);
    });
  };

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
      // so it can't reap a run that just got a rerun, and REFRESH the durable
      // record if one already describes this run. `--linger` keeps one
      // `(sha7, seq)` file and rewrites it on every drain, so a lingering run
      // that passed and then took a `node_rerun` would otherwise leave an
      // on-disk `passed` for a run that is running again. `buildRunRecord`
      // derives `incomplete` from the live state, so re-finalizing here means
      // the ledger never carries a green verdict for a run in flight — and no
      // reader has to compare its own clock against `finishedAt` to notice.
      if (next.status === "running") {
        clearIdle();
        if (recordWritten) finalizeRunRecord(store.get(), poster.unposted());
      }
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
  // Stamp the reserved seq onto the fan-in state so every face — the agent
  // `wait_for_settle` verdict especially — reads the run's full identity
  // `<sha7>#<seq>`. Set once here, before the socket serves; `updateNode` spreads
  // the whole state, so it survives every node update. `undefined` (no reserved
  // seq) leaves the field absent, mapped to `null` on the agent surface.
  // (seq itself was reserved before the venue lease — see above.)
  runtime.ctx.cells.nodes.set({ ...store.get(), seq: seq ?? undefined });
  if (seq !== null) {
    finalizeRunRecord = (state, unposted): void => {
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
            unposted: unposted ?? poster.unposted(),
          }),
        );
        recordWritten = true;
      } catch {
        // best-effort: the run history is a convenience, never a gate — a failed
        // record write must not fail the run or mask its verdict.
      }
    };
  }
  // No reserved seq → `finalizeRunRecord` stays the default no-op: a run that
  // couldn't reserve an identity writes no record and claims no `<sha7>#<seq>`.

  // Publish before serving so an `attach` connecting in the first instant reads
  // the real header, not the EMPTY_HEADER default.
  headerStore.set(header);
  // Checkout run-lock is already held (covers lease wait); serveSocket is the
  // attach surface and a second exclusivity gate for the post-lease window.
  closeSocket = await serveSocket(router, socketPath);

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
      resolveDrvPath: runnerDrvResolver(runnerFlake, platform),
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
  const printVerdict = (
    state: PipelineState,
    unposted: ReadonlyArray<UnpostedEntry> = [],
  ): number => {
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
    const debt = unpostedNote(unposted.length);
    lines.push(
      `${counts.ok} ok · ${counts.failed} failed · ${counts.errored} errored · ${counts.skipped} skipped — ${
        code > 0 ? bold(red("FAILED")) : bold(green("OK"))
      }${debt !== "" ? dim(debt) : ""}`,
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
      // Live debt only — poster keeps retrying until shutdown finalizes.
      finalizeRunRecord(store.get(), poster.unposted());
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
  // Venue locks drop with the run — free them as soon as lanes are done so the
  // next waiter can claim the box while we still finalize statuses/records.
  for (const lease of acquiredLeases) lease.release();
  acquiredLeases.length = 0;
  // Final status reconciliation *before* the record write and socket release —
  // one last attempt at anything still owed, then stamp what failed into the
  // durable record so the divergence stays visible after exit (juspay/odu#61).
  const finalState = store.get();
  writeTimingSidecar(finalState);
  const unposted = await poster.finalize();
  finalizeRunRecord(finalState, unposted);
  closeSocket();

  display.stop(finalState);
  return printVerdict(finalState, unposted);
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
