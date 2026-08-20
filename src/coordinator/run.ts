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
import { bold, dim, link } from "../cli/ansi";
import {
  countsLine,
  exitCode,
  NON_TERMINAL_STATUSES,
  OUTCOME_COLOR,
  OUTCOME_LABEL,
  outcomeOf,
  statusGlyph,
  summarize,
} from "../cli/render";
import { formatGoDuration } from "../common/duration";
import { gitTopLevel } from "../common/git";
import { createNodeLogSink } from "./nodeLogSink";
import {
  fanId,
  isSetupNode,
  onPlatform,
  SETUP_NAMEPATH,
  splitFanId,
} from "../common/nodeId";
import type { TaskSpec } from "../common/spec";
import {
  claimingLanes,
  EMPTY_POSTING,
  leasedLanes,
  type NodeState,
  oduSurface,
  pendingNode,
  type PipelineState,
  type RunHeader,
  type RunLane,
  type UnpostedEntry,
} from "../common/surface";
import { commitLabel, createDisplay, progressEvent } from "./display";
import { laneTasks, loadJustPipeline, parseSelector } from "../just/ingest";
import { fanoutPools, loadHosts, shortHost } from "./hosts";
import { type Lane, startLane } from "./lane";
import { type LeaseHandle, localHolderId } from "./lease";
import { claimVenues } from "./runEnv";
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
import { releaseReservation, reserveNextSeq, writeRunRecord } from "./ledger";
import { buildRunRecord, projectNodes } from "../common/runRecord";
import {
  checkoutPaths,
  serveSocket,
  socketLogger,
  tryDialSocket,
} from "./socket";
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

/** The bucket list and order `odu run`'s final summary has always printed.
 *  Kept explicit and zero-inclusive: the live faces drop empty buckets (a
 *  status bar has no room for `0 errored`), but this line is the run's durable
 *  verdict and is the kind of output people grep. */
const VERDICT_BUCKETS = [
  "ok",
  "failed",
  "errored",
  "skipped",
  "cancelled",
] as const;

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
    existing.close();
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

/** Injectable collaborators. One member, and it exists for one reason: the venue
 *  claim is the only thing in `orchestrate` that both takes minutes and cannot
 *  be reached from a test — it dials ssh. Everything the socket must get right
 *  *while a claim is outstanding* (a cancel that lands mid-claim, a teardown
 *  that starts mid-claim) is therefore untestable without a claim a test can
 *  hold open. Same shape as `ensureCheckoutFree`'s `deps`. */
export interface RunDeps {
  claimVenues?: typeof claimVenues;
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
          openLog: (id) => logs.streamSource({ id }),
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
              pool: [...(poolsByPlatform[platform] ?? [])],
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
  const appendLocal = logs.append;
  const resetLocal = logs.reset;
  const endLocal = logs.end;
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

  /** Say what a torn-down run's logs lost, before `endRunLogs` says they ended.
   *
   *  Which nodes were owed output is answered from what each log IS, not from
   *  what its node's status suggests: a log that has not published its terminal
   *  is one the run was still expecting bytes for. Status only excludes the
   *  nodes that were never owed anything — `pending` (never started) and
   *  `skipped` (never runs, and the runner ends its log at the moment it is
   *  skipped). Stamping those would be its own small lie, and the whole reason
   *  this notice exists is that a truncation notice is worth exactly as much as
   *  its worst sentence. No duration: nothing was measured here, the run was
   *  simply stopped. */
  /** Write the one sentence that says a node's log is short, and why.
   *
   *  ONE producer, because this notice is a contract: the e2e suite greps for
   *  it, and every round of review on it has been about the same rule — a
   *  truncation notice is worth exactly its worst sentence. Two copies of the
   *  wording are two chances for one to drift out of that guarantee.
   *
   *  Sealed logs are skipped, and that is the load-bearing half. A log ends
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
   *  gets the last say. */
  const stampTruncated = (id: string, cause: string): void => {
    if (logs.isEnded(id)) return;
    appendLocal(
      id,
      `\n[odu] log truncated: ${cause} with this node's output still owed` +
        " — what follows the last line was never received\n",
    );
  };

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
  const drainLaneLogs = async (lanes: Iterable<Lane>): Promise<void> => {
    await Promise.all(
      [...lanes].map(async (lane) => {
        const drained = await lane.drain();
        if (drained.reason === "complete") return;
        const why =
          drained.reason === "idle"
            ? `went silent for ${drained.idleMs / 1000}s`
            : "went away (closed or died)";
        for (const laneId of drained.undrained) {
          stampTruncated(fanId(laneId, lane.platform), `${lane.platform} ${why}`);
        }
      }),
    );
  };

  // ── the fan-in surface (status / logs / attach dial this) ──
  // (laneEntries defined above with cancel/rerun routing)
  // Lane registry: live handles plus operator-cancelled tombstones so frame /
  // death / node-cancel paths share one liveness fact (no parallel Set).
  type LaneEntry =
    | { phase: "live"; handle: Lane }
    | { phase: "operator_cancelled" };
  const laneEntries = new Map<string, LaneEntry>();
  const liveLane = (platform: string): Lane | undefined => {
    const e = laneEntries.get(platform);
    return e?.phase === "live" ? e.handle : undefined;
  };
  const laneAccepting = (platform: string): boolean =>
    laneEntries.get(platform)?.phase === "live";

  // Route a rerun request to the owning lane. A bare lane-local id (no `@`)
  // carries no platform: splitFanId reports it as the "unknown" sentinel, which
  // has no lane, so the request is unroutable — `false`, same as a missing
  // lane. The surface's `node.rerun` and the live view's `r` key both call this.
  const rerunNode = async (id: string): Promise<boolean> => {
    const { namepath, platform } = splitFanId(id);
    const lane = platform === "unknown" ? undefined : liveLane(platform);
    if (lane === undefined) return false;
    return lane.rerun(namepath);
  };

  /** What an operator lane-drop does to a lane's unfinished nodes. Named once
   *  because it is applied from two places now: immediately, when the lane is
   *  live, and deferred to the claim's return when the drop landed mid-claim. */
  const CANCELLED_BY_OPERATOR = {
    running: "cancelled",
    pending: "cancelled",
    log: "\n[odu] cancelled by operator (lane)\n",
  } as const;

  /** Give back the run-owned lease on `host`, if there is one. The only writer
   *  of `acquiredLeases` on the drop path, so "released" and "still in the
   *  array" cannot come apart — the two call sites (an operator lane cancel,
   *  and the post-claim sweep of lanes cancelled while their lease was in
   *  flight) used to maintain that invariant separately. A no-op for an
   *  agent-held lane, which is never in `acquiredLeases`. */
  const releaseLeaseFor = (host: string): void => {
    const idx = acquiredLeases.findIndex((l) => l.host === host);
    if (idx < 0) return;
    acquiredLeases[idx]?.release();
    acquiredLeases.splice(idx, 1);
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
    const state = store.get();
    const now = Date.now();
    for (const id of state.order) {
      if (!onPlatform(id, platform)) continue;
      const node = state.nodes[id];
      if (node === undefined) continue;
      if (node.status === "running") {
        appendLocal(id, strategy.log);
        const startedAt = node.startedAt ?? now;
        updateNode(id, {
          status: strategy.running,
          durationMs: now - startedAt,
        });
      } else if (node.status === "pending") {
        updateNode(id, { status: strategy.pending });
      } else {
        continue;
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
    const entry = laneEntries.get(platform);
    if (entry?.phase === "operator_cancelled") return true;
    const state = store.get();
    const hasNodes = state.order.some((id) => onPlatform(id, platform));
    if (!hasNodes && entry === undefined) return false;
    // Tombstone first so a racing frame cannot re-accept updates.
    const handle = entry?.phase === "live" ? entry.handle : undefined;
    laneEntries.set(platform, { phase: "operator_cancelled" });
    // Close so the runner dies without onDead → errored.
    handle?.close();
    // Free a run-owned lease so the box is reusable; agent-held leases are
    // never in acquiredLeases. Accepted window: lane.close() only destroys the
    // local ssh session — the remote runner's SIGKILL of recipe groups races
    // with this release (same shape as whole-run shutdown). A new claim may
    // see a still-terminating process group for a short window.
    const host = lanesByPlatform[platform];
    if (host !== undefined) releaseLeaseFor(host);
    // Terminalizing is DEFERRED while a claim is outstanding — see
    // `claimInFlight` for why, and `cancelledDuringClaim` for where the claim's
    // return picks these lanes back up.
    if (claimInFlight) return true;
    terminalizePlatformNodes(platform, CANCELLED_BY_OPERATOR);
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
    const lane = liveLane(platform);
    if (lane === undefined) {
      return isSetupNode(id) ? cancelPlatform(platform) : false;
    }
    return lane.cancel(namepath);
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

  /** Fail closed if a remote hold dies mid-run (ssh drop, optional MAX_HOLD,
   *  remote kill): exclusivity is gone and another laptop can claim the same
   *  flock. Intentional `release()` does not fire `lost`. Called once per lease
   *  as the claim hands it over — the claim now runs *after* this point (the
   *  socket serves first, juspay/odu#84), so there is no set to sweep here. */
  const watchLease = (lease: LeaseHandle): void => {
    void lease.lost?.then(() => {
      shutdown(1, `venue lease lost on ${shortHost(lease.host)}`, {
        exclusivityLost: true,
      });
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
  /** Is a venue claim outstanding right now? While it is, this run is NOT
   *  settleable however terminal its nodes look.
   *
   *  The node states are the run's answer to "is this over" for every reader
   *  outside this process — `wait_for_settle` and `odu wait` judge the `nodes`
   *  cell, not this module's `checkSettled`. So a `lane.cancel` during the claim
   *  that terminalized its lane at once would, on a single-platform run, make
   *  every node terminal while `claimVenues` is still copying a closure onto a
   *  box, still holding the checkout's one-run lock, and still about to hand
   *  back a lease. A `wait_for_settle` answering "settled, cancelled" there
   *  tells an agent the run is over; its next `run()` hits "a run is already in
   *  progress". The claim's own return is what ends this window: it clears the
   *  latch, terminalizes the lanes tombstoned meanwhile, and re-judges settle
   *  once. */
  let claimInFlight = false;

  const checkSettled = (): void => {
    if (claimInFlight) return;
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
      const payload = statusFor(id, next.status, next.durationMs, sha7);
      if (payload !== null) poster.post(payload);
      checkSettled();
    }
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

  /** Narrate one provisioning line into the lane's `_ci-setup` log as well as
   *  the operator feed. The claim's ssh session emits the `copying path …`
   *  progress this run is otherwise silent about; filed here it reaches
   *  `odu logs -f _ci-setup@<platform>` and the attach log pane. */
  const setupLine = (msg: string, platform: string): void => {
    info(msg);
    appendLocal(fanId(SETUP, platform), `${msg}\n`);
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
            startedAt: runtime.ctx.cells.header.get().startedAt,
            finishedAt: Date.now(),
            // The record describes machines the run actually had; a lane still
            // claiming one has nothing to record. Read off the store every
            // face reads, so the record cannot describe a different run
            // environment from the one the surface published.
            lanes: leasedLanes(runtime.ctx.cells.header.get()),
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
  // Latched before the claim starts: a cancel arriving mid-claim may terminalize
  // every node, but the run is not over until the claim that holds the box is.
  claimInFlight = platformsToClaim.length > 0;
  const claim = (deps.claimVenues ?? claimVenues)({
    repoRoot,
    pools: resolvedPools,
    platforms: platformsToClaim,
    identity: { holder: localHolderId(), run: runLabel },
    noWait: args.noWait,
    runLabel,
    onLine: setupLine,
    resolveDrvPath: (platform) => runnerDrvResolver(runnerFlake, platform),
  });
  await seeded;
  // A cancel during that round trip must not go on to stamp `_ci-setup` running
  // (posting `pending` to GitHub *after* the interrupt statuses) on a
  // coordinator that is already exiting.
  if (shuttingDown) {
    // The claim is outstanding and nothing downstream will merge its handles
    // into `acquiredLeases`, so hand them straight back rather than leaving a
    // remote flock held by a coordinator on its way out. Best-effort: `shutdown`
    // may well `process.exit` first, which frees the same locks by dropping the
    // ssh connections.
    void claim.then((o) => {
      if (o.ok) for (const lease of o.leases) lease.release();
    });
    return await parkForShutdown();
  }

  // The `_ci-setup` bracket opens for the lanes whose claim it BRACKETS: from
  // here until such a lane is up, this node IS the run's visible state, and its
  // log is where the claim narrates itself. An agent-held lane claims nothing,
  // so opening its bracket here would have its `_ci-setup` duration measure a
  // sibling platform's claim wait — the one number that node exists to measure,
  // measuring something else. It opens at its own lane start instead.
  for (const platform of platformsToClaim) startSetup(platform);

  const outcome = await claim;
  if (outcome.ok) {
    Object.assign(lanesByPlatform, outcome.lanes);
    for (const lease of outcome.leases) {
      acquiredLeases.push(lease);
      watchLease(lease);
    }
  }
  // The claim is no longer in flight, so settle may be judged again — a cancel
  // that arrived mid-claim deliberately did not resolve it (see
  // `claimInFlight`), and the re-judgement happens once, below, after this
  // block has published what the claim actually left behind.
  claimInFlight = false;
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
  //     `lane_cancel`). `cancelPlatform` tombstones the entry, but the lane loop
  //     below ends in `laneEntries.set(platform, {phase:"live"})` — which would
  //     overwrite the tombstone, re-open every `laneAccepting`-gated mirror
  //     path, resurrect the nodes the cancel marked `cancelled`, and start the
  //     lane on the machine the operator just dropped.
  //
  // A whole-run teardown is not a third way: `shuttingDown` parked above, and
  // there is no `await` between that check and here.
  const cancelledDuringClaim = (platform: string): boolean =>
    laneEntries.get(platform)?.phase === "operator_cancelled";
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
    terminalizePlatformNodes(platform, CANCELLED_BY_OPERATOR);
    const host = lanesByPlatform[platform];
    if (host === undefined) continue;
    releaseLeaseFor(host);
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
  publishHeader({
    ...runtime.ctx.cells.header.get(),
    lanes: rosterFrom(survivors, false),
  });

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
    // Scoped by what the claim actually covered. `leaseLanes` owns the
    // all-or-nothing policy over `platformsToClaim`; an agent-held lane has a
    // real host from `odu lease` and touched no pool, so reporting it as
    // `errored` with a message about a pool it never saw publishes a node that
    // lies about itself. It is still stopped — the run is fail-closed — but as
    // an abort, not as this failure.
    const claimedPlatforms = new Set(platformsToClaim);
    for (const platform of activePlatforms) {
      terminalizePlatformNodes(
        platform,
        claimedPlatforms.has(platform)
          ? {
              running: "errored",
              pending: "skipped",
              log: `\n[odu] ${outcome.error.message}\n`,
            }
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
    // The provisioning bracket for a lane that claimed nothing opens here, at
    // its own start, rather than at a claim it was never part of.
    startSetup(platform);
    const tasks = tasksByPlatform.get(platform) ?? [];
    const setupId = fanId(SETUP, platform);

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
        if (!laneAccepting(platform)) return;
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
        } else if (frame.kind === "end") {
          // Pass the log's terminal on to the fan-in's own readers — except for
          // _ci-setup, for the same reason its snapshot is dropped below: the
          // coordinator keeps writing to that node's log after the lane is done
          // with it (lane death, operator cancel), so it is not complete just
          // because the lane's half is. `endRunLogs` ends it when the RUN is.
          if (laneId !== SETUP) endLocal(id);
        } else if (laneId === SETUP) {
          // Never reset _ci-setup: the coordinator's provision lines precede
          // the lane stream and must survive the lane's snapshot frame.
          if (frame.text !== "") appendLocal(id, frame.text);
        } else if (!logs.isNoopReset(id, frame.text)) {
          // One question — "would this snapshot change anything a reader can
          // observe?" — asked of the tail, which is where every observable a
          // log has lives. Asked here as a hand-built disjunct it grew a clause
          // per defect found (the last one: a rerun of a node that produced
          // nothing sends an empty snapshot over an empty buffer, and swallowing
          // it left the `ended` latch set, so `logs -f` on the rerunning node
          // exited at once insisting the log was complete).
          resetLocal(id, frame.text);
        }
      },
      onDead: (error) => {
        // Operator platform-cancel tombstones the entry; if a race still fires,
        // don't overlay cancelled with errored.
        if (!laneAccepting(platform)) return;
        terminalizePlatformNodes(platform, {
          running: "errored",
          pending: "skipped",
          log: `\n[odu] lane died: ${error}\n`,
        });
      },
    });
    // Register the session for the runCommand `finally` sweep the instant it
    // exists — before laneEntries.set — so a throw later in this loop still leaves
    // every already-built lane reachable for teardown.
    createdLanes.add(lane);
    laneEntries.set(platform, { phase: "live", handle: lane });
  }

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

  // One rule with attach/status: settled and not clean → non-zero (juspay/odu#68).
  const verdictCode = (state: PipelineState): number => exitCode(state);

  // The human verdict summary — foreground completion only, never mid-linger
  // where the live display still owns the screen. Returns the exit code.
  const printVerdict = (
    state: PipelineState,
    unposted: ReadonlyArray<UnpostedEntry> = [],
  ): number => {
    const counts = summarize(state);
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
      const glyph = statusGlyph(node.status);
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
    // The outcome taxonomy and the counts line both come from `render.ts` —
    // this summary, the live header and the live status bar were three
    // hand-rolled versions, and only this one knew about INCOMPLETE.
    const outcome = outcomeOf(counts);
    const label = bold(OUTCOME_COLOR[outcome](OUTCOME_LABEL[outcome]));
    lines.push(
      `${countsLine(counts, VERDICT_BUCKETS, true)} — ${label}${debt !== "" ? dim(debt) : ""}`,
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
    return await parkForShutdown();
  }

  await allSettled;

  // The DAG has settled, but the LOGS have not: a node's status and its output
  // travel on different streams, and the status one arrives first. Join them
  // here — before the lanes are closed — or the tail of every noisy recipe,
  // summary included, dies with the subscription (juspay/odu#87).
  await drainLaneLogs(createdLanes);

  for (const lane of createdLanes) lane.close();
  // Lanes are shut: nothing can append to any node's log after this line, so
  // this is where the run says its last word about every one of them.
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
  closeSocket();

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
