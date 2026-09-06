/**
 * `odu run` — the coordinator. One process owns the whole run, including the
 * venue lease (ssh-held flock per remote host — juspay/odu#54): lock lifetime
 * equals run lifetime, so crash / SIGKILL free the box when the connection
 * drops.
 *
 *   strict gate → HEAD snapshot → `just` DAG ingest → free checkout
 *   (supersede/refuse) → reserve seq → serve the fan-in surface on
 *   `.ci/odu.sock` → lease one free host per platform → fan lanes out (an ssh
 *   session each) → merge lane state into that surface → write per-SHA logs +
 *   post commit statuses on transitions → verdict → release leases.
 *
 * The socket comes up BEFORE the venue lease (juspay/odu#84). Claiming a cold
 * host is a multi-minute `nix copy` of the runner closure, and with the socket
 * still down that whole window answered `status` / `attach` / `logs` / `wait`
 * with "no run in progress" — the same words as a run that died or never
 * started. Serving first costs nothing (every input the surface needs is
 * already resolved) and makes provisioning a phase the run can be watched
 * through: `_ci-setup@<platform>` runs from the claim, its log carries the
 * copy's own narration, and the run header says which pool each lane is
 * claiming from until it has a host.
 *
 * Status posting and `--progress json` are both *diff-driven off the fan-in
 * state*, so every observer derives from the same source of truth the
 * dashboards attach to.
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { implementSurface, inMemoryStore } from "@kolu/surface/server";
import { Effect } from "effect";
import { isLocalHost } from "@kolu/surface-remote";
import {
  fanId,
  isSetupNode,
  logPathFor,
  onPlatform,
  SETUP_NAMEPATH,
  splitFanId,
} from "@odu/run-client/nodeId";
import {
  claimingLanes,
  EMPTY_POSTING,
  leasedLanes,
  type NodeState,
  type NodeStatus,
  oduSurface,
  pendingNode,
  type PipelineState,
  type RunHeader,
  type RunLane,
  runPhase,
} from "@odu/run-client/surface";
import { dialRun } from "@odu/run-client/dial";
import {
  exitCode,
  NON_TERMINAL_STATUSES,
} from "../common/verdict";
import {
  type MakeRunFace,
  progressEvent,
  SILENT_FACE,
} from "../common/presentation";
import { gitTopLevel } from "../common/git";
import { appendIfOpen, createNodeLogSink } from "./nodeLogSink";
import { createVerdictGate } from "./verdictGate";
import { maxLaneResurrections } from "./laneResurrection";
import type { TaskSpec } from "../common/spec";
import { laneTasks, loadJustPipeline, parseSelector } from "../just/ingest";
import { asHostSlot, fanoutPools, loadHosts, shortHost } from "./hosts";
import { type Lane, startLane } from "./lane";
import {
  ExecutionRoster,
  type ExecutionLane,
} from "./executionRoster";
import {
  leaseBurstSlots,
  type LeaseHandle,
  localHolderId,
} from "./lease";
import {
  claimPlatformsIndependently,
  claimVenues,
  type ClaimOutcome,
  prepareVenues,
  type PreparedVenues,
} from "./runEnv";
import { liveHeldPlatforms } from "./leaseRecord";
import { resolveRunnerFlake, runnerDrvResolver } from "./runnerFlake";
import { cancelRun } from "./cancel";
import {
  liveRunLockPid,
  signalRunLockHolder,
  tryAcquireRunLock,
  waitForRunLockFree,
  type RunLockHandle,
} from "./checkoutLock";
import { releaseReservation, reserveNextSeq, writeRunRecord } from "@odu/run-history/legacy/ledger";
import { openRunHistory } from "./history";
import { ODU_VERSION } from "../common/version";
import {
  buildRunRecord,
  outcomeOfNodes,
  projectNodes,
  type UnpostedEntry,
} from "@odu/run-history/legacy/record";
import {
  checkoutPaths,
  serveSocket,
  socketLogger,
} from "./socket";
import {
  fetchUrlFor,
  interruptStatus,
  parseGithubRemote,
  repoSlug,
  postingEqual,
  StatusPoster,
  statusFor,
  unpostedNote,
} from "./statuses";
import {
  dependencyClosure,
  installShardTopology,
  shareShardCapacity,
  shardAggregateDuration,
  shardAggregateStatus,
  shardLaneProjection,
  shardNamepath,
  shardRootIds,
  tasksForShard,
  type ShardTopology,
} from "./shards";

const SETUP = SETUP_NAMEPATH;

export interface RunArgs {
  selectors: string[];
  platforms: string[];
  hostPins: string[];
  root?: string;
  noDeps: boolean;
  noStrict: boolean;
  noSnapshot: boolean;
  noPost: boolean;
  /** Cancel a run already live in this checkout before starting, instead of
   *  refusing on the one-run lock — "stop this, run the fixed commit". */
  supersede: boolean;
  /** Keep the coordinator serving after the run drains, so a node can be
   *  rerun post-settle; exit only on cancel / signal / idle backstop. */
  linger: boolean;
  /** When every host in a platform's pool is busy, fail immediately instead
   *  of waiting in line for a free machine (juspay/odu#54). */
  noWait: boolean;
  /** The commit this run claims to be about.
   *
   *  A LAUNCHER's guard, and the whole of "never substitute current HEAD". A
   *  replay is started from a recorded run's inputs, and between the record
   *  and the launch the checkout may have moved — so the child is TOLD what it
   *  is supposed to be running and refuses if it is not. Absent for a run
   *  somebody typed: HEAD is then, by definition, what they meant. */
  expectedSha?: string;
  /** The catalog id this run must publish under, minted by whoever launched
   *  it. Absent means mint one — the ordinary path. See `./launcher` on why a
   *  launcher pre-mints. */
  runId?: string;
  /** The run this one replays, for a recovery launch. */
  parentRunId?: string;
  /** The launcher's idempotency key, recorded on the manifest so a receipt and
   *  a run can be matched up after the fact. */
  requestId?: string;
}

/**
 * One-run-per-checkout prelude — runs *before* any venue lease claim so a
 * single-host pool can't deadlock: the live run holds the only remote flock,
 * and a waiter that claimed first would block forever and never reach cancel.
 *
 * Checks both the attach socket *and* the PID run-lock: startup (strict gate,
 * DAG ingest, seq reservation) happens before `serveSocket`, so a live socket
 * alone misses a concurrent starter that has not reached it yet.
 *
 * Mirrors MCP `startRun`: supersede cancels-then-confirms (socket when up,
 * SIGTERM on the run-lock holder when only startup is live); without
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
    dial?: typeof dialRun;
    signalLock?: typeof signalRunLockHolder;
    waitLockFree?: typeof waitForRunLockFree;
    liveLockPid?: typeof liveRunLockPid;
  } = {},
): Promise<
  | { ok: true }
  | { ok: false; reason: "live" | "supersede-timeout"; message: string }
> {
  const { socketPath, lockPath } = paths;
  const dial = deps.dial ?? dialRun;
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
    // still-starting holder that never reached serveSocket.
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
    // Awaited, not dropped: the link owns a scope holding the protocol fibers
    // (`DialedRun.close` is async for that reason), and this probe runs on
    // every `odu run` — the one path that dials only to find out whether
    // anyone is home. `runTool.ts`'s identical probe already awaits it.
    await existing.close();
    return refuseLive;
  }
  if (liveLockPid(lockPath) !== null) return refuseLive;
  return { ok: true };
}

/**
 * The reservation sentinel's lifecycle: no ordinal was ever claimed
 * (`reserveNextSeq` returned `null`), or one was and `published` tracks
 * whether it has since been served on the socket. The discriminant makes
 * `{ seq: null, published: true }` unrepresentable — `published` can only
 * exist once `seq` does, so a run that never got an ordinal can no longer be
 * marked published (see the `serveSocket` call site in `orchestrate`, which
 * used to set `published = true` unconditionally even when `seq` stayed
 * `null`, a state `shouldReclaimReservation` happened to treat as harmless
 * only because it also checks `seq !== null`).
 */
export type ReservationState =
  | { status: "unreserved" }
  | { status: "reserved"; seq: number; published: boolean };

/**
 * Reclaim an orphaned reservation sentinel only while the identity was never
 * served. Once `sha7#seq` has been published on the socket a reader may key a
 * verdict on it (`wait_for_settle` reads the record BY that address), so
 * handing the ordinal back — after, say, a swallowed `finalizeRunRecord` write
 * left the sentinel in place — would let the next run of this commit reserve
 * the same slot and answer for a different run. A stale sentinel only burns an
 * ordinal; a reused one corrupts an identity (juspay/odu#49).
 */
export function shouldReclaimReservation(
  reservation: ReservationState,
): reservation is { status: "reserved"; seq: number; published: false } {
  return reservation.status === "reserved" && !reservation.published;
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

/** Do two commit spellings name the same commit? A prefix match either way,
 *  case-insensitive, so a 7-char short sha and a full 40-char one both
 *  satisfy an expectation — the same rule `wait_for_settle`'s `expected_sha`
 *  already uses, so a caller does not learn two. An empty side never matches:
 *  a missing sha must not silently satisfy an expectation. */
export function sameCommit(observed: string, expected: string): boolean {
  if (observed === "" || expected === "") return false;
  const o = observed.toLowerCase();
  const e = expected.toLowerCase();
  return o.startsWith(e) || e.startsWith(o);
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

/** The collaborators that dial ssh, injectable. Each spends minutes in ssh/Nix
 * bootstrap, so tests substitute controllable promises and fakes at this one
 * environment boundary — including the coordinator's reaction to a lane DYING,
 * a rule worth being able to falsify without a builder (see
 * `run.resurrection.test.ts`).
 *
 * A `startLane` fake owes the coordinator the lane FRAME PROTOCOL, not just the
 * method signatures: a real lane opens each node's log subscription with a
 * `snapshot` frame, and a fake that skips it hides every bug in what the
 * coordinator does with one. */
export interface RunDeps {
  claimVenues?: typeof claimVenues;
  leaseBurstSlots?: typeof leaseBurstSlots;
  startLane?: typeof startLane;
  /** How this run is watched. Absent is SILENCE, not "the terminal one": a
   *  coordinator that has to reach for a renderer to run is a coordinator no
   *  service can host. `src/main.ts` supplies the terminal face; a test
   *  supplies nothing and reads the exit code. */
  face?: MakeRunFace;
}

/** Status overlay `terminalizePlatformNodes` applies when a lane dies or is
 *  cancelled. `undefined` means leave the node — already terminal, `ok`
 *  included. A green run survives a post-verdict lane death because this
 *  returns `undefined` for `ok`, not because teardown cannot write statuses. */
export function overlayOnLaneStop(
  status: NodeStatus,
  strategy: {
    running: "cancelled" | "errored";
    pending: "cancelled" | "skipped";
  },
): NodeStatus | undefined {
  if (status === "running") return strategy.running;
  if (status === "pending") return strategy.pending;
  return undefined;
}

export async function runCommand(
  args: RunArgs,
  deps: RunDeps = {},
): Promise<number> {
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

  // A launcher told us which commit this run is supposed to be about. REFUSE
  // rather than run the one that is here: a replay of a recorded run that
  // quietly ran a different commit would be the single most misleading thing
  // this program could do — the verdict would be about work nobody asked for,
  // under a run id somebody is already holding.
  if (args.expectedSha !== undefined && !sameCommit(sha, args.expectedSha)) {
    process.stderr.write(
      `odu: this checkout is at ${sha7}, not ${args.expectedSha.slice(0, 7)} — ` +
        "refusing to run a different commit than the one asked for.\n" +
        `Check out ${args.expectedSha.slice(0, 7)} in ${repoRoot} and try again.\n`,
    );
    return 1;
  }

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
  // the startup window before serveSocket. `finally` + process-exit both
  // release so a second starter never co-queues on the venue pool.
  const runLock: { handle: RunLockHandle | null } = { handle: null };
  // runCommand-owned holder for the seq this run reserved, so the `finally` can
  // reclaim an orphaned reservation sentinel on an early-throw — the same
  // early-throw-cleanup convention as `createdLanes` / `cleanupSnapshot`
  // (releaseReservation is a guarded no-op once the seq was finalized).
  // `published` gates the reclaim below: once `sha7#seq` has been served on the
  // socket it is observable, and a reader (`wait_for_settle`) may key a verdict
  // on it. Reclaiming the sentinel then would let a later run of this commit
  // reserve the SAME ordinal — the exact reuse the reservation exists to
  // prevent (juspay/odu#49), and a stale sentinel is the cheaper failure.
  // Boxed (`{ current }`) rather than a bare `ReservationState` so `orchestrate`
  // can hand back a new state by reassigning the field — a discriminated union
  // is replaced wholesale, not mutated field-by-field.
  const reservation: { current: ReservationState } = {
    current: { status: "unreserved" },
  };
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
      deps,
    );
  } finally {
    cleanupSnapshot();
    for (const lane of createdLanes) lane.close();
    for (const lease of acquiredLeases) lease.release();
    acquiredLeases.length = 0;
    runLock.handle?.release();
    runLock.handle = null;
    if (shouldReclaimReservation(reservation.current)) {
      releaseReservation(repoRoot, sha7, reservation.current.seq);
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
  reservation: { current: ReservationState },
  /** runCommand-owned checkout run-lock; claimed right after ensureCheckoutFree
   *  and released in runCommand's finally / process exit. */
  runLock: { handle: RunLockHandle | null },
  /** See {@link RunDeps} — the venue claim, injectable so a test can hold one
   *  open across the socket's cancel/teardown paths. */
  deps: RunDeps,
): Promise<number> {
  const { repoRoot, specSource, runnerFlake, sha, sha7 } = ctx;
  // One asynchronous Nix evaluation per platform for the whole run. Claims,
  // optional capacity and execution lanes all ask for the same runner; making
  // separate resolvers repeated setup work and, before runnerFlake's async
  // fix, repeatedly froze the live renderer.
  const runnerResolvers = new Map<
    string,
    ReturnType<typeof runnerDrvResolver>
  >();
  const runnerResolverFor = (platform: string) => {
    const existing = runnerResolvers.get(platform);
    if (existing !== undefined) return existing;
    const resolver = runnerDrvResolver(runnerFlake, platform);
    runnerResolvers.set(platform, resolver);
    return resolver;
  };
  // The FACE, built by whoever started this run — see `common/presentation`.
  // The engine hands over the seam an interactive face needs (the focused
  // node's log, the rerun verb, what quitting costs) and learns nothing about
  // what the face does with it: a terminal paints a matrix, a pipe emits
  // NDJSON, a service face paints nothing. The default is silence, so a caller
  // that wants only an exit code gets one without wiring a renderer.
  const face = (deps.face ?? SILENT_FACE)({
    openLog: (id) => logs.streamSource({ id }),
    rerun: (id) => void rerunNode(id),
    onQuit: () => shutdown(130),
  });
  const display = face.display;
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
    if (tasks.length > 0) {
      const sharded = tasks.filter((task) => task.shards !== undefined);
      if (args.linger && sharded.length > 0) {
        throw new Error("odu: --linger is not yet supported with sharded recipes");
      }
      tasksByPlatform.set(platform, tasks);
    }
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
    const remotes = pool
      .map((entry) => asHostSlot(entry).host)
      .filter((host) => !isLocalHost(host));
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
  // The PID run-lock (claimed immediately below) covers the startup window
  // before the socket serves; serveSocket remains the attach surface, not the
  // sole exclusivity gate.
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
  // check and serveSocket. A second starter that lost the race refuses here
  // rather than co-queuing.
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
  // sentinel (releaseReservation leaves a finalized record untouched). `seq
  // === null` (the reservation write failed) leaves `reservation.current`
  // "unreserved" — there is no ordinal to reclaim or to later mark published.
  if (seq !== null) {
    reservation.current = { status: "reserved", seq, published: false };
  }

  // ── the durable catalog: REGISTER BEFORE EXECUTING ──
  // Before the venue claim, before a lane, before the socket serves — so a
  // coordinator that dies in its first second still leaves a run somebody can
  // address, and so PR 2's service can discover runs from one place instead of
  // scanning arbitrary checkouts. The checkout ledger above is untouched: this
  // is a second, per-user record, and the two are written side by side for the
  // whole of this release.
  //
  // Never a gate. `openRunHistory` answers a no-op writer when it cannot open a
  // record (no writable state root, a live owner on the same id), and the run
  // proceeds exactly as every odu before this one did — see `./history`.
  const history = openRunHistory({
    repoRoot,
    repo,
    sha,
    seq,
    pipeline: spec.name,
    scope: {
      selectors: [...args.selectors],
      platforms: [...args.platforms],
      ...(args.root === undefined ? {} : { root: args.root }),
      noDeps: args.noDeps,
    },
    snapshotMode: ctx.snapshotMode ? "strict" : "live",
    dirty: ctx.dirty,
    runnerFlake,
    oduVersion: ODU_VERSION,
    endpoint: socketPath,
    ...(args.runId === undefined ? {} : { runId: args.runId }),
    ...(args.parentRunId === undefined ? {} : { parentRunId: args.parentRunId }),
    ...(args.requestId === undefined ? {} : { requestId: args.requestId }),
  });
  // On stderr (every face's `info` writes there), so the NDJSON stdout contract
  // `--progress json` promises is untouched. This one line is how an operator
  // or an agent learns the token that addresses this run's evidence after the
  // coordinator is gone — without it the catalog is discoverable only by
  // listing, which is a poor answer to "the one I just started".
  if (history.runId !== null) {
    info(`odu · run ${history.runId} — evidence: odu logs --run ${history.runId} <node>`);
  }

  // ── lane assignment: which machine each platform will run on ──
  // Two layers (juspay/odu#54 CR1):
  //   1) Agent-held: `odu lease` / MCP lease left a live holder in
  //      `.ci/odu-lease.json` → use that host, skip claim/release entirely
  //      (iterate fix→run without re-queue).
  //   2) Run auto-lease: claim for the rest, release on run exit.
  // `--host` pins still force a claim path (override agent hold).
  // After checkout free + run-lock + seq reserve so supersede can't deadlock.
  //
  // Only the SPLIT happens here; the claim itself waits until the fan-in socket
  // is serving (juspay/odu#84 — see the module header). What the split decides
  // is what the surface can honestly say during that window: an agent-held
  // platform already knows its host, the rest carry a pool and no host until
  // their lease resolves.
  const activePlatforms = [...tasksByPlatform.keys()].sort();
  const runLabel = seq !== null ? `${sha7}#${seq}` : sha7;
  const pinPlatforms = new Set(
    args.hostPins.map((p) => p.split("=")[0]).filter((x): x is string => !!x),
  );
  const agentHeld = liveHeldPlatforms(repoRoot);
  // Only the platforms that already HAVE a machine are recorded here. "Which
  // platforms need a claim" is not a second list to keep in step with this one
  // — it is every active platform this map does not cover, which is what the
  // header roster says (`claimingLanes(header)`), from one source of truth.
  const lanesByPlatform: Record<string, string> = {};
  for (const platform of activePlatforms) {
    // A `--host` pin forces the claim path even when an agent holds the lane.
    if (pinPlatforms.has(platform)) continue;
    const held = agentHeld[platform];
    if (held === undefined) continue;
    lanesByPlatform[platform] = held;
    info(
      `${platform}: using agent-held ${held} (odu lease — lock untouched on run exit)`,
    );
  }

  // ── fan-in state: one PipelineState keyed `<node>@<platform>` ──
  // Poster is bound after `implementSurface` so `onHealth` publishes onto the
  // cell from construction (no deferred rebinding).
  const order: string[] = [];
  const nodes: Record<string, NodeState> = {};
  for (const platform of [...tasksByPlatform.keys()].sort()) {
    const tasks = tasksByPlatform.get(platform) ?? [];
    const setupId = fanId(SETUP, platform);
    order.push(setupId);
    nodes[setupId] = pendingNode({
      id: setupId,
      name: setupId,
      // No machine named here, in either direction. Every other node's
      // `command` is the shell it runs; this one is a parenthetical nobody on
      // the fan-in side reads, and WHICH machine this lane is on is a fact the
      // header's roster owns — `claiming` with its pool, then `leased` with its
      // host. Naming it here too would be a second copy of that fact, seeded
      // before the claim and therefore stale from the moment the lease
      // resolves; the alternative, rewriting it on resolve, is upkeep on a
      // duplicate with no reader. The roster is the answer to "where"; this is
      // just what the node does.
      command: "(provision)",
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
  /** Only the declared logical DAG posts commit contexts. Internal execution
   * nodes can be added later without acquiring a second posting policy. */
  const postableNodeIds = new Set(order);
  interface ShardPlan extends ShardTopology {
    leases: LeaseHandle[];
  }
  const shardPlans = new Map<string, ShardPlan[]>();
  const burstLeaseUsers = new Map<LeaseHandle, number>();
  const plansFor = (platform: string): readonly ShardPlan[] =>
    shardPlans.get(platform) ?? [];
  const planFor = (platform: string, rootId: string): ShardPlan | undefined =>
    plansFor(platform).find((plan) => plan.rootId === rootId);
  /** The tasks a platform's primary lane runs before any shard topology
   *  exists. */
  const earlyTasksFor = (platform: string): TaskSpec[] =>
    (tasksByPlatform.get(platform) ?? []).filter(
      (task) => task.shards === undefined,
    );
  /** The platform's sharded recipe roots — from the RECIPES, so the answer
   *  exists before `plansFor` has a topology to report. A rule that read the
   *  topology instead would call a platform unsharded for the whole window
   *  between its lane starting and its shard plans being installed. */
  const shardRootsFor = (platform: string): TaskSpec[] =>
    (tasksByPlatform.get(platform) ?? []).filter(
      (task) => task.shards !== undefined,
    );
  /** The lane roster for `platforms`, in platform order, from the one source of
   *  truth (`lanesByPlatform`): a platform with a host is `leased`; one without
   *  is `claiming` from its candidate pool while the claim is in flight, and
   *  simply ABSENT once it has resolved. So "claiming" cannot survive the claim
   *  on any exit path, including ones nobody has thought of yet — it is a
   *  property of how the roster is built, not a field someone must remember to
   *  clear. */
  const rosterFrom = (
    platforms: readonly string[],
    beforeClaim: boolean,
  ): RunLane[] =>
    platforms.flatMap((platform): RunLane[] => {
      const host = lanesByPlatform[platform];
      if (host !== undefined) return [{ state: "leased", platform, host }];
      // No host yet, so the pool is the honest candidate set: a lane still
      // claiming is described by the machines it may land on, never by a
      // placeholder host.
      return beforeClaim
        ? [
            {
              state: "claiming",
              platform,
              pool: (poolsByPlatform[platform] ?? []).map(
                (entry) => asHostSlot(entry).host,
              ),
            },
          ]
        : [];
    });

  // The run environment (the lane roster + commit link + start clock),
  // published on the surface so an `attach`-er paints the same matrix `run`
  // does. Published twice: once as the store's initial value, describing a run
  // that is still claiming, and again once the lanes resolve (or the claim
  // fails) — so this cell CHANGES during a run and its readers follow it.
  //
  // The CELL is the only place this value lives: no store binding for it exists
  // in this scope, deliberately, so the non-publishing write is unspellable
  // rather than merely discouraged — see `publishHeader`. This value goes
  // straight into `implementSurface` as the cell's initial value.
  const initialHeader = ((): RunHeader => ({
    commitUrl:
      github !== null
        ? `https://github.com/${github.owner}/${github.repo}/commit/${sha}`
        : null,
    // Only what is already decided is `leased`: platforms running on an
    // agent-held lease. Everything else is `claiming` until its lease resolves.
    lanes: rosterFrom(activePlatforms, true),
    hostsSource: hostsConfig.source,
    // One run-start wall-clock, carried on the header so every face (live
    // matrix + attach) counts elapsed from the same instant. Commit identity
    // (pipeline name + sha7 + dirty) is already on `store`'s state.
    startedAt: Date.now(),
  }))();

  // ── per-node local logs: the in-memory tail (late socket subscribers) plus
  //    the durable per-SHA file (.ci/<sha7>/<plat>/<node>.log, justci's layout).
  //    The sink owns the durability mechanics — path, ownership, syscalls; what
  //    stays here is the run's own policy: which frame routes where, and when a
  //    node's log has had this run's last word. ──
  const logs = createNodeLogSink(repoRoot, sha7);
  // Bound below beside `setupLine`; declared here because interrupt teardown
  // must flush the last coalesced provisioning burst before sealing logs.
  let flushSetupLines: () => void = () => {};
  /** THE THREE LOG VERBS, and the seam where evidence forks.
   *
   *  Every byte of a node's output already funnels through exactly these three
   *  in this function, which is what makes them the right place to mirror into
   *  the durable catalog's per-attempt log. The checkout file
   *  (`.ci/<sha7>/<plat>/<node>.log`) keeps its old meaning — one file per
   *  (commit, node), overwritten by a rerun — while the catalog gets one file
   *  per ATTEMPT, sealed and read-only when the attempt ends. Both are written
   *  from the same call, so they cannot describe different output.
   *
   *  `resetLocal` is the interesting one. A reset means "what is in this log
   *  belongs to an invocation that no longer exists" — a resurrection's wipe,
   *  or a lane re-sending its snapshot — and for the catalog that is precisely
   *  an ATTEMPT BOUNDARY: the open attempt is abandoned (marked incomplete,
   *  with the reason) and the bytes that follow start a new ordinal. Without
   *  it, a rerun's output would be appended onto the failure somebody was in
   *  the middle of reading. */
  const appendLocal = (id: string, text: string): void => {
    if (logs.isEnded(id)) return;
    logs.append(id, text);
    history.log(id, text);
  };
  const resetLocal = (id: string, text: string): void => {
    logs.reset(id, text);
    history.resetNode(
      id,
      "this node was re-run; the attempt's output was superseded",
    );
    if (text !== "") history.log(id, text);
  };
  const endLocal = (id: string): void => {
    logs.end(id);
    history.logFinalized(id, true, null);
  };
  /** The run's last word on every node's log. `end` is a promise to a reader
   *  that nothing more is coming, and only the party still able to write can
   *  make it: for a recipe node that is its lane, but for `_ci-setup@<plat>` it
   *  is the RUN — the coordinator keeps narrating lane death and operator
   *  cancels into that log long after the lane's own half of it is done, which
   *  is why the lane's `end` frame for it is deliberately dropped. Called once
   *  the lanes are closed, from both terminal paths (natural completion and
   *  `shutdown`), so the fan-in's three-frame protocol is TOTAL: every node
   *  that reaches a terminal status gets its log ended by whoever owns that
   *  outcome, and `odu logs -f <node>` returns on every one of them. */
  const endRunLogs = (): void => {
    for (const id of store.get().order) endLocal(id);
  };

  /** Write the one sentence that says a node's log is short, and why.
   *
   *  ONE producer, because this notice is a contract: the e2e suite greps for
   *  it, and every round of review on it has been about the same rule — a
   *  truncation notice is worth exactly its worst sentence. Two copies of the
   *  wording are two chances for one to drift out of that guarantee.
   *
   *  Sealed logs are skipped by `appendLocal` (`appendIfOpen`). A log ends
   *  when its owner has said its last word, and `append` after `end` THROWS by
   *  design — so a second party stamping a sealed log does not merely repeat
   *  itself, it kills the coordinator. That is not hypothetical: an operator
   *  `odu cancel @<platform>` ends the dropped lane's node logs with the true
   *  `cancelled by operator (lane)` line, and the settle that follows found
   *  those same nodes still in the lane's undrained set and stamped them again
   *  — `logTail: append to slow@x86_64-linux after its log ended`, run dead.
   *  Two bookkeepings of "is this node still owed output" (the lane's, from
   *  frames it received; the sink's, from logs it sealed) will disagree at
   *  exactly the moments that matter, so the one that knows the log is SEALED
   *  gets the last say — and every coordinator write, not only this stamp,
   *  asks it. */
  const stampTruncated = (id: string, cause: string): void => {
    appendLocal(
      id,
      `\n[odu] log truncated: ${cause} with this node's output still owed` +
        " — what follows the last line was never received\n",
    );
    // And say it in the RECORD, not only in the bytes. A face reading the
    // catalog asks a field, not a sentence: `log_complete: false` with this
    // cause is what stops an agent from treating a short log as the whole
    // story. First word wins, so the `endRunLogs` sweep that follows cannot
    // upgrade this node's log back to "complete".
    history.logFinalized(id, false, cause);
  };

  /** Say what a torn-down run's logs lost, before `endRunLogs` says they ended.
   *
   *  Which nodes were owed output is answered from what each log IS, not from
   *  what its node's status suggests: a log that has not published its terminal
   *  is one the run was still expecting bytes for. Status only excludes the
   *  nodes that were never owed anything — `pending` (never started) and
   *  `skipped` (never runs, and the runner ends its log at the moment it is
   *  skipped). Stamping those would be its own small lie. No duration: nothing
   *  was measured here, the run was simply stopped. */
  const stampUnfinishedLogs = (): void => {
    const state = store.get();
    for (const id of state.order) {
      const status = state.nodes[id]?.status;
      if (status === undefined || status === "pending" || status === "skipped") {
        continue;
      }
      // `_ci-setup` is the one node whose open log does NOT mean bytes are
      // owed: the fan-in withholds its terminal on purpose, so the coordinator
      // can keep narrating lane death and operator cancels into it long after
      // the lane is done. `isEnded` is therefore permanently false for it, and
      // the general test would stamp every interrupted run that merely got past
      // provisioning with a loss that did not happen. For setup the honest
      // question is whether the prep itself was cut — i.e. is it still running.
      // (Every other node is filtered by `stampTruncated`'s sealed-log test,
      // which is the same question asked of the party that can answer it.)
      if (splitFanId(id).namepath === SETUP && status !== "running") continue;
      stampTruncated(id, "the run was stopped");
    }
  };

  /** Wait for every lane to finish streaming the output it still owes, and
   *  stamp the ones that never did. Truncation stops being a thing you notice
   *  weeks later by grepping for a summary that isn't there: either the log is
   *  complete, or it says so in its own last line.
   *
   *  This is the verdict gate's BOUND (`drainLogs`), reached only when the DAG
   *  is done and nothing but output is outstanding. It is not a teardown sweep
   *  any more: a run whose lanes deliver never gets here at all, since each
   *  `end` frame releases its own node's verdict as it lands.
   *
   *  EVERY undrained node is stamped, on `gone` as well as `idle`, empty log
   *  included — what differs between them is only what the sentence may claim.
   *  An `idle` drain measured a silence and quotes it; a `gone` lane never
   *  started a stopwatch, so its notice says the lane went away and offers no
   *  duration. Stamping only `idle` was the earlier shape, and it left the
   *  worst case silent: `terminalizePlatformNodes` writes its `lane died` /
   *  `cancelled by operator` line only for nodes still running or pending, so a
   *  node that had already gone **ok** with its summary still on the wire got
   *  no line at all — and then `endRunLogs` published a terminal certifying
   *  that truncated file as complete. That is juspay/odu#87 exactly, with a
   *  completion frame vouching for the loss. A notice on every undrained node
   *  is what closes it; the rule was never "stamp less", it was "never claim
   *  something that did not happen". */
  const drainLaneLogs = async (
    lanes: Iterable<ExecutionLane>,
  ): Promise<void> => {
    await Promise.all(
      [...lanes].map(async (lane) => {
        const drained = await lane.handle.drain();
        if (drained.reason === "complete") return;
        const why =
          drained.reason === "idle"
            ? `went silent for ${drained.idleMs / 1000}s`
            : "went away (closed or died)";
        for (const laneId of drained.undrained) {
          stampTruncated(
            lane.publicId(laneId),
            `${lane.handle.platform} ${why}`,
          );
        }
      }),
    );
  };

  // ── the fan-in surface (status / logs / attach dial this) ──
  // One platform execution owns every primary/burst lane, its exact public
  // node routes, and its leases. Control-plane operations therefore do not
  // need to know how many workers the scheduler chose.
  const executions = new ExecutionRoster((lease) => {
    const idx = acquiredLeases.indexOf(lease);
    if (idx >= 0) acquiredLeases.splice(idx, 1);
    lease.release();
  });
  const laneAccepting = (platform: string): boolean =>
    executions.accepts(platform);

  // Route a rerun request to the owning lane. A bare lane-local id (no `@`)
  // carries no platform: splitFanId reports it as the "unknown" sentinel, which
  // has no lane, so the request is unroutable — `false`, same as a missing
  // lane. The surface's `node.rerun` and the live view's `r` key both call this.
  const rerunNode = async (id: string): Promise<boolean> => {
    const { platform } = splitFanId(id);
    if (platform === "unknown") return false;
    const route = executions.route(platform, id);
    return route === undefined ? false : route.lane.rerun(route.localId);
  };

  /** What an operator lane-drop does to a lane's unfinished nodes. Named once
   *  because it is applied from two places now: immediately, when the lane is
   *  live, and deferred to the claim's return when the drop landed mid-claim. */
  const CANCELLED_BY_OPERATOR = {
    running: "cancelled",
    pending: "cancelled",
    log: "\n[odu] cancelled by operator (lane)\n",
  } as const;

  /** A node whose previous invocation no longer exists.
   *  `startedAt`/`durationMs`/`exitCode` describe a run that is gone — a stale
   *  `startedAt` would have the next attempt's duration measure the dead lane's
   *  wall clock. Named so a future field that also describes an invocation is
   *  added in one place rather than remembered in two. */
  const REOPENED = {
    status: "pending",
    startedAt: null,
    durationMs: null,
    exitCode: null,
  } as const satisfies Partial<NodeState>;

  /** What a lane DEATH does to a lane's unfinished nodes, for the same reason
   *  `CANCELLED_BY_OPERATOR` is named: the overlay is the policy and the
   *  sentence is the story, and this notice is a contract — the e2e suite greps
   *  for its `[odu] ` prefix. One producer, four callers, one wording of the
   *  frame around whatever each of them has to say. */
  const laneDeath = (
    detail: string,
  ): { running: "errored"; pending: "skipped"; log: string } => ({
    running: "errored",
    pending: "skipped",
    log: `\n[odu] ${detail}\n`,
  });

  const releaseLease = (platform: string, lease: LeaseHandle): void =>
    executions.releaseLease(platform, lease);
  const releaseBurstLease = (platform: string, lease: LeaseHandle): void => {
    const remaining = (burstLeaseUsers.get(lease) ?? 1) - 1;
    if (remaining > 0) {
      burstLeaseUsers.set(lease, remaining);
      return;
    }
    burstLeaseUsers.delete(lease);
    releaseLease(platform, lease);
  };

  /** Mark unfinished nodes on a platform terminal — shared by operator lane
   *  cancel and infrastructure `onDead` (status/log strategy as data). */
  const terminalizePlatformNodes = (
    platform: string,
    strategy: {
      running: "cancelled" | "errored";
      pending: "cancelled" | "skipped";
      log: string;
    },
  ): void => {
    // A verdict held for a log still in flight is still a verdict, and this
    // lane is going away — its output is now as complete as it will ever be.
    // Publish the truth before overwriting it: without this, a node that
    // finished **ok** with its tail on the wire would be recorded `errored` or
    // `cancelled` for the sole reason that the coordinator had not yet got
    // round to saying it was ok. (What its log lost is a separate question,
    // answered by `drainLaneLogs` / `stampUnfinishedLogs` in the log itself.)
    verdicts.releaseAll((id) => onPlatform(id, platform));
    const state = store.get();
    const now = Date.now();
    for (const id of state.order) {
      if (!onPlatform(id, platform)) continue;
      const node = state.nodes[id];
      if (node === undefined) continue;
      const next = overlayOnLaneStop(node.status, strategy);
      if (next === undefined) continue;
      if (node.status === "running") {
        // Status `running` is not "log is open": the node's `end` frame can
        // land before its terminal status (two streams, no order). `appendLocal`
        // skips a sealed log so a transport death in that window cannot throw
        // mid-loop and leave the remaining nodes unterminated.
        appendLocal(id, strategy.log);
        const startedAt = node.startedAt ?? now;
        updateNode(id, {
          status: next,
          durationMs: now - startedAt,
        });
      } else {
        updateNode(id, { status: next });
      }
      // The coordinator has just decided this node's fate, so it has said its
      // last word about it: end the log in the same breath as the status, the
      // way the runner does on every path it owns. Without this the fan-in
      // serves a terminal for nodes a LANE finished and none for the ones the
      // coordinator finished, and `odu logs -f e2e@linux` against a lane that
      // died never returns — the wait an agent cannot afford, on exactly the
      // runs most worth reading.
      //
      // `_ci-setup` excepted, and only here: this very function appends the
      // death/cancel line to it, and more coordinator narration can still
      // follow. Its terminal belongs to `endRunLogs`, at the point the RUN is
      // done with the node rather than the lane.
      if (splitFanId(id).namepath !== SETUP) endLocal(id);
    }
  };

  /** Drop one platform lane: mark unfinished nodes `cancelled`, close the lane
   *  (no `onDead`/errored overlay), free a run-owned venue lease. The rest of
   *  the run keeps settling (juspay/odu#68). */
  const cancelPlatform = (platform: string): boolean => {
    if (executions.isCancelled(platform)) return true;
    const state = store.get();
    const hasNodes = state.order.some((id) => onPlatform(id, platform));
    if (!hasNodes) return false;
    executions.ensure(platform);
    // Tombstone first so racing frames cannot be re-accepted; the roster then
    // closes every primary/burst lane and releases every platform lease.
    executions.cancel(platform);
    // Terminalizing is DEFERRED while a claim is outstanding — see
    // `claimInFlight` for why, and `cancelledDuringClaim` for where the claim's
    // return picks these lanes back up.
    if (claimInFlight(platform)) {
      deferredPlatformStops.set(platform, CANCELLED_BY_OPERATOR);
      return true;
    }
    terminalizePlatformNodes(
      platform,
      deferredPlatformStops.get(platform) ?? CANCELLED_BY_OPERATOR,
    );
    checkSettled();
    return true;
  };

  /** Cancel one fan-in node (`ci::fmt@plat`). Platform drop is `lane.cancel`.
   *
   *  `_ci-setup@<platform>` with no live lane is the one node the coordinator
   *  can cancel by itself, and since juspay/odu#84 it is reachable: the bracket
   *  opens at the venue claim, so for the whole provisioning window `odu status`
   *  shows `_ci-setup@plat` RUNNING while no lane exists to route a cancel to.
   *  Refusing there means the id an operator can see is the one id they cannot
   *  act on. Cancelling that node is by definition dropping the lane it brackets
   *  — there is nothing else in it yet — so it routes to `cancelPlatform`.
   *
   *  Only that node. A pending `ci::fmt@plat` in the same window still refuses:
   *  escalating a one-node cancel into a lane drop is the escalation `odu
   *  cancel` guards against everywhere else. */
  const cancelNode = async (id: string): Promise<boolean> => {
    const { namepath, platform } = splitFanId(id);
    if (platform === "unknown" || namepath === "") return false;
    const route = executions.route(platform, id);
    if (route === undefined) {
      const plan = plansFor(platform).find(
        (candidate) => id === fanId(candidate.rootId, platform),
      );
      if (plan !== undefined) {
        const results = await Promise.all(
          shardRootIds(platform, plan).map(async (rootId) => {
            const shard = executions.route(platform, rootId);
            return shard === undefined
              ? false
              : shard.lane.cancel(shard.localId);
          }),
        );
        return results.some(Boolean);
      }
      return isSetupNode(id) ? cancelPlatform(platform) : false;
    }
    return route.lane.cancel(route.localId);
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
  // Hoisted: the cancel procedure wires before the real body is assigned
  // (poster is constructed after implementSurface so onHealth is live).
  let shutdown: (
    code: number,
    reason?: string,
    opts?: { exclusivityLost?: boolean },
  ) => void = () => {};

  /** A remote hold died mid-run (ssh drop, optional MAX_HOLD, remote kill):
   *  exclusivity is gone and another laptop can claim the same flock.
   *  Intentional `release()` does not fire `lost`. Called once per lease as the
   *  claim hands it over — the claim now runs *after* this point (the socket
   *  serves first, juspay/odu#84), so there is no set to sweep here.
   *
   *  Two answers, and which one applies is a property of the PLATFORM the
   *  lease belongs to, not of the lease:
   *
   *   - a resurrectable platform (one remote primary lane, no shard fan-out)
   *     re-claims. There is nothing to fail closed about: the flock is already
   *     free on the box, so the run does not need to end — it needs another
   *     box, which is the same thing a dead lane needs. Routing both signals to
   *     `laneDied` is also what keeps ONE ssh drop from spending two
   *     resurrections, since the episode latch admits only the first. A
   *     platform that turns out to have nothing left to run ends there rather
   *     than ending the run: exclusivity over a box no lane is using any more
   *     is not something a finished platform still needs.
   *   - everything else — a burst lease, a sharded platform, a localhost lane,
   *     a lease the roster no longer knows — still fails the run closed, which
   *     is what this watch has always done.
   *
   *  The platform is a PARAMETER: every caller registers a lease inside a loop
   *  that already names the platform it belongs to, so asking the roster to
   *  scan for it back would buy an "unknown platform" case that cannot occur —
   *  and pay for it with a sentinel episode and a nested conditional. */
  const watchLease = (platform: string, lease: LeaseHandle): void => {
    const episode = episodeOf(platform);
    void lease.lost?.then(() => {
      const reason = `venue lease lost on ${shortHost(lease.host)}`;
      // A lease from a superseded episode has already been accounted for — the
      // run replaced the lane it belonged to and gave this box back. Its loss
      // is news about a machine nobody is using, and taking the run down over
      // it would undo the very resurrection that let it go.
      if (episode !== episodeOf(platform)) return;
      if (!burstLeaseUsers.has(lease) && isResurrectable(platform)) {
        laneDied(platform, episode, reason);
        return;
      }
      shutdown(1, reason, { exclusivityLost: true });
    });
  };

  const runtime = implementSurface(oduSurface, {
    cells: {
      nodes: { store },
      header: { store: inMemoryStore<RunHeader>(initialHeader) },
    },
    streams: {
      nodeLog: { source: logs.streamSource },
    },
    // One arm per procedure — `({ input }) => Effect<Out>`. The two that await
    // a promise-shaped mutation keep it inside `Effect.promise`; the two that
    // never awaited are `Effect.sync`.
    procedures: {
      node: {
        rerun: ({ input }) =>
          Effect.promise(async () => ({ ok: await rerunNode(input.id) })),
        cancel: ({ input }) =>
          Effect.promise(async () => ({ ok: await cancelNode(input.id) })),
      },
      run: {
        // A second process asked this run to stop. Drive the shared teardown
        // and ack at once — the caller confirms the run is gone by the socket
        // closing, not by this reply (the process exits as the queue drains).
        cancel: () =>
          Effect.sync(() => {
            shutdown(130, "cancelled");
            return { ok: true };
          }),
      },
      lane: {
        cancel: ({ input }) =>
          Effect.sync(() => ({ ok: cancelPlatform(input.platform) })),
      },
    },
  });
  // `implementSurface` hands back the group it advertises and the handlers
  // bound to it, already route-set-checked against each other — serve the pair.
  const served = { group: runtime.group, handlers: runtime.handlers };

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

  /** Let what this run has just published reach the readers holding it open,
   *  before the socket carrying it is severed.
   *
   *  `UnixSocketListener.close()` disconnects every established peer
   *  unconditionally and DROPS their unflushed outbound frames — the framework
   *  says so in as many words, as a deliberate fail-fast ("a host that closed
   *  is closed"). Which makes not-closing-while-still-owing-a-frame the host's
   *  job, and this run's last words are exactly that: a node's log terminal and
   *  its final status, published turns before the close, to an `odu logs -f` or
   *  `odu attach` that has nowhere else to learn them from.
   *
   *  A turn of the loop rather than a timer: `setImmediate` runs after the
   *  current turn's I/O callbacks, by which point the frames those publishes
   *  queued have been handed to the socket. It is a heuristic and it is named
   *  as one — the transport offers no drain to wait on instead.
   *
   *  One turn used to be enough: the RPC server pulled the producer directly,
   *  so a publish resumed it on a microtask and the write landed before the
   *  close. kolu's STREAM_AHEAD buffer puts a pump fiber between them, and
   *  Effect schedules that fiber on `setImmediate` — the same queue this
   *  flush uses. One hop races the pump; three lets the pump run, the RPC
   *  fiber take the chunk, and the write leave, then we close. */
  const flushToReaders = async (): Promise<void> => {
    const tick = (): Promise<void> =>
      new Promise((resolve) => {
        setImmediate(resolve);
      });
    await tick();
    await tick();
    await tick();
  };

  // The per-node timing sidecar report.sh scrapes — durations odu owns in its
  // state cell, written directly rather than re-parsed from logs. This MUST be
  // a hoisted declaration above shutdown: the socket and signal handlers are
  // live while the venue claim is still pending, so an early cancel can reach
  // shutdown before execution reaches the verdict-artifact section below.
  // Best-effort: a missing sidecar only degrades the metrics comment.
  function writeTimingSidecar(state: PipelineState): void {
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
    // Before anything reads the state this run will be remembered by: a node
    // whose verdict is being held for its log has FINISHED, and a record that
    // called it `running` would make an ordinary interrupted run `incomplete`
    // over output the coordinator was merely still ingesting. `stopWork` below
    // stamps what those logs actually lost.
    verdicts.releaseAll();
    const exclusivityLost = opts.exclusivityLost === true;
    const stopWork = (): void => {
      for (const lane of createdLanes) lane.close();
      // An interrupted run does not drain — freeing the terminal and the
      // exclusivity fast is the point — but it does stop writing, and a reader
      // is owed that fact either way: without a terminal here, an `odu logs -f`
      // attached to a cancelled run's node hangs until its own process is
      // killed. What the log lost is a separate question from whether it ended,
      // so SAY what was lost before saying it ended: a terminal on a silently
      // short log is the very failure this issue is about, and an agent reaches
      // this path by default — `wait_for_settle` returns on STATUS, so the
      // `run({supersede})` / `odu cancel` / linger-idle that follows a settle
      // lands here with a just-finished node's summary still on the wire.
      // Stamping is a synchronous append, so unlike draining it costs this path
      // nothing it is trying to protect.
      flushSetupLines();
      stampUnfinishedLogs();
      endRunLogs();
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
    void poster.finalize().then(async (unposted) => {
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
      // `stopWork` above stamped and ended every unfinished log — the last
      // words this run will ever publish, and this path exits the process the
      // moment the socket is gone. Same turn owed, same reason.
      await flushToReaders();
      closeSocket();
      // The catalog's endpoint goes with the socket. Ownership is NOT handed
      // back — the epoch stays, so nothing may claim this run without a real
      // takeover — but the record stops advertising a surface that is gone.
      // After `closeSocket` for the same reason it is after it: the two say
      // the same thing to two different readers, and saying it early would
      // point a reader at a socket still accepting dials.
      history.close();
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
  /** The platforms with a venue claim outstanding right now. While the set is
   *  non-empty this run is NOT settleable however terminal its nodes look.
   *
   *  The node states are the run's answer to "is this over" for every reader
   *  outside this process — `wait_for_settle` and `odu wait` judge the `nodes`
   *  cell, not this module's `checkSettled`. So a `lane.cancel` during the claim
   *  that terminalized its lane at once would, on a single-platform run, make
   *  every node terminal while `claimVenues` is still copying a closure onto a
   *  box, still holding the checkout's one-run lock, and still about to hand
   *  back a lease. A `wait_for_settle` answering "settled, cancelled" there
   *  tells an agent the run is over; its next `run()` hits "a run is already in
   *  progress". The claim's own return is what ends this window: it clears its
   *  own platform, terminalizes the lanes tombstoned meanwhile, and re-judges
   *  settle once.
   *
   *  A per-platform COUNT rather than the boolean this used to be, because
   *  claims stopped being one phase of the run: a lane resurrection re-enters
   *  the very same claim for one platform, and its window can open while the
   *  startup phase's window for that same platform is still open and close long
   *  after. A single latch would have each of them clearing the other's; a
   *  plain set would have the startup phase's tidy-up close a window the
   *  resurrection is still standing in.
   *
   *  Both questions are askable, because both are asked. `checkSettled` wants
   *  the whole-run one — a settle is a statement about the run. A platform stop
   *  wants its OWN platform's: deferring darwin's terminalize behind a cold
   *  linux claim can make `odu cancel @darwin` look like it did nothing for
   *  minutes, and nothing about linux's box has any bearing on darwin's
   *  verdict. */
  const claimsInFlight = new Map<string, number>();
  const claimInFlight = (platform?: string): boolean =>
    platform === undefined
      ? claimsInFlight.size > 0
      : claimsInFlight.has(platform);
  const beginClaim = (platform: string): void => {
    claimsInFlight.set(platform, (claimsInFlight.get(platform) ?? 0) + 1);
  };
  const endClaim = (platform: string): void => {
    const left = (claimsInFlight.get(platform) ?? 0) - 1;
    if (left > 0) claimsInFlight.set(platform, left);
    else claimsInFlight.delete(platform);
  };
  const deferredPlatformStops = new Map<
    string,
    {
      running: "cancelled" | "errored";
      pending: "cancelled" | "skipped";
      log: string;
    }
  >();

  // ── the log join: a node's verdict waits for its output ──
  //
  // A node's verdict and a node's output are two halves of one fact — "this
  // node is done" — travelling on two streams, of which the verdict's is
  // always the faster: it is a few bytes on the state cell while the output is
  // a backlog on the log stream. juspay/odu#88 joined them at TEARDOWN, so the
  // run's own exit stopped dropping tails. But settle is not teardown. Every
  // OTHER consumer of a run — `odu wait --settle`, the MCP `wait_for_settle` an
  // agent loops on, the durable record, the posted commit status — reads
  // settled-ness off the node statuses on this socket, and a status published
  // ahead of its log promises them a finished run whose output is still on the
  // wire. Under `--linger` the coordinator never tears down at all, so there
  // was no drain behind that promise whatsoever.
  //
  // So the join belongs where the promise is made, not where the process ends:
  // a recipe node's TERMINAL status is withheld until its log has ended.
  // "Settled" then means what every reader already took it to mean, on every
  // path, without a single reader having to learn that logs exist.
  //
  // `_ci-setup@<platform>` never comes through here: the coordinator owns its
  // verdict (`finishSetup`) and keeps writing to its log long after the lane is
  // done with it, so it has no log terminal to wait for — the same carve-out,
  // for the same reason, that the fan-in makes for its `end` frame.
  const verdicts = createVerdictGate({
    isLogEnded: logs.isEnded,
    publishedStatus: (id) => store.get().nodes[id]?.status,
    nodeIds: () => store.get().order,
    publish: (id, patch) => updateNode(id, patch),
    drainLogs: () => drainLaneLogs(executions.lanes()),
  });

  const checkSettled = (): void => {
    if (claimInFlight()) return;
    // A run being torn down does not announce a fresh settle: `shutdown` owns
    // the terminal path from here, and it releases held verdicts on its way out
    // (so the record describes finished nodes as finished) — which lands right
    // back in this function.
    if (shuttingDown) return;
    const state = store.get();
    // The taxonomy, not a hand-rolled pair of string comparisons — the same
    // `NON_TERMINAL_STATUSES` the agent face judges settle by (`agentSummary`)
    // and the verdict gate holds against, so the three cannot drift on what
    // "done" means.
    const done = state.order.every(
      (id) => !NON_TERMINAL_STATUSES.has(state.nodes[id]?.status ?? "pending"),
    );
    if (done) {
      settled();
      onSettledEach?.();
      return;
    }
    // Not settled — but if the only nodes left non-terminal are ones whose
    // verdicts the gate is holding, the DAG is done and the output is all that
    // is outstanding. Bound the wait for it.
    verdicts.boundIfOnlyLogsOutstanding();
  };

  const updateNode = (id: string, patch: Partial<NodeState>): void => {
    const cur = store.get();
    const prev = cur.nodes[id];
    if (prev === undefined) return;
    const next = { ...prev, ...patch };
    // Shallow equality over the keys the PATCH names, not over three chosen
    // ones. The signature says `Partial<NodeState>` and the spread above
    // applies all of it, so a three-field guard silently discarded any patch
    // touching only other fields — a contract wider than what it honours, and
    // the reason "we can't correct that field" ever looked true. Every
    // transition side effect below stays gated on `next.status !== prev.status`
    // exactly as before, so nothing fires for a non-status change.
    const keys = Object.keys(patch) as (keyof NodeState)[];
    if (keys.every((k) => next[k] === prev[k])) return;
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
      if (next.status === "running") clearIdle();
      // Any terminal→non-terminal transition means work resumed — and the
      // runner publishes `pending` before `running`, so keying this on
      // `running` alone left a window where a socket loss after a rerun was
      // accepted still let a reader consume the previous `passed` record.
      if (
        recordWritten &&
        !NON_TERMINAL_STATUSES.has(prev.status) &&
        NON_TERMINAL_STATUSES.has(next.status)
      ) {
        finalizeRunRecord(store.get(), poster.unposted());
      }
      emitProgress(id, next);
      // The same transition, into the durable journal. Beside `emitProgress`
      // rather than folded into it: `--progress json` is a FEED a face renders
      // and forgets, this is a RECORD somebody reads a week later, and the two
      // have different budgets for what they may leave out. `host` is read off
      // the lane roster the run published, so a node's placement in the record
      // is the same one the surface showed.
      history.nodeStatus(id, next.status, {
        exitCode: next.exitCode,
        durationMs: next.durationMs,
        host: lanesByPlatform[splitFanId(id).platform] ?? null,
      });
      const payload = postableNodeIds.has(id)
        ? statusFor(id, next.status, next.durationMs, sha7)
        : null;
      if (payload !== null) poster.post(payload);
      checkSettled();
    }
  };

  const installShardNodes = (platform: string, plan: ShardPlan): void => {
    runtime.ctx.cells.nodes.set(installShardTopology(store.get(), platform, plan));
    display.update(store.get());
    // The roster CHANGED — a sharded recipe's children are real nodes now, and
    // a reader that cannot see them cannot tell a settled run from one whose
    // slowest shard never started.
    history.roster(store.get().order);
  };

  const refreshShardAggregate = (platform: string, plan: ShardPlan): void => {
    if (plan.total <= 1) return;
    const logicalId = fanId(plan.rootId, platform);
    const state = store.get();
    const children = shardRootIds(platform, plan);
    const nodes = children.map((id) => state.nodes[id]).filter(Boolean);
    if (nodes.length !== plan.total) return;
    const logical = state.nodes[logicalId];
    if (logical === undefined) return;
    const nonTerminal = nodes.some(
      (node) => node!.status === "pending" || node!.status === "running",
    );
    if (nonTerminal) {
      if (
        logical.status === "pending" &&
        nodes.some((node) => node!.status !== "pending")
      ) {
        appendLocal(
          logicalId,
          `[odu] ${plan.total} shards started; details are adjacent nodes\n`,
        );
        updateNode(logicalId, { status: "running", startedAt: Date.now() });
      }
      return;
    }
    if (logical.status !== "pending" && logical.status !== "running") return;
    const statuses = nodes.map((node) => node!.status);
    const status = shardAggregateStatus(statuses);
    const startedAt = logical.startedAt ?? Date.now();
    const durationMs = shardAggregateDuration(nodes.map((node) => node!));
    appendLocal(
      logicalId,
      `[odu] shards settled: ${statuses.join(", ")}\n`,
    );
    endLocal(logicalId);
    updateNode(logicalId, {
      status,
      exitCode: status === "ok" ? 0 : 1,
      startedAt,
      durationMs,
    });
  };

  /** Provisioning has begun for this lane. `_ci-setup@<platform>` is the run's
   *  bracket around it, opening at the VENUE CLAIM rather than at lane start
   *  (juspay/odu#84 — see the module header).
   *
   *  Guarded on `pending` so it can only ever OPEN the bracket: re-stamping
   *  `startedAt` on a lane already provisioning would silently discount the
   *  very wait this node exists to measure, and a lane whose setup already went
   *  terminal (a claim that failed for it) must not be dragged back to
   *  `running`. */
  const startSetup = (platform: string): void => {
    const id = fanId(SETUP, platform);
    if (store.get().nodes[id]?.status !== "pending") return;
    updateNode(id, { status: "running", startedAt: Date.now() });
  };

  /** Provisioning can emit thousands of lines in one transport callback. The
   * durable sink intentionally uses synchronous writes, so forwarding each
   * line separately starved the same event loop that drives Effect RPC and the
   * OpenTUI spinner. Coalesce each platform's burst to one append per turn:
   * all bytes remain durable, while timers/input/render get a scheduling edge. */
  const pendingSetupLines = new Map<string, string[]>();
  let setupFlush: ReturnType<typeof setImmediate> | undefined;
  flushSetupLines = (): void => {
    if (setupFlush !== undefined) clearImmediate(setupFlush);
    setupFlush = undefined;
    for (const [platform, lines] of pendingSetupLines) {
      appendLocal(fanId(SETUP, platform), lines.join(""));
    }
    pendingSetupLines.clear();
  };

  /** Narrate one provisioning line into the lane's `_ci-setup` log as well as
   * the operator feed. */
  const setupLine = (msg: string, platform: string): void => {
    info(msg);
    const lines = pendingSetupLines.get(platform) ?? [];
    lines.push(`${msg}\n`);
    pendingSetupLines.set(platform, lines);
    setupFlush ??= setImmediate(flushSetupLines);
  };

  // The _ci-setup node's lifecycle is coordinator-owned, not lane-mirrored:
  // its `running` start is stamped when the coordinator begins provisioning
  // (`startSetup`, above), and its duration is coordinator-measured because our
  // _ci-setup brackets claim+provision+fetch+worktree, which precedes the lane
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
    const node = store.get().nodes[id];
    if (node === undefined) return;
    if (node.status !== "pending" && node.status !== "running") return;
    // Off the node `startSetup` stamped it on — one home for the instant.
    const startedAt = node.startedAt ?? Date.now();
    updateNode(id, {
      status,
      exitCode,
      startedAt,
      durationMs: Date.now() - startedAt,
    });
  };

  // ── socket + lanes ──
  mkdirSync(join(repoRoot, ".ci"), { recursive: true });

  // The header's own value — one construction site, read back rather than
  // rebuilt beside it.
  const commitUrl = runtime.ctx.cells.header.get().commitUrl;
  /** The platforms that still need a machine, derived from the roster rather
   *  than tracked as a second list beside it. */
  const platformsToClaim = claimingLanes(runtime.ctx.cells.header.get()).map(
    (l) => l.platform,
  );
  /** The same set, as a membership test. Fixed before the run starts — unlike
   *  `lanesByPlatform`, which a resurrection empties and refills. */
  const claimablePlatforms = new Set(platformsToClaim);

  /** Publish a new header to the surface and to `run`'s own live view, so an
   *  attached face and the foreground matrix repaint the same lane map. The
   *  store IS the value — there is no local copy to keep in step.
   *
   *  Through the CELL, which is the only writer in scope by construction (see
   *  `initialHeader`). A bare `CellStore.set` is `value = v` and nothing else;
   *  the bus publish that wakes every subscriber lives on the ctx write path
   *  (`ctxApply`: `store.set(next); bus.publish(next)`) — the same path
   *  `updateNode` has always used for the `nodes` cell. Writing a store directly
   *  left the second publish visible to `get()` and to `display` (told
   *  separately, on the next line) while reaching no attached reader at all: an
   *  `odu attach` opened during provisioning — the exact operator move
   *  juspay/odu#84 is about — would take the claiming roster as its first frame
   *  and never see the resolved one. */
  const publishHeader = (next: RunHeader): void => {
    runtime.ctx.cells.header.set(next);
    display.setHeader(next);
  };

  /** Republish the lane roster: ONE producer, so `rosterFrom`'s invariant —
   *  "'claiming' cannot survive the claim on any exit path" — stays a property
   *  of how the roster is built rather than a call every branch has to
   *  remember to spell. `beforeClaim` is the only thing a caller decides. */
  const publishRoster = (beforeClaim: boolean): void => {
    const lanes = rosterFrom(
      activePlatforms.filter((platform) => !executions.isCancelled(platform)),
      beforeClaim,
    );
    publishHeader({ ...runtime.ctx.cells.header.get(), lanes });
    // The same roster into the journal, so a face reading the catalog after
    // teardown can say WHICH machine each lane landed on — the fact a failure
    // report is half as useful without. Derived from the published header
    // rather than from `lanesByPlatform` directly, so the record and the
    // surface cannot describe two different run environments.
    for (const lane of lanes) {
      history.lane(
        lane.platform,
        lane.state,
        lane.state === "leased" ? lane.host : null,
      );
    }
    // `unstarted` is unreachable here — this run published its header before
    // the socket served — but it is a value the type carries, and the journal
    // has no arm for it: a REGISTERED run is by definition started. Skipping
    // it rather than mapping it keeps the record from asserting a phase the
    // catalog says cannot exist.
    const phase = runPhase({ ...runtime.ctx.cells.header.get(), lanes });
    if (phase !== "unstarted") history.phase(phase);
  };
  // Stamp the reserved seq onto the fan-in state so every face — the agent
  // `wait_for_settle` verdict especially — reads the run's full identity
  // `<sha7>#<seq>`. Set once here, before the socket serves; `updateNode`
  // spreads the whole state, so it survives every node update.
  // (seq itself was reserved before the venue lease — see above.)
  //
  // The key is SPREAD IN, never spelled `seq: undefined`. `PipelineState.seq`
  // is `Schema.optionalKey` (PLAN #17), which rejects a present-but-undefined
  // key on ENCODE as well as decode — so on the rare path where no seq could be
  // reserved, writing the key would have made the whole fan-in cell
  // un-encodable and killed every `attach` / `status` / agent read of that run.
  // Absent is the honest value: the run claims `sha7` but no unique
  // `<sha7>#<seq>`, and the agent surface maps that to `seq: null`.
  runtime.ctx.cells.nodes.set({
    ...store.get(),
    ...(seq === null ? {} : { seq }),
  });
  // The node roster into the journal, so a catalog reader can tell a settled
  // run from one whose slowest lane never started — the journal says which
  // nodes reached a status, and only this says which ones were expected to.
  history.roster(store.get().order);
  // ONE finalize, TWO durable homes. The checkout ledger keeps the record it
  // has always kept (`.ci/<sha7>/runs/<seq>.json`, still what `odu runs` and
  // `wait_for_settle` read), and the per-user catalog gets the same verdict
  // addressed by run id. Written from one function so the two can never
  // disagree about how a run ended — which is the failure a second history
  // would otherwise be worth less than nothing for.
  //
  // The catalog half runs even when no `seq` could be reserved: the ordinal is
  // a CHECKOUT's bookkeeping, and a run with no ordinal still has a run id, an
  // outcome, and evidence somebody may need.
  finalizeRunRecord = (state, unposted): void => {
    const owed = unposted ?? poster.unposted();
    const startedAt = runtime.ctx.cells.header.get().startedAt;
    const finishedAt = Date.now();
    const nodes = projectNodes(state);
    const withStatus = (want: NodeStatus): string[] =>
      nodes.filter((n) => n.status === want).map((n) => n.id);
    // Debt into the JOURNAL as well as onto the verdict: the attention query
    // folds the journal, and a reader that only ever saw the verdict would
    // learn about unposted statuses exactly once, at the end. Emitted only
    // when there is any — a healthy run writes no debt lines at all.
    if (owed.length > 0) {
      history.postingDebt(
        owed.map((o) => ({
          context: o.context,
          lastError: o.lastError,
          attempts: o.attempts ?? 0,
        })),
      );
    }
    history.finalize({
      outcome: outcomeOfNodes(nodes),
      startedAt,
      finishedAt,
      failed: withStatus("failed"),
      errored: withStatus("errored"),
      cancelled: withStatus("cancelled"),
      unposted: owed.map((o) => ({
        context: o.context,
        lastError: o.lastError,
        attempts: o.attempts ?? 0,
      })),
    });
    if (seq === null) return;
    try {
      writeRunRecord(
        repoRoot,
        sha7,
        buildRunRecord({
          repo,
          sha,
          seq,
          dirty: ctx.dirty,
          startedAt,
          finishedAt,
          // The record describes machines the run actually had; a lane still
          // claiming one has nothing to record. Read off the store every
          // face reads, so the record cannot describe a different run
          // environment from the one the surface published.
          lanes: leasedLanes(runtime.ctx.cells.header.get()),
          state,
          unposted: owed,
        }),
      );
      recordWritten = true;
    } catch {
      // best-effort: the run history is a convenience, never a gate — a failed
      // record write must not fail the run or mask its verdict.
    }
  };

  // The header cell already holds the provisioning header — it is the store's
  // initial value — so an `attach` connecting in the first instant reads the
  // real run environment rather than the EMPTY_HEADER default, with no
  // "publish before serving" step to remember.
  //
  // Checkout run-lock is already held (covers the claim); serveSocket is the
  // attach surface and a second exclusivity gate for the rest of the run.
  //
  // BEFORE the venue claim, not after (juspay/odu#84 — see the module header).
  // Everything the socket needs is decided by now: the DAG, the run's identity,
  // the lane→pool split.
  closeSocket = await serveSocket(served, socketPath, socketLogger(info));
  // The identity is now observable: a reader can see `sha7#seq` and key a
  // verdict on it, so the ordinal must never be handed to another run even if
  // finalizing this one's record fails. A no-op when no seq was ever reserved
  // — "published" cannot apply to an ordinal that doesn't exist.
  if (reservation.current.status === "reserved") {
    reservation.current = { ...reservation.current, published: true };
  }

  // Signals attach here rather than after the lanes start: the socket is up, so
  // an interrupt during the claim now has a coordinator to tear down gracefully
  // (finalize posted statuses, write the record, drop the socket) instead of
  // dying by default disposition halfway through a closure copy.
  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(130));

  // The header first: it is the only way a face learns the run environment, and
  // the plain banner `start` prints renders it.
  display.setHeader(runtime.ctx.cells.header.get());
  display.start(store.get());
  display.update(store.get());

  /** Hand the process to `shutdown` and never come back.
   *
   *  Between `serveSocket` and the lane loop there are now awaits — `poster.seed`'s
   *  GitHub round trip, and the venue claim itself — and the socket, the signal
   *  handlers and `run.cancel` are all live across them. So a teardown can begin
   *  mid-window, and `shutdown` is the ONLY terminal owner once it has: it
   *  finalizes posted statuses, writes the record from the snapshot it took at
   *  the interrupt, drops the socket and calls `process.exit`.
   *
   *  Resuming the main flow past a started teardown gives one run two terminal
   *  owners — a second `poster.finalize`, a second record write from a LATER
   *  snapshot, a second `closeSocket`, and an exit code decided by whichever
   *  lands last (130 or 1, by race). Parking is exactly what the post-lane path
   *  already does: a SIGINT mid-run leaves `await allSettled` pending forever and
   *  lets `shutdown` exit the process. This gives the pre-lane windows the
   *  behaviour the post-lane one always had. */
  const parkForShutdown = (): Promise<never> => new Promise<never>(() => {});

  // Primary lanes may start before optional shard capacity has settled. A
  // sharded root is withheld: all ordinary prerequisites (and every unrelated
  // CI leg) can earn their result while cold workers are still provisioning.
  // Once each TOTAL is fixed, `lane.extend` adds all roots with their immutable
  // shard environments to the same runner and workspace.
  const primaryLanes = new Map<string, Lane>();
  /** Retire one lane: close it, forget its routes, and forget it exists. Every
   *  registry this run keeps a lane in, updated in ONE place — a corpse left in
   *  any one of them is a rerun dispatched to a closed session, a truncation
   *  notice stamped on a node about to run again, or a `close()` on the teardown
   *  sweep for an object nothing else references. */
  const retireLane = (platform: string, lane: Lane): void => {
    lane.close();
    executions.dropLane(platform, lane);
    primaryLanes.delete(platform);
    createdLanes.delete(lane);
  };
  const buildLane = deps.startLane ?? startLane;
  /** The venue claim, resolved once: the startup claim and every resurrection
   *  re-claim go through the same call, with the same identity and the same
   *  pool, because "get this platform a box" is one activity however many times
   *  a run needs it done. */
  const claimOne = deps.claimVenues ?? claimVenues;

  /** Which lane EPISODE a platform is currently on. A lane death and the loss
   *  of the lease under it are the same event seen from two places — one ssh
   *  drop kills both — so both must be able to trigger a resurrection, and
   *  exactly one of them may. The counter is that latch: every trigger carries
   *  the episode it belongs to, and a trigger from a superseded episode is
   *  dropped. Cheaper than trying to correlate the two signals, and it also
   *  covers the late straggler (a `lost` that resolves seconds after the lane
   *  it belonged to was already replaced).
   *
   *  It is also the count of resurrections SPENT: the episode only ever moves
   *  in `resurrectLane`, one step per rebuild, so "which episode" and "how many
   *  retries has this platform had" are the same number and are kept in one
   *  place. */
  const laneEpisode = new Map<string, number>();
  const episodeOf = (platform: string): number => laneEpisode.get(platform) ?? 0;
  /** The retry budget, read ONCE per run: an operator editing
   *  `ODU_MAX_LANE_RESURRECTIONS` mid-run must not have one death judged
   *  against a different budget than the next, or narrated with a different
   *  "of N" than the attempt before it. */
  const maxResurrections = maxLaneResurrections();
  /** Platforms whose primary lane actually started OFF-box. Recorded once, at
   *  the lane start that decides it, because it must stay answerable while a
   *  resurrection has emptied `lanesByPlatform`. */
  const remotePlatforms = new Set<string>();

  /**
   * May this platform be rebuilt on a fresh venue at all?
   *
   * Deliberately narrow, and the same shape `--linger` refuses sharding with:
   * a REMOTE primary lane this run CLAIMED, on a platform with no sharded
   * recipe. A localhost lane's "link" is a pipe to a child of this process — if
   * it died, re-claiming localhost changes nothing about why. A sharded
   * platform has several lanes and several leases holding one immutable TOTAL
   * between them; rebuilding one of them is a different feature, not this one.
   * An agent-held platform (`odu lease`) is excluded by the same rule that
   * keeps it out of `platformsToClaim`: its box is the operator's pin, held
   * outside this run's roster, and claiming a DIFFERENT one for it would move
   * the work off the machine they are iterating on and strand their lease.
   *
   * Both facts are read from sets fixed before they could move — the claim
   * split, and the host the primary lane actually started on. `lanesByPlatform`
   * cannot answer either: a resurrection empties it for the whole duration of
   * the re-claim, which is exactly the window a lease watcher asks in.
   *
   * Deliberately says nothing about the node STATUSES: whether there is any
   * work left is a question that can only be asked honestly once the verdict
   * gate has published what it is holding, which is a side effect and belongs
   * to the caller that is committing to a retry.
   */
  const isResurrectable = (platform: string): boolean =>
    claimablePlatforms.has(platform) &&
    remotePlatforms.has(platform) &&
    shardRootsFor(platform).length === 0;

  /**
   * The tasks a fresh lane for this platform would have to run: every node the
   * dead lane left UNFINISHED — the ones it never started and the one it was in
   * the middle of. A node cut off mid-recipe is re-run from the start rather
   * than resumed; live node state dies with the runner, so there is nothing to
   * resume from.
   *
   * `needs` is filtered to the same set: the runner's `configure` runs
   * `validatePipeline`, which rejects a dep it was not given, and a dep that is
   * already `ok` is precisely what a retry must not wait for. A task whose dep
   * finished BADLY is dropped rather than un-blocked — dropping the edge would
   * let a node run that the first lane had already decided must not.
   *
   * Only truthful once every held verdict has been published: a node that
   * finished `ok` with its log still in flight reads `running` here, and
   * retrying it would re-run finished work and throw its output away.
   */
  const unfinishedTasksFor = (
    platform: string,
    state: PipelineState,
  ): TaskSpec[] => {
    const all = tasksByPlatform.get(platform) ?? [];
    const statusOf = (localId: string): NodeStatus | undefined =>
      state.nodes[fanId(localId, platform)]?.status;
    // Every task in `tasksByPlatform` was given a node at startup, so a missing
    // status is unreachable — stated rather than defaulted, so a reader does
    // not have to work out whether "a node the run never heard of is done" is a
    // rule or a typo.
    const unfinished = (task: TaskSpec): boolean => {
      const status = statusOf(task.id);
      return status !== undefined && NON_TERMINAL_STATUSES.has(status);
    };
    const retry = new Map(
      all.filter(unfinished).map((task) => [task.id, task] as const),
    );
    // A dependency that is neither `ok` nor itself being retried is a verdict
    // this lane already reached; its dependents come off the retry with it.
    for (;;) {
      const blocked = [...retry.values()].filter((task) =>
        task.needs.some((dep) => statusOf(dep) !== "ok" && !retry.has(dep)),
      );
      if (blocked.length === 0) break;
      for (const task of blocked) retry.delete(task.id);
    }
    return [...retry.values()].map((task) => ({
      ...task,
      needs: task.needs.filter((dep) => retry.has(dep)),
    }));
  };

  /**
   * A lane episode ended badly. Either this platform gets a fresh venue and
   * retries what it had not finished, or it is terminalized the way a dead lane
   * has always been.
   *
   * The two callers are the lane's own `onDead` and a venue lease's `lost`. The
   * lease used to shut the whole RUN down here, and for a sharded or localhost
   * platform it still does — but for a platform that can be resurrected there
   * is nothing to fail closed about: the flock the run lost is already free on
   * the box, so the honest response is to go and claim one again rather than to
   * exit 1 over a network hiccup.
   */
  const laneDied = (platform: string, episode: number, reason: string): void => {
    if (!laneAccepting(platform)) return;
    if (episode !== episodeOf(platform)) return;
    // The episode IS the retry count (see `laneEpisode`), and `episode` is the
    // current one — the guard above just said so.
    const spent = episode;
    if (spent < maxResurrections && isResurrectable(platform)) {
      // The claim window opens BEFORE the gate is drained, not after: publishing
      // held verdicts can make every node on a single-platform run terminal for
      // an instant, and a `wait_for_settle` looking in that instant would call
      // a run over that is about to claim another box. Closed again below if
      // this turns out not to be a retry after all.
      beginClaim(platform);
      try {
        // Now the statuses tell the truth about what finished, so what is left
        // is answerable — and a node whose `ok` was merely in flight is not
        // about to be dragged back to `pending`.
        verdicts.releaseAll((id) => onPlatform(id, platform));
        // ONE snapshot, threaded as a value: "what was unfinished when the lane
        // died" and "which nodes were cut off mid-recipe" are two halves of one
        // decision, and reading the store twice would leave them agreeing only
        // because nothing happens to await in between.
        const state = store.get();
        const unfinished = unfinishedTasksFor(platform, state);
        if (unfinished.length > 0) {
          // `resurrectLane` opens a window of its own for the claim it starts,
          // so the count never reaches zero across the handover.
          resurrectLane(platform, episode, reason, unfinished, state);
          return;
        }
      } finally {
        // ONE exit, whichever way the branch above goes: an unpaired
        // `beginClaim` suppresses every future settle and hangs the run.
        endClaim(platform);
      }
      // Nothing was left to retry: the lane died owing this platform nothing,
      // and the terminalize below is a no-op over an all-terminal node set —
      // reached only so the settle the held window suppressed is re-judged.
    }
    // Why the run stopped trying belongs in the death line, not only in the
    // absence of a further attempt: "lane died" on the third identical death
    // reads like the first, and an operator looking at a red platform should
    // not have to count `_ci-setup` entries to learn that odu had already
    // moved this work twice.
    const exhausted =
      spent >= maxResurrections
        ? ` (gave up after ${maxResurrections} lane resurrections)`
        : "";
    const strategy = laneDeath(`lane died: ${reason}${exhausted}`);
    // The lane narration too, and for the same reason the retries are narrated
    // there: `_ci-setup`'s log is the one place this platform's whole venue
    // story is told in order, and a story that stops mid-retry is the one shape
    // it must not have. Only when a budget was actually spent — an ordinary
    // one-shot lane death says nothing new here.
    if (exhausted !== "") {
      setupLine(`[odu] lane died: ${reason}${exhausted}`, platform);
    }
    executions.cancel(platform);
    if (claimInFlight(platform)) deferredPlatformStops.set(platform, strategy);
    else terminalizePlatformNodes(platform, strategy);
    checkSettled();
  };

  /**
   * Rebuild this platform on a freshly claimed venue, rerunning only what it
   * had not finished.
   *
   * Called by `laneDied` with the settle window already held and the verdict
   * gate already drained, so `retryTasks` describes what really is unfinished.
   * The order of what follows is load-bearing:
   *
   *   1. Take the episode forward FIRST, so the other trigger for this same ssh
   *      drop — the lane's `onDead` if the lease got here first, or vice versa
   *      — is dropped rather than spending a second resurrection.
   *   2. Narrate into `_ci-setup`, which is the ONE log this platform's whole
   *      venue story is told in — including which nodes were cut off
   *      mid-recipe. Not into those nodes' own logs: a node's log is addressed
   *      by commit, and the successor lane opens its subscription with a
   *      `snapshot` frame that RESETS the file (`nodeLogSink.reset` is a
   *      truncating write), so a notice written there is erased by the very
   *      retry it announces.
   *   3. Only then close the corpse, give its lease back, and re-open the
   *      provisioning bracket. The old lane is closed WITHOUT `onDead` —
   *      `close()` latches the lane quiet, so its own death cannot come back
   *      around as a second trigger for the episode we are already handling.
   *   4. The retried nodes move LAST, once a venue is actually in hand. A reset
   *      to `pending` before the claim resolves would have a claim FAILURE
   *      overlay `pending` → `skipped` on the node that really died
   *      mid-recipe — reporting a red platform as merely incomplete.
   */
  const resurrectLane = (
    platform: string,
    episode: number,
    reason: string,
    retryTasks: TaskSpec[],
    /** The one snapshot `laneDied` decided from — not re-read here, so both
     *  halves of that decision describe the same instant by construction. */
    state: PipelineState,
  ): void => {
    const attempt = episode + 1;
    laneEpisode.set(platform, attempt);
    beginClaim(platform);

    setupLine(
      `[odu] lane died: ${reason} — reclaiming a venue and retrying unfinished` +
        ` nodes (attempt ${attempt} of ${maxResurrections})`,
      platform,
    );
    const retryIds = new Set(retryTasks.map((task) => fanId(task.id, platform)));
    const cutOff = state.order.filter(
      (id) => onPlatform(id, platform) && state.nodes[id]?.status === "running",
    );
    if (cutOff.length > 0) {
      setupLine(
        `[odu] cut off mid-recipe, re-running from the start: ${cutOff
          .map((id) => splitFanId(id).namepath)
          .join(", ")}`,
        platform,
      );
    }

    const dead = primaryLanes.get(platform);
    if (dead !== undefined) retireLane(platform, dead);
    // Release on a lost lease is a tolerated no-op; on a lease that merely
    // outlived its lane it is the whole point — the box must be free before we
    // queue for one, or a single-host pool waits on itself.
    executions.releaseLeases(platform);

    // Re-open the provisioning bracket so the new claim narrates into it and
    // the new runner's setup verdict has somewhere to land (`finishSetup`
    // refuses a node that is already terminal, exactly as `startSetup` refuses
    // one that is already running).
    updateNode(fanId(SETUP, platform), REOPENED);
    startSetup(platform);

    // The roster says `claiming` again while it is true, from the same builder
    // the startup claim publishes through.
    delete lanesByPlatform[platform];
    publishRoster(true);

    void (async () => {
      const outcome = await claimOne({
        repoRoot,
        pools: resolvedPools,
        platforms: [platform],
        identity: { holder: localHolderId(), run: runLabel },
        noWait: args.noWait,
        runLabel,
        onLine: setupLine,
        resolveDrvPath: runnerResolverFor,
      });
      endClaim(platform);
      // `claiming` does not survive this claim on ANY exit below — the same
      // property `rosterFrom` gives the startup claim, restored here rather
      // than left to three branches to remember. Without it a failed re-claim
      // leaves the platform advertised as provisioning forever, and
      // `finalizeRunRecord` (which builds its `lanes` from `leasedLanes`) drops
      // it from the durable record entirely.
      publishRoster(false);
      // A whole-run teardown owns every terminal decision from the moment it
      // starts; hand the box back and say nothing else (the startup claim's
      // continuation does exactly this).
      if (shuttingDown) {
        if (outcome.ok) for (const lease of outcome.leases) lease.release();
        return;
      }
      // A cancel that landed while we were queueing could not release a lease
      // the claim had not handed over yet — so it deferred, and this is where
      // its verdict is applied, with the box given straight back.
      if (executions.isCancelled(platform)) {
        if (outcome.ok) for (const lease of outcome.leases) lease.release();
        terminalizePlatformNodes(
          platform,
          deferredPlatformStops.get(platform) ?? CANCELLED_BY_OPERATOR,
        );
        checkSettled();
        return;
      }
      if (!outcome.ok) {
        // No second machine for the retry: the run is out of options for this
        // platform and says so through the same path a dead lane takes.
        //
        // And it does NOT spend a resurrection retrying the claim itself,
        // deliberately: `claimOne` has already waited in line for a free box
        // (that is what `noWait: false` means, and its own idle/ceiling bounds
        // govern how long), so a failure here is not "the pool was momentarily
        // full" — it is the pool answering that this platform has no venue.
        // Looping the budget over that answer would re-ask a question already
        // asked patiently, and turn a fast honest red into minutes of silence.
        // The budget counts LANE deaths, which is a different failure with a
        // different cure.
        executions.cancel(platform);
        terminalizePlatformNodes(
          platform,
          laneDeath(`lane died: ${reason}\n[odu] ${outcome.error.message}`),
        );
        checkSettled();
        return;
      }
      // The venue is in hand, so the retried nodes may finally move. Terminal
      // nodes are untouched — `ok` keeps its verdict AND its log, and a
      // `skipped` node that is coming back is already in `retryIds` as
      // `pending`.
      for (const id of retryIds) {
        updateNode(id, REOPENED);
        // And so does the log: what is in it belongs to an invocation that no
        // longer exists. Reset HERE, where the decision to re-run is made,
        // rather than leaving it to the successor lane's opening `snapshot`
        // frame — a party that does not know a resurrection happened deciding
        // what this file contains.
        resetLocal(id, "");
      }
      acceptClaim(platform, outcome, retryTasks);
      checkSettled();
    })();
  };

  const startPrimaryLane = (
    platform: string,
    host: string,
    tasks: TaskSpec[],
  ): Lane => {
    executions.ensure(platform);
    startSetup(platform);
    const setupId = fanId(SETUP, platform);
    const publicMainId = (laneId: string): string => {
      const plan = planFor(platform, laneId);
      return plan !== undefined && plan.total > 1
        ? fanId(shardNamepath(laneId, 0, plan.total), platform)
        : fanId(laneId, platform);
    };
    const local = isLocalHost(host);
    if (!local) remotePlatforms.add(platform);
    // Which episode this lane IS. Read now, so the death of a lane that has
    // already been replaced cannot be mistaken for the death of its successor.
    const episode = episodeOf(platform);
    const lane = buildLane({
      platform,
      host,
      tasks,
      pipelineName: spec.name,
      origin: local || originUrl === null ? null : fetchUrlFor(originUrl),
      sha: local ? null : sha,
      workspace: local ? specSource : null,
      resolveDrvPath: runnerResolverFor(platform),
      onSetupLine: (line) => appendLocal(setupId, `${line}\n`),
      onNodes: (laneState) => {
        if (!laneAccepting(platform)) return;
        for (const laneId of laneState.order) {
          const laneNode = laneState.nodes[laneId];
          if (laneNode === undefined) continue;
          if (laneId === SETUP) {
            const terminal =
              laneNode.status !== "pending" && laneNode.status !== "running";
            if (terminal) {
              finishSetup(platform, laneNode.status, laneNode.exitCode);
            }
            continue;
          }
          const id = publicMainId(laneId);
          verdicts.offer(id, {
            status: laneNode.status,
            exitCode: laneNode.exitCode,
            startedAt: laneNode.startedAt,
            durationMs: laneNode.durationMs,
          });
          const plan = planFor(platform, laneId);
          if (plan !== undefined) {
            refreshShardAggregate(platform, plan);
          }
        }
      },
      onLogFrame: (laneId, frame) => {
        const id = publicMainId(laneId);
        if (frame.kind === "append") {
          appendLocal(id, frame.text);
        } else if (frame.kind === "end") {
          if (laneId !== SETUP) {
            endLocal(id);
            verdicts.release(id);
            const plan = planFor(platform, laneId);
            if (plan !== undefined) {
              refreshShardAggregate(platform, plan);
            }
          }
        } else if (laneId === SETUP) {
          if (frame.text !== "") appendLocal(id, frame.text);
        } else if (!logs.isNoopReset(id, frame.text)) {
          resetLocal(id, frame.text);
        }
      },
      // A broken link is no longer the end of this platform: `laneDied` decides
      // between a fresh venue and a red verdict, and it is the SAME decision
      // the venue lease's `lost` reaches — one episode, one outcome.
      onDead: (error) => laneDied(platform, episode, error),
    });
    createdLanes.add(lane);
    executions.addLane(
      platform,
      lane,
      [SETUP, ...tasks.map((task) => task.id)],
      publicMainId,
    );
    primaryLanes.set(platform, lane);
    return lane;
  };

  /** Accept one ready platform immediately. The roster keeps unresolved peers
   * in `claiming`, while this platform's ordinary CI starts. A sharded root is
   * still deferred until optional capacity fixes TOTAL. */
  const acceptClaim = (
    platform: string,
    claimed: Extract<ClaimOutcome, { ok: true }>,
    /** The exact tasks the new lane must run. Always the caller's decision: a
     *  first claim wants the platform's early set, a resurrection wants only
     *  what the dead lane left unfinished, and which of those is meant is not
     *  something this function should have to read out of an absent argument. */
    tasks: TaskSpec[],
  ): void => {
    Object.assign(lanesByPlatform, claimed.lanes);
    for (const lease of claimed.leases) {
      if (!executions.addLease(platform, lease)) {
        lease.release();
        continue;
      }
      acquiredLeases.push(lease);
      watchLease(platform, lease);
    }
    publishRoster(true);
    if (executions.isCancelled(platform)) return;
    const host = lanesByPlatform[platform];
    if (host === undefined) return;
    if (tasks.length > 0) startPrimaryLane(platform, host, tasks);
  };

  // ── venue claim: one free machine per platform, lock held for the run ──
  //
  // Read-before-write ahead of the first post: contexts GitHub already shows in
  // the desired state become no-ops (eliminates the restart "pending wave").
  // Started ALONGSIDE the claim rather than ahead of it — the two share nothing,
  // and one is a GitHub round trip while the other is minutes of ssh. The only
  // real constraint is that the seed precede the first POST, which is
  // `startSetup`'s `running` transition, so that is where the join is.
  const seeded =
    ctx.posting && github !== null ? poster.seed() : Promise.resolve();
  // Claim every original public log before any independently ready primary
  // can emit a frame. Shard-private logs are claimed with their later topology.
  for (const id of store.get().order) logs.claim(id);
  // Latched before the claim starts: a cancel arriving mid-claim may terminalize
  // every node, but the run is not over until the claim that holds the box is.
  for (const platform of platformsToClaim) beginClaim(platform);
  /** The episode each startup claim belongs to, so its epilogue can tell its own
   *  venue from one a resurrection has since replaced — the SAME latch the death
   *  triggers carry, rather than a second meaning read off the counter. A
   *  superseded claim's host and leases describe a box the run has already given
   *  back, and the post-claim publication must reinstate neither.
   *
   *  `episodeOf(p) > 0` said this once, and only coincidentally: it is true of
   *  "has this platform EVER been resurrected", which is a different question
   *  that happens to agree while episodes start at 0. */
  const claimEpisode = new Map(
    platformsToClaim.map((platform) => [platform, episodeOf(platform)] as const),
  );
  const venueSuperseded = (platform: string): boolean =>
    episodeOf(platform) !== (claimEpisode.get(platform) ?? 0);
  const claims = claimPlatformsIndependently(
    platformsToClaim,
    async (platform) => {
      // Start every platform claim now. Its result is consumed independently
      // below, after the reporter seed, so a ready Darwin lane does not wait
      // for a cold Linux pool (or vice versa) before doing useful work.
      const pending = claimOne({
        repoRoot,
        pools: resolvedPools,
        platforms: [platform],
        validatePlatforms: platformsToClaim,
        identity: { holder: localHolderId(), run: runLabel },
        noWait: args.noWait,
        runLabel,
        onLine: setupLine,
        resolveDrvPath: runnerResolverFor,
      });
      await seeded;
      if (!shuttingDown) startSetup(platform);
      return await pending;
    },
    (platform, outcome) => {
      if (!shuttingDown) acceptClaim(platform, outcome, earlyTasksFor(platform));
      else for (const lease of outcome.leases) lease.release();
    },
  );
  await seeded;
  // A cancel during that round trip must not go on to stamp `_ci-setup` running
  // (posting `pending` to GitHub *after* the interrupt statuses) on a
  // coordinator that is already exiting.
  if (shuttingDown) {
    // Each outstanding claim's own continuation releases a handle that arrives
    // after shutdown. Handles accepted before it began already belong to the
    // execution roster, which `shutdown` closes.
    return await parkForShutdown();
  }

  // The `_ci-setup` bracket opens for the lanes whose claim it BRACKETS: from
  // here until such a lane is up, this node IS the run's visible state, and its
  // log is where the claim narrates itself. An agent-held lane claims nothing,
  // so opening its bracket here would have its `_ci-setup` duration measure a
  // sibling platform's claim wait — the one number that node exists to measure,
  // measuring something else. It opens at its own lane start instead.
  for (const platform of platformsToClaim) startSetup(platform);

  // Agent-held lanes claim nothing and therefore have no reason to wait for a
  // remote platform. Start their ordinary work at the same early boundary.
  for (const platform of activePlatforms) {
    if (platformsToClaim.includes(platform)) continue;
    const host = lanesByPlatform[platform];
    if (host === undefined || executions.isCancelled(platform)) continue;
    const earlyTasks = earlyTasksFor(platform);
    if (earlyTasks.length > 0) startPrimaryLane(platform, host, earlyTasks);
  }

  const claimResults = await claims;
  // The startup claims are no longer in flight — ONE close for the window
  // opened before them, here where the fact becomes true, on the failing path
  // as well as the succeeding one. Closing it a second time further down used
  // to look free (an underflow just deletes the key) and is not: with a
  // resurrection claim outstanding for the same platform, the stray decrement
  // deletes ITS window, and `claimInFlight()` then answers "no box is being
  // acquired" while one is — the exact miss the per-platform count exists to
  // prevent. Only what THIS phase put in the set is taken out of it.
  for (const platform of platformsToClaim) endClaim(platform);
  const failedClaim = claimResults.find(({ outcome }) => !outcome.ok);
  const claimedOutcome: ClaimOutcome =
    failedClaim !== undefined && !failedClaim.outcome.ok
      ? failedClaim.outcome
      : {
          ok: true,
          lanes: Object.assign(
            {},
            ...claimResults.flatMap(({ outcome }) =>
              outcome.ok ? [outcome.lanes] : [],
            ),
          ),
          leases: claimResults.flatMap(({ outcome }) =>
            outcome.ok ? outcome.leases : [],
          ),
        };
  const burstRequests = activePlatforms.flatMap((platform) => {
    const roots = shardRootsFor(platform);
    const limit = roots.reduce(
      (largest, root) =>
        Math.max(largest, Math.max(0, (root.shards ?? 1) - 1)),
      0,
    );
    return limit === 0
      ? []
      : [{ platform, label: roots.map((root) => root.id).join("+"), limit }];
  });

  let outcome: PreparedVenues | Extract<ClaimOutcome, { ok: false }>;
  if (claimedOutcome.ok) {
    // The public roster can name the primary as soon as mandatory acquisition
    // has finished; optional workers do not change this platform→host fact.
    publishRoster(false);

    // Start optional acquisition first (the async function runs up to its
    // first await immediately), then primary execution in the same turn. The
    // window is held for the burst requests alone from here — one platform at
    // a time, leaving any resurrection claim's own window alone.
    for (const request of burstRequests) beginClaim(request.platform);
    const preparing = prepareVenues({
        claimed: claimedOutcome,
        existingLanes: lanesByPlatform,
        platforms: activePlatforms,
        bursts: burstRequests,
        pools: resolvedPools,
        identity: { holder: localHolderId(), run: runLabel },
        onLine: setupLine,
        resolveDrvPath: runnerResolverFor,
        ...(deps.leaseBurstSlots === undefined
          ? {}
          : { leaseBurst: deps.leaseBurstSlots }),
      });

    outcome = await preparing;
    // Paired with the `beginClaim` above, at the instant the bursts stop being
    // in flight, so no other phase's tidy-up has to know they existed.
    for (const request of burstRequests) endClaim(request.platform);
    if (outcome.ok) {
      const moved = [...outcome.venues].find(
        ([platform, venue]) =>
          !venueSuperseded(platform) &&
          primaryLanes.has(platform) &&
          lanesByPlatform[platform] !== venue.host,
      );
      if (moved !== undefined) {
        for (const venue of outcome.venues.values()) {
          for (const lease of venue.leases) {
            if (!acquiredLeases.includes(lease)) lease.release();
          }
        }
        outcome = {
          ok: false,
          error: new Error(
            `primary venue changed during live capacity preparation for ${moved[0]}`,
          ),
        };
      }
    }
  } else {
    outcome = claimedOutcome;
  }
  if (outcome.ok) {
    // A platform whose lane died while this window was open has already given
    // this venue back and claimed (or is claiming) another. Re-publishing the
    // superseded host would point the roster at a box the run released, and
    // re-adopting its leases would put a released handle back in the roster —
    // so the resurrection's own bookkeeping is left to stand.
    for (const [platform, venue] of outcome.venues) {
      if (venueSuperseded(platform)) continue;
      lanesByPlatform[platform] = venue.host;
    }
    for (const [platform, venue] of outcome.venues) {
      if (venueSuperseded(platform)) continue;
      const tasks = tasksByPlatform.get(platform) ?? [];
      const roots = shardRootsFor(platform);
      const shared = shareShardCapacity(
        roots.map((root) => ({
          rootId: root.id,
          limit: Math.max(0, (root.shards ?? 1) - 1),
        })),
        venue.bursts,
      );
      const plans = roots.map((root): ShardPlan => {
        const leases = shared.get(root.id) ?? [];
        for (const lease of leases) {
          burstLeaseUsers.set(lease, (burstLeaseUsers.get(lease) ?? 0) + 1);
        }
        return {
          rootId: root.id,
          tasks: dependencyClosure(tasks, root.id),
          total: 1 + leases.length,
          leases,
        };
      });
      shardPlans.set(platform, plans);
      for (const plan of plans) {
        installShardNodes(platform, plan);
        const ceiling = roots.find((root) => root.id === plan.rootId)?.shards;
        info(
          `${platform}: ${plan.rootId} using ${plan.total}/${ceiling ?? plan.total} shard slots`,
        );
      }
    }
    for (const [platform, venue] of outcome.venues) {
      for (const lease of venue.leases) {
        if (acquiredLeases.includes(lease)) continue;
        if (venueSuperseded(platform) || !executions.addLease(platform, lease)) {
          lease.release();
          continue;
        }
        acquiredLeases.push(lease);
        watchLease(platform, lease);
      }
    }
  } else if (claimedOutcome.ok) {
    for (const platform of platformsToClaim) {
      if (venueSuperseded(platform)) continue;
      delete lanesByPlatform[platform];
    }
  }
  // Neither the startup claims nor the bursts are in flight any more — each was
  // closed at the await that ended it, above — so settle may be judged again. A
  // cancel that arrived mid-claim deliberately did not resolve it (see
  // `claimsInFlight`); the re-judgement happens once, below, after this block
  // has published what the claim actually left behind.
  //
  // A teardown that began during the claim owns the run from here. Terminalizing
  // a failed claim past this point would write a SECOND durable record — from a
  // post-terminalize snapshot, contradicting the pre-terminalize one `shutdown`
  // already took — and race a second `closeSocket` against a superseder that is
  // watching the socket to confirm we are gone. No `checkSettled` on the way
  // out: in `--linger` it would fire `onSettledEach`, and finalizing a record
  // here is precisely the second write this park exists to prevent.
  if (shuttingDown) return await parkForShutdown();

  // This run owns every node's log file from the instant it has both a node set
  // and a machine to run on. Ownership used to be claimed off the LANE's frame
  // stream — a node's first write, or its log terminal — so a platform whose
  // claim failed, a lane that died provisioning, a lane cancelled before it
  // attached, left every node on it `skipped`/`errored` with no byte written and
  // `.ci/<sha7>/<plat>/<node>.log` still holding the PREVIOUS run's full output
  // under this run's red verdict: the same stale-by-address bug the claim was
  // added to close, surviving in the cases a reader is likeliest to go looking
  // at. The run knows its whole node set here; that is the authority to claim
  // from, rather than a downstream event stream. Idempotent, so the setup logs
  // the claim already narrated into keep their lines.
  for (const id of store.get().order) logs.claim(id);

  // Which lanes actually start. Two ways a platform drops out, both newly
  // reachable because the socket (and therefore `lane.cancel`, `cancel` and the
  // signals) is live across an `await` that did not exist before:
  //
  //   - the claim failed, so there is no machine for any lane;
  //   - the operator dropped THIS platform mid-claim (`odu cancel @plat` / MCP
  //     `lane_cancel`). `cancelPlatform` tombstones the platform execution, so
  //     the lane loop must not register workers for it afterward.
  //
  // A whole-run teardown is not a third way: `shuttingDown` parked above, and
  // there is no `await` between that check and here.
  const cancelledDuringClaim = (platform: string): boolean =>
    executions.isCancelled(platform);
  // A platform cancelled while its lease was in flight owns a lease nobody will
  // use — `cancelPlatform` could not release it, because the claim had not
  // handed the host over yet when the tombstone was set. Released BEFORE the
  // header is republished: publishing first would advertise a lane on a host
  // the coordinator has already given back, and `finalizeRunRecord` would write
  // that lane into the durable record.
  for (const platform of activePlatforms) {
    if (!cancelledDuringClaim(platform)) continue;
    // The terminalize `cancelPlatform` deferred: while the claim was in flight
    // this lane's nodes had to keep saying "not over", because they are what
    // every out-of-process reader judges settle by. The claim has returned, so
    // the cancel is now the whole truth about this lane.
    terminalizePlatformNodes(
      platform,
      deferredPlatformStops.get(platform) ?? CANCELLED_BY_OPERATOR,
    );
    delete lanesByPlatform[platform];
  }
  const survivors = activePlatforms.filter(
    (platform) => !cancelledDuringClaim(platform),
  );

  // ONE republish, on every exit from the claim, built from the lanes that
  // actually survived it. The roster is `claiming`-free by construction once
  // the claim has resolved (see `rosterFrom`), so a settled run can never be
  // reported as "provisioning" for the rest of the coordinator's life — and
  // there is no second branch that has to remember to say so.
  publishRoster(false);

  if (!outcome.ok) {
    // Provisioning failed — the run has no lanes and never will. Terminalize
    // through the same path a dead lane takes, so the failure is a red
    // `_ci-setup@<platform>` with the reason in its log rather than a bare
    // stderr line: `runs`, `wait_for_settle`, the commit statuses and the
    // verdict summary then all describe it in the vocabulary they already
    // speak. `allSettled` resolves off these transitions and the normal
    // completion path below writes the record and prints the verdict. The
    // header is published BEFORE this so no observer sees a terminal node set
    // beside a claiming header.
    //
    // Scoped by what the failed set actually covered. An agent-held lane has a
    // real host from `odu lease` and touched no pool, so reporting it as
    // `errored` with a message about a pool it never saw publishes a node that
    // lies about itself. It is still stopped — the run is fail-closed — but as
    // an abort, not as this failure.
    const claimedPlatforms = new Set(platformsToClaim);
    for (const platform of activePlatforms) {
      executions.cancel(platform);
      terminalizePlatformNodes(
        platform,
        claimedPlatforms.has(platform)
          ? laneDeath(outcome.error.message)
          : {
              running: "cancelled",
              pending: "skipped",
              log: `\n[odu] aborted: no machine for ${platformsToClaim.join(", ")}\n`,
            },
      );
    }
  }

  // The one re-judgement after the claim, covering every way out of it. The
  // failed-claim branch above terminalizes; a `lane.cancel` that landed
  // mid-claim already terminalized its own lane and was refused a settle by the
  // `claimInFlight` latch; and a run whose every lane was cancelled that way
  // starts no lane below, so nothing else would ever ask again and `allSettled`
  // would hang. One call, here, answers all three.
  checkSettled();

  // A failed claim got no machine for anything, so nothing starts: the
  // terminalize above is the whole of the run's state and the completion path
  // below writes its record and prints its verdict.
  for (const platform of outcome.ok ? survivors : []) {
    // Total in practice — a successful claim filled every platform it covered,
    // agent-held lanes arrived with a host, and lanes cancelled mid-claim were
    // dropped from the map above. `continue` is the honest answer if it isn't.
    const host = lanesByPlatform[platform];
    if (host === undefined) continue;
    const baseTasks = tasksByPlatform.get(platform) ?? [];
    const plans = plansFor(platform);
    const withPrimaryShardEnv = (tasks: readonly TaskSpec[]): TaskSpec[] =>
      plans.reduce(
        (configured, plan) =>
          tasksForShard(configured, plan.rootId, 0, plan.total),
        [...tasks],
      );
    let lane = primaryLanes.get(platform);
    if (lane === undefined) {
      lane = startPrimaryLane(platform, host, withPrimaryShardEnv(baseTasks));
    } else if (plans.length > 0) {
      const roots = plans.map((plan) => {
        const root = baseTasks.find((task) => task.id === plan.rootId);
        if (root === undefined) {
          throw new Error(`odu: shard root ${plan.rootId} disappeared`);
        }
        return tasksForShard([root], plan.rootId, 0, plan.total)[0]!;
      });
      const rootIds = new Set(roots.map((root) => root.id));
      const publicMainId = (laneId: string): string => {
        const plan = planFor(platform, laneId);
        return plan !== undefined && plan.total > 1
          ? fanId(shardNamepath(laneId, 0, plan.total), platform)
          : fanId(laneId, platform);
      };
      const routed = executions.extendLane(
        platform,
        lane,
        [...rootIds],
        publicMainId,
      );
      const extended = routed && (await lane.extend(roots));
      if (!extended && laneAccepting(platform)) {
        executions.cancel(platform);
        terminalizePlatformNodes(
          platform,
          laneDeath("primary lane rejected its deferred shard roots"),
        );
        continue;
      }
    }

    for (const plan of plans) {
      if (plan.total <= 1) continue;
      for (let index = 1; index < plan.total; index += 1) {
        const lease = plan.leases[index - 1];
        if (lease === undefined) continue;
        const projection = shardLaneProjection(platform, plan, index);
        const publicIdFor = projection.publicId;
        const setupId = projection.setupId;
        const publicLaneIds = projection.nodeIds;
        let burstLane: Lane | undefined;
        let finished = false;
        const finishBurst = (): void => {
          if (finished) return;
          const state = store.get();
          if (
            publicLaneIds.some((id) => {
              const status = state.nodes[id]?.status;
              return (
                status === "pending" ||
                status === "running" ||
                status === undefined
              );
            })
          ) {
            return;
          }
          finished = true;
          endLocal(setupId);
          burstLane?.close();
          releaseBurstLease(platform, lease);
        };
        const burstLocal = isLocalHost(lease.host);
        burstLane = buildLane({
          platform,
          host: lease.host,
          tasks: tasksForShard(plan.tasks, plan.rootId, index, plan.total),
          pipelineName: `${spec.name}:${plan.rootId}:${index + 1}/${plan.total}`,
          origin:
            burstLocal || originUrl === null ? null : fetchUrlFor(originUrl),
          sha: burstLocal ? null : sha,
          workspace: burstLocal ? specSource : null,
          resolveDrvPath: runnerResolverFor(platform),
          onSetupLine: (line) =>
            appendLocal(setupId, `[host ${shortHost(lease.host)}] ${line}\n`),
          onNodes: (laneState) => {
            if (!laneAccepting(platform)) return;
            for (const laneId of laneState.order) {
              const laneNode = laneState.nodes[laneId];
              if (laneNode === undefined) continue;
              const publicId = publicIdFor(laneId);
              const patch = {
                status: laneNode.status,
                exitCode: laneNode.exitCode,
                startedAt: laneNode.startedAt,
                durationMs: laneNode.durationMs,
              };
              // Like the primary `_ci-setup`, this log has a coordinator half
              // (`onSetupLine`) in addition to the runner stream. Its state is
              // therefore mirrored directly and its log is sealed only when
              // the whole burst lane settles.
              if (laneId === SETUP) updateNode(publicId, patch);
              else verdicts.offer(publicId, patch);
              if (laneId === plan.rootId) {
                refreshShardAggregate(platform, plan);
              }
            }
          },
          onLogFrame: (laneId, frame) => {
            if (!laneAccepting(platform)) return;
            const publicId = publicIdFor(laneId);
            if (frame.kind === "append") appendLocal(publicId, frame.text);
            else if (frame.kind === "snapshot") {
              if (laneId === SETUP) {
                if (frame.text !== "") appendLocal(publicId, frame.text);
              } else if (!logs.isNoopReset(publicId, frame.text)) {
                resetLocal(publicId, frame.text);
              }
            } else if (frame.kind === "end") {
              // `_ci-setup` still has a coordinator-side producer; finishBurst
              // seals it after the recipe root settles. Every recipe node uses
              // the ordinary verdict/log join.
              if (laneId !== SETUP) {
                endLocal(publicId);
                verdicts.release(publicId);
              }
              if (laneId === plan.rootId) {
                refreshShardAggregate(platform, plan);
              }
              finishBurst();
            }
          },
          onDead: (error) => {
            if (!laneAccepting(platform)) return;
            for (const id of publicLaneIds) {
              const status = store.get().nodes[id]?.status;
              if (status === "pending" || status === "running") {
                appendLocal(id, `\n[odu] shard lane died: ${error}\n`);
                endLocal(id);
                verdicts.release(id);
                updateNode(id, {
                  status: status === "running" ? "errored" : "skipped",
                  exitCode: 1,
                });
              } else {
                endLocal(id);
              }
            }
            refreshShardAggregate(platform, plan);
            finishBurst();
          },
        });
        createdLanes.add(burstLane);
        executions.addLane(
          platform,
          burstLane,
          [SETUP, ...plan.tasks.map((task) => task.id)],
          publicIdFor,
        );
      }
    }
  }

  // ── verdict artifacts ──
  // One rule with attach/status: settled and not clean → non-zero (juspay/odu#68).
  // A node that already reached `ok` is never re-terminalized by `onDead`
  // (see `terminalizePlatformNodes`), so a lane pipe dying after a green
  // verdict cannot move this projection (juspay/odu#18).
  const verdictCode = (state: PipelineState): number => exitCode(state);

  /** Say how the run ended, and answer with its code.
   *
   *  The CODE is the engine's — `verdictCode` derives it from the same state
   *  the face is handed — so a face cannot make a red run exit zero by
   *  rendering it wrongly. What the face decides is only whether anything is
   *  printed, and in what medium. */
  const reportVerdict = (
    state: PipelineState,
    unposted: ReadonlyArray<UnpostedEntry> = [],
  ): number => {
    face.verdict({
      state,
      sha7,
      dirty: ctx.dirty,
      commitUrl,
      unpostedCount: unposted.length,
    });
    return verdictCode(state);
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
    return await parkForShutdown();
  }

  await allSettled;
  // `allSettled` resolving says every node reached a terminal status — it says
  // nothing about whether `shutdown` also fired meanwhile (`run.cancel`,
  // SIGINT, lease.lost — all live across this await). See `parkForShutdown`
  // above: once `shuttingDown` is true, `shutdown` is this run's one terminal
  // owner, and this path must not resume past it.
  if (shuttingDown) return await parkForShutdown();

  // No drain here any more, and that is the point. `allSettled` resolving now
  // MEANS the logs are in: a node reaches a terminal status on the fan-in only
  // once its log has ended or been stamped short (see "the log join" above), so
  // by the time this line runs every lane has already delivered what it owed.
  // A second drain at teardown would be the old shape wearing a belt — and the
  // old shape is precisely what taught readers that teardown is where this is
  // handled, when teardown is the one moment nobody but the run itself is
  // watching (juspay/odu#87, and the settle-shaped residual after it).
  for (const lane of createdLanes) lane.close();
  // Lanes are shut: nothing can append to any node's log after this line, so
  // this is where the run says its last word about every one of them.
  flushSetupLines();
  endRunLogs();
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
  await flushToReaders();
  closeSocket();
  // The catalog record stops advertising a surface that is gone; the ownership
  // epoch stays, so nothing may write to this run without a real takeover.
  history.close();

  display.stop(finalState);
  // A run that never got a machine says WHY on the real stderr, once the live
  // view has handed the terminal back: the reason is in `_ci-setup`'s log and
  // the verdict names that path, but a config refusal ("pool must not mix
  // localhost with remote hosts") is a message the operator should not have to
  // go read a log file for. ONCE, from here — `PlainDisplay.info` and
  // `JsonDisplay.info` both write straight to stderr, so an `info()` at the
  // failure site printed the same text twice on exactly the piped/CI runs where
  // it is most likely to be read by a machine.
  if (!outcome.ok) {
    process.stderr.write(`${outcome.error.message}\n`);
  }
  return reportVerdict(finalState, unposted);
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
