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
  type LogStream,
  logStreamKey,
  onPlatform,
  SETUP_NAMEPATH,
  splitFanId,
} from "@odu/run-client/nodeId";
import {
  claimingLanes,
  EMPTY_POSTING,
  leasedLanes,
  type NodePush,
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
  unpostedNote,
} from "../common/verdict";
import {
  type MakeRunFace,
  progressEvent,
  SILENT_FACE,
} from "../common/presentation";
import { gitBranch, gitDefaultBranch, gitTopLevel } from "../common/git";
import { appendIfOpen, createNodeLogSink } from "./nodeLogSink";
import { createVerdictGate } from "./verdictGate";
import { maxLaneResurrections } from "./laneResurrection";
import type { TaskSpec } from "../common/spec";
import { laneTasks, loadJustPipeline, parseSelector } from "../just/ingest";
import { asHostSlot, fanoutPools, loadHosts, shortHost } from "./hosts";
import { type Lane, startLane } from "./lane";
import { takePushToken } from "./launcher";
import { pushEnvFor } from "../runner/pushResults";
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
import { laneRunnerDrvPath, requireBakedRunnerSource } from "./runnerFlake";
import { cancelRun } from "./cancel";
import {
  liveRunLockPid,
  signalRunLockHolder,
  tryAcquireRunLock,
  waitForRunLockFree,
  type RunLockHandle,
} from "./checkoutLock";
import { releaseReservation, reserveNextSeq, writeRunRecord } from "@odu/run-history/legacy/ledger";
import { snapshotWorkingTree, treeModeFor, type WorkingTreeSnapshot } from "./workingTree";
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
} from "./statuses";
import { ghForge, type Forge } from "../common/forge";
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
   *  refusing on the one-run lock. */
  supersede: boolean;
  /** Keep the coordinator serving after the run drains, so a node can be
   *  rerun post-settle; exit only on cancel / signal / idle backstop. */
  linger: boolean;
  /** When every host in a platform's pool is busy, fail immediately instead
   *  of waiting in line for a free machine (juspay/odu#54). */
  noWait: boolean;
  /** The commit this run claims to be about. Absent for a run somebody
   *  typed: HEAD is then, by definition, what they meant. */
  expectedSha?: string;
  /** The catalog id this run must publish under, minted by whoever launched
   *  it. Absent means mint one — the ordinary path. */
  runId?: string;
  /** The run this one replays, for a recovery launch. */
  parentRunId?: string;
  /** The launcher's idempotency key, recorded on the manifest so a receipt and
   *  a run can be matched up after the fact. */
  requestId?: string;
  /** WHO ASKED FOR THIS RUN — a login, or `@local` for a loopback
   *  connection. Recorded on the manifest; absent when the launcher had no
   *  principal to name. */
  actor?: string;
  /**
   * WHERE THIS RUN PUSHES WHAT IT BUILDS — the substituter the checkout's
   * `flake.nix` reads from, the ORIGIN and bucket the daemon resolved it to,
   * and the id the run's write token is revoked by.
   *
   * The TOKEN is not here: the launcher left it in `runs/<id>/push.token` and
   * this process reads and unlinks it at startup. Absent for a run that pushes
   * nothing.
   */
  push?: { substituter: string; origin: string; bucket: string; tokenId: string };
  /** The ONE line the setup node's log says about pushing — a skip reason, or
   *  the `trusted-public-keys` warning. Absent when there is nothing to say. */
  pushSkipped?: string;
  pushKeyWarning?: string;
  /** What the service had to do to this checkout before the run could be
   *  about this commit — "moved <path> to <branch> at <sha7>". Absent when
   *  nothing was moved. */
  checkoutMoved?: string;
}

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
    await existing.close();
    return refuseLive;
  }
  if (liveLockPid(lockPath) !== null) return refuseLive;
  return { ok: true };
}

export type ReservationState =
  | { status: "unreserved" }
  | { status: "reserved"; seq: number; published: boolean };

export function shouldReclaimReservation(
  reservation: ReservationState,
): reservation is { status: "reserved"; seq: number; published: false } {
  return reservation.status === "reserved" && !reservation.published;
}

export function applyInterruptStopWork(
  phase: "before-settle" | "after-settle",
  exclusivityLost: boolean,
  stop: () => void,
): void {
  if (phase === "after-settle" || exclusivityLost) stop();
}

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

export interface RunDeps {
  claimVenues?: typeof claimVenues;
  leaseBurstSlots?: typeof leaseBurstSlots;
  startLane?: typeof startLane;
  face?: MakeRunFace;
}

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
  const runnerFlake = requireBakedRunnerSource();

  const repoRoot = gitTopLevel();
  if (repoRoot === null) {
    throw new Error(
      "odu: git rev-parse --show-toplevel failed: not a git checkout",
    );
  }

  const treeMode = treeModeFor(args);
  const posting = treeMode === "strict" && !args.noPost;
  let dirty = git(repoRoot, ["status", "--porcelain"]) !== "";
  if (treeMode === "strict" && dirty) {
    process.stderr.write(
      "odu: working tree is dirty — strict mode refuses it.\n" +
        "Commit (or stash) first, or pass --no-strict for a dev iteration run.\n",
    );
    return 1;
  }

  const sha = git(repoRoot, ["rev-parse", "HEAD"]);
  if (sha === "") {
    process.stderr.write(
      `odu: could not read HEAD in ${repoRoot} — \`git rev-parse HEAD\` ` +
        "answered with nothing. odu runs a commit, so it will not guess one.\n",
    );
    return 1;
  }
  const sha7 = sha.slice(0, 7);

  if (args.expectedSha !== undefined && !sameCommit(sha, args.expectedSha)) {
    process.stderr.write(
      `odu: this checkout is at ${sha7}, not ${args.expectedSha.slice(0, 7)} — ` +
        "refusing to run a different commit than the one asked for.\n" +
        `Check out ${args.expectedSha.slice(0, 7)} in ${repoRoot} and try again.\n`,
    );
    return 1;
  }

  let snapshotDir: string | null = null;
  if (treeMode === "strict") {
    snapshotDir = mkdtempSync(join(tmpdir(), `odu-${sha7}-`));
    git(repoRoot, ["worktree", "add", "--detach", snapshotDir, "HEAD"]);
  }
  const snapshot = treeMode === "working-tree" ? snapshotWorkingTree(repoRoot, { bundle: false }) : null;
  if (snapshot !== null) {
    if (snapshot.base !== sha) { snapshot.cleanup(); throw new Error("odu: HEAD changed during snapshot capture; start a new run"); }
    dirty = snapshot.dirty;
  }
  const specSource = snapshot?.worktreeDir ?? snapshotDir ?? repoRoot;

  const cleanupSnapshot = (): void => {
    snapshot?.cleanup();
    if (snapshotDir === null) return;
    tryGit(repoRoot, ["worktree", "remove", "--force", snapshotDir]);
    rmSync(snapshotDir, { recursive: true, force: true });
    snapshotDir = null;
  };
  process.once("exit", cleanupSnapshot);

  const createdLanes = new Set<Lane>();
  const acquiredLeases: LeaseHandle[] = [];
  const runLock: { handle: RunLockHandle | null } = { handle: null };
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
        forge: ghForge(),
        treeMode,
        snapshot,
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
  runnerFlake: string;
  sha: string;
  sha7: string;
  posting: boolean;
  forge: Forge;
  treeMode: ReturnType<typeof treeModeFor>;
  snapshot: WorkingTreeSnapshot | null;
  dirty: boolean;
}

async function orchestrate(
  args: RunArgs,
  ctx: RunContext,
  createdLanes: Set<Lane>,
  acquiredLeases: LeaseHandle[],
  reservation: { current: ReservationState },
  runLock: { handle: RunLockHandle | null },
  deps: RunDeps,
): Promise<number> {
  const { repoRoot, specSource, runnerFlake, sha, sha7 } = ctx;
  const face = (deps.face ?? SILENT_FACE)({
    openLog: (id) => logs.streamSource({ id }),
    rerun: (id) => void rerunNode(id),
    onQuit: () => shutdown(130),
  });
  const display = face.display;
  const info = (msg: string): void => {
    display.info(msg);
  };

  const spec = loadJustPipeline(specSource, { root: args.root });
  const hostsConfig = loadHosts();
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

  const originUrl = tryGit(repoRoot, ["remote", "get-url", "origin"]);
  const github = originUrl !== null ? parseGithubRemote(originUrl) : null;
  if (ctx.posting && github === null) {
    throw new Error(
      "odu: posting commit statuses needs a github.com origin remote " +
        "(pass --no-post for non-GitHub strict runs)",
    );
  }
  const repo = github !== null ? repoSlug(github) : null;
  const ref = gitBranch(repoRoot);
  const defaultBranch = gitDefaultBranch(repoRoot);

  const pushToken = args.push === undefined ? null : takePushToken(args.runId);
  const pushing = args.push !== undefined && pushToken !== null ? args.push : null;
  type PinDecision =
    | { kind: "named"; name: string }
    | { kind: "skipped"; why: string }
    | { kind: "none" };
  const pinDecisionFor = (task: TaskSpec, platform: string): PinDecision => {
    const declared = task.pin;
    if (declared === undefined) return { kind: "none" };
    const said = declared
      .map((pin) => (pin === null ? "its default branch" : `"${pin}"`))
      .join(", ");
    if (ref === null) {
      return {
        kind: "skipped",
        why:
          `this run is on a detached HEAD, and recipe "${task.id}" ` +
          `pins only on ${said}`,
      };
    }
    const matched = declared.some((pin) =>
      pin === null ? defaultBranch !== null && defaultBranch === ref : pin === ref,
    );
    if (!matched) {
      if (declared.includes(null) && defaultBranch === null) {
        return {
          kind: "skipped",
          why:
            `this checkout's origin has no HEAD, so there is no default ` +
            `branch to pin recipe "${task.id}" on; set it ` +
            "(`git remote set-head origin -a`) or name the ref: " +
            "`odu:pin=<ref>`",
        };
      }
      return { kind: "none" };
    }
    if (repo === null) {
      return {
        kind: "skipped",
        why:
          `this checkout has no github.com origin remote, so there is no ` +
          `owner/repo to name recipe "${task.id}"'s pin with`,
      };
    }
    return { kind: "named", name: `${repo}@${ref}/${platform}` };
  };
  const pushFacts =
    pushing === null || pushToken === null
      ? null
      : {
          origin: pushing.origin,
          bucket: pushing.bucket,
          token: pushToken,
          run: args.runId,
          commit: sha,
        };
  const withPushEnv = (
    tasks: readonly TaskSpec[],
    platform: string,
  ): TaskSpec[] => {
    if (pushFacts === null) return [...tasks];
    return tasks.map((task) => {
      const pin = pinDecisionFor(task, platform);
      const env = pushEnvFor({
        ...pushFacts,
        ...(pin.kind === "named" ? { pin: pin.name } : {}),
      });
      return { ...task, env: { ...(task.env ?? {}), ...env } };
    });
  };
  const platforms = Object.keys(poolsByPlatform).sort();
  const tasksByPlatform = new Map<string, TaskSpec[]>();
  for (const platform of platforms) {
    const tasks = withPushEnv(
      laneTasks(spec, platform, selectors, args.noDeps),
      platform,
    );
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
    if (ctx.treeMode === "in-place" && remotes.length > 0) {
      throw new Error(
        `odu: live-tree mode (--no-snapshot) only ` +
          `applies to localhost lanes — remote host(s) in ${platform} pool ` +
          `(${remotes.join(", ")}) would fetch the committed HEAD (${ctx.sha7}), ` +
          `not your uncommitted changes. Commit and push first, pin localhost ` +
          `with --host ${platform}=localhost, or pass --no-strict without --no-snapshot to ship a snapshot of your working tree.`,
      );
    }
  }

  if (ctx.snapshot !== null) {
    const needsTransport = process.env.ODU_SNAPSHOT_TRANSPORT === "always" ||
      [...tasksByPlatform.keys()].some(platform =>
        (poolsByPlatform[platform] ?? []).some(entry => !isLocalHost(asHostSlot(entry).host)));
    if (needsTransport && originUrl === null)
      throw new Error("odu: snapshot transport has no origin remote to fetch from");
    if (needsTransport) ctx.snapshot.prepareBundle();
    const snap = ctx.snapshot;
    info(`odu · working tree snapshot ${snap.contentSha.slice(0, 7)} = ${sha7} + ${snap.overlay.count} paths (${snap.overlay.paths.join(", ")}) — captured in ${snap.captureMs} ms; ${snap.bundle?.bytes ?? 0} bytes to ship`);
  }

  const { socketPath, lockPath } = checkoutPaths(repoRoot);
  const checkout = await ensureCheckoutFree(
    { socketPath, lockPath },
    args.supersede,
  );
  if (!checkout.ok) {
    process.stderr.write(`${checkout.message}\n`);
    return 1;
  }

  const claimed = tryAcquireRunLock(lockPath);
  if (claimed === null) {
    process.stderr.write(
      "odu: a run is already in progress in this checkout\n" +
        "(pass --supersede to cancel it and start fresh)\n",
    );
    return 1;
  }
  runLock.handle = claimed;

  const seq = reserveNextSeq(repoRoot, sha7);
  if (seq !== null) {
    reservation.current = { status: "reserved", seq, published: false };
  }

  const history = openRunHistory({
    repoRoot,
    repo,
    branch: ref,
    sha,
    seq,
    pipeline: spec.name,
    scope: {
      selectors: [...args.selectors],
      platforms: [...args.platforms],
      ...(args.root === undefined ? {} : { root: args.root }),
      noDeps: args.noDeps,
    },
    hostPins: [...args.hostPins],
    hostsFile: process.env.ODU_HOSTS ?? "",
    snapshotMode: ctx.treeMode === "strict" ? "strict" : "live",
    ...(ctx.snapshot?.dirty ? { contentSha: ctx.snapshot.contentSha } : {}),
    ...(ctx.snapshot === null ? {} : { overlay: ctx.snapshot.overlay }),
    dirty: ctx.dirty,
    runnerFlake,
    oduVersion: ODU_VERSION,
    endpoint: socketPath,
    ...(args.runId === undefined ? {} : { runId: args.runId }),
    ...(args.parentRunId === undefined ? {} : { parentRunId: args.parentRunId }),
    ...(args.requestId === undefined ? {} : { requestId: args.requestId }),
    ...(args.actor === undefined ? {} : { actor: args.actor }),
    ...(args.push === undefined &&
    args.pushSkipped === undefined &&
    args.pushKeyWarning === undefined
      ? {}
      : {
          push: {
            target: args.push ?? null,
            skipped: args.pushSkipped ?? null,
            keyWarning: args.pushKeyWarning ?? null,
          },
        }),
  });
  if (history.runId !== null) {
    info(`odu · run ${history.runId} — evidence: odu ci logs --run ${history.runId} <node>`);
  }

  const activePlatforms = [...tasksByPlatform.keys()].sort();
  const runLabel = seq !== null ? `${sha7}#${seq}` : sha7;
  const pinPlatforms = new Set(
    args.hostPins.map((p) => p.split("=")[0]).filter((x): x is string => !!x),
  );
  const agentHeld = liveHeldPlatforms(repoRoot);
  const lanesByPlatform: Record<string, string> = {};
  for (const platform of activePlatforms) {
    if (pinPlatforms.has(platform)) continue;
    const held = agentHeld[platform];
    if (held === undefined) continue;
    lanesByPlatform[platform] = held;
    info(
      `${platform}: using agent-held ${held} (odu ci lease — lock untouched on run exit)`,
    );
  }

  const order: string[] = [];
  const nodes: Record<string, NodeState> = {};
  for (const platform of [...tasksByPlatform.keys()].sort()) {
    const tasks = tasksByPlatform.get(platform) ?? [];
    const setupId = fanId(SETUP, platform);
    order.push(setupId);
    nodes[setupId] = pendingNode({
      id: setupId,
      name: setupId,
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
  const earlyTasksFor = (platform: string): TaskSpec[] =>
    (tasksByPlatform.get(platform) ?? []).filter(
      (task) => task.shards === undefined,
    );
  const shardRootsFor = (platform: string): TaskSpec[] =>
    (tasksByPlatform.get(platform) ?? []).filter(
      (task) => task.shards !== undefined,
    );
  const rosterFrom = (
    platforms: readonly string[],
    beforeClaim: boolean,
  ): RunLane[] =>
    platforms.flatMap((platform): RunLane[] => {
      const host = lanesByPlatform[platform];
      if (host !== undefined) return [{ state: "leased", platform, host }];
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

  const initialHeader = ((): RunHeader => ({
    commitUrl:
      github !== null
        ? `https://github.com/${github.owner}/${github.repo}/commit/${sha}`
        : null,
    lanes: rosterFrom(activePlatforms, true),
    hostsSource: hostsConfig.source,
    startedAt: Date.now(),
  }))();

  const logs = createNodeLogSink(repoRoot, sha7);
  const nodeHosts = new Map<string, string>();
  let flushSetupLines: () => void = () => {};
  const appendLocal = (
    id: string,
    text: string,
    stream: LogStream = "recipe",
  ): void => {
    if (logs.isEnded(id, stream)) return;
    logs.append(id, text, stream);
    history.log(id, text, nodeHosts.get(id) ?? null, stream);
  };
  const resetLocal = (
    id: string,
    text: string,
    stream: LogStream = "recipe",
  ): void => {
    logs.reset(id, text, stream);
    history.replaceLog(id, text, nodeHosts.get(id) ?? null, stream);
  };
  const endLocal = (id: string, stream: LogStream = "recipe"): void => {
    logs.end(id, stream);
    if (stream === "recipe") history.logFinalized(id, true, null);
  };
  const sealNodeLogs = (id: string): void => {
    endLocal(id);
    endLocal(id, "push");
  };

  const endRunLogs = (): void => {
    for (const id of store.get().order) sealNodeLogs(id);
  };

  const stampTruncated = (id: string, cause: string): void => {
    appendLocal(
      id,
      `\n[odu] log truncated: ${cause} with this node's output still owed` +
        " — what follows the last line was never received\n",
    );
    history.logFinalized(id, false, cause);
  };

  const stampUnfinishedLogs = (): void => {
    const state = store.get();
    for (const id of state.order) {
      const status = state.nodes[id]?.status;
      if (status === undefined || status === "pending" || status === "skipped") {
        continue;
      }
      if (splitFanId(id).namepath === SETUP && status !== "running") continue;
      stampTruncated(id, "the run was stopped");
    }
  };

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

  const executions = new ExecutionRoster((lease) => {
    const idx = acquiredLeases.indexOf(lease);
    if (idx >= 0) acquiredLeases.splice(idx, 1);
    lease.release();
  });
  const laneAccepting = (platform: string): boolean =>
    executions.accepts(platform);

  const rerunNode = async (
    id: string,
    request?: { requestId: string; inputDigest: string },
    expectAttempt?: number,
  ): Promise<{
    ok: boolean;
    recorded?: boolean;
    refusal?: "stale_attempt";
    attempt?: number;
  }> => {
    const { platform } = splitFanId(id);
    if (platform === "unknown") return { ok: false };
    const route = executions.route(platform, id);
    if (route === undefined) return { ok: false };
    if (expectAttempt !== undefined) {
      const attempt = history.currentAttempt(id);
      if (attempt !== expectAttempt) {
        return { ok: false, refusal: "stale_attempt", attempt };
      }
    }
    const recorded =
      request === undefined
        ? undefined
        : history.retryAccepted({
            requestId: request.requestId,
            inputDigest: request.inputDigest,
            roots: [id],
            resetDependants: [],
          });
    const ok = await route.lane.rerun(route.localId);
    if (request !== undefined) {
      history.retryApplied({ requestId: request.requestId, node: id, applied: ok });
    }
    return recorded === undefined ? { ok } : { ok, recorded };
  };

  const CANCELLED_BY_OPERATOR = {
    running: "cancelled",
    pending: "cancelled",
    log: "\n[odu] cancelled by operator (lane)\n",
  } as const;

  const REOPENED = {
    status: "pending",
    startedAt: null,
    durationMs: null,
    exitCode: null,
  } as const satisfies Partial<NodeState>;

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

  const terminalizePlatformNodes = (
    platform: string,
    strategy: {
      running: "cancelled" | "errored";
      pending: "cancelled" | "skipped";
      log: string;
    },
  ): void => {
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
        appendLocal(id, strategy.log);
        const startedAt = node.startedAt ?? now;
        updateNode(id, {
          status: next,
          durationMs: now - startedAt,
        });
      } else {
        updateNode(id, { status: next });
      }
      if (splitFanId(id).namepath !== SETUP) sealNodeLogs(id);
    }
  };

  const cancelPlatform = (platform: string): boolean => {
    if (executions.isCancelled(platform)) return true;
    const state = store.get();
    const hasNodes = state.order.some((id) => onPlatform(id, platform));
    if (!hasNodes) return false;
    executions.ensure(platform);
    executions.cancel(platform);
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

  let closeSocket: () => void = () => {};
  let finalizeRunRecord: (
    state: PipelineState,
    unposted?: ReadonlyArray<UnpostedEntry>,
  ) => void = () => {};
  let recordWritten = false;
  const idleMs = lingerIdleMs();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearIdle = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  let onSettledEach: (() => void) | null = null;

  let shuttingDown = false;
  let shutdown: (
    code: number,
    reason?: string,
    opts?: { exclusivityLost?: boolean },
  ) => void = () => {};

  const watchLease = (platform: string, lease: LeaseHandle): void => {
    const episode = episodeOf(platform);
    void lease.lost?.then(() => {
      const reason = `venue lease lost on ${shortHost(lease.host)}`;
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
      nodeLog: {
        source: ({ id, stream }) => logs.streamSource({ id: logStreamKey(id, stream) }),
      },
    },
    procedures: {
      node: {
        rerun: ({ input }) =>
          Effect.promise(async () =>
            rerunNode(
              input.id,
              input.requestId === undefined
                ? undefined
                : {
                    requestId: input.requestId,
                    inputDigest: input.inputDigest ?? "",
                  },
              input.expectAttempt,
            ),
          ),
        cancel: ({ input }) =>
          Effect.promise(async () => ({ ok: await cancelNode(input.id) })),
      },
      run: {
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
  const served = { group: runtime.group, handlers: runtime.handlers };

  const poster = new StatusPoster({
    owner: github?.owner ?? "",
    repo: github?.repo ?? "",
    sha,
    enabled: ctx.posting,
    forge: ctx.forge,
    onLine: info,
    onHealth: (health) => {
      const cur = store.get();
      if (postingEqual(cur.posting, health)) return;
      runtime.ctx.cells.nodes.set({ ...cur, posting: health });
      display.update(store.get());
    },
  });

  /** `UnixSocketListener.close()` disconnects every established peer
   *  unconditionally and DROPS their unflushed outbound frames — the framework
   *  says so in as many words, as a deliberate fail-fast ("a host that closed
   *  is closed").
   *
   *  kolu's STREAM_AHEAD buffer puts a pump fiber between a publish and the
   *  write, and Effect schedules that fiber on `setImmediate` — the same queue
   *  this flush uses. One hop races the pump; three lets the pump run, the RPC
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

  function writeTimingSidecar(state: PipelineState): void {
    try {
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
    }
  }

  shutdown = (
    code: number,
    reason = "interrupted",
    opts: { exclusivityLost?: boolean } = {},
  ): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearIdle();
    verdicts.releaseAll();
    const exclusivityLost = opts.exclusivityLost === true;
    const stopWork = (): void => {
      for (const lane of createdLanes) lane.close();
      flushSetupLines();
      stampUnfinishedLogs();
      endRunLogs();
      for (const lease of acquiredLeases) lease.release();
      acquiredLeases.length = 0;
    };
    applyInterruptStopWork("before-settle", exclusivityLost, stopWork);
    const interruptedState = store.get();
    info(`odu: ${reason} — finalizing posted statuses before exit`);
    for (const context of poster.pendingContexts()) {
      poster.post(interruptStatus(context, reason, sha7));
    }
    void poster.finalize().then(async (unposted) => {
      applyInterruptStopWork("after-settle", exclusivityLost, stopWork);
      writeTimingSidecar(interruptedState);
      finalizeRunRecord(interruptedState, unposted);
      await flushToReaders();
      closeSocket();
      history.close();
      display.stop(interruptedState);
      process.exit(code);
    });
  };

  const emitProgress = (id: string, node: NodeState): void => {
    const event = progressEvent(sha7, id, node);
    if (event === null) return;
    display.transition(event, node);
  };

  let settled: () => void = () => {};
  const allSettled = new Promise<void>((resolve) => {
    settled = resolve;
  });
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

  const verdicts = createVerdictGate({
    isLogEnded: logs.isEnded,
    publishedStatus: (id) => store.get().nodes[id]?.status,
    nodeIds: () => store.get().order,
    publish: (id, patch) => updateNode(id, patch),
    drainLogs: () => drainLaneLogs(executions.lanes()),
  });

  const checkSettled = (): void => {
    if (claimInFlight()) return;
    if (shuttingDown) return;
    const state = store.get();
    const done = state.order.every(
      (id) => !NON_TERMINAL_STATUSES.has(state.nodes[id]?.status ?? "pending"),
    );
    if (done) {
      settled();
      onSettledEach?.();
      return;
    }
    verdicts.boundIfOnlyLogsOutstanding();
  };

  const updateNode = (
    id: string,
    patch: Partial<NodeState>,
    drop: readonly (keyof NodeState)[] = [],
  ): void => {
    const cur = store.get();
    const prev = cur.nodes[id];
    if (prev === undefined) return;
    const next = { ...prev, ...patch };
    for (const key of drop) delete next[key];
    const keys = Object.keys(patch) as (keyof NodeState)[];
    if (
      keys.every((k) => next[k] === prev[k]) &&
      drop.every((k) => prev[k] === undefined)
    ) {
      return;
    }
    runtime.ctx.cells.nodes.set({
      ...cur,
      nodes: { ...cur.nodes, [id]: next },
    });
    display.update(store.get());
    if (next.status !== prev.status) {
      if (next.status === "running") clearIdle();
      if (
        recordWritten &&
        !NON_TERMINAL_STATUSES.has(prev.status) &&
        NON_TERMINAL_STATUSES.has(next.status)
      ) {
        finalizeRunRecord(store.get(), poster.unposted());
      }
      emitProgress(id, next);
      history.nodeStatus(id, next.status, {
        exitCode: next.exitCode,
        durationMs: next.durationMs,
        host: nodeHosts.get(id) ?? null,
      });
      const payload = postableNodeIds.has(id)
        ? statusFor(id, next.status, next.durationMs, sha7)
        : null;
      if (payload !== null) poster.post(payload);
      checkSettled();
    }
  };

  const pushJournalled = new Map<string, string>();
  const notePush = (
    id: string,
    push: NodePush | undefined,
    recipeDurationMs: number | null,
  ): void => {
    if (push === undefined) {
      updateNode(id, {}, ["push"]);
      pushJournalled.delete(id);
      return;
    }
    updateNode(id, { push });
    if (pushing === null) return;
    const stamp = JSON.stringify(push);
    if (pushJournalled.get(id) === stamp) return;
    pushJournalled.set(id, stamp);
    if (push.state === "pushing") {
      history.pushing({
        node: id,
        bucket: pushing.bucket,
        durationMs: recipeDurationMs ?? undefined,
      });
      return;
    }
    if (push.state === "pushed") {
      history.pushed({
        node: id,
        bucket: pushing.bucket,
        paths: push.stored + push.present,
        present: push.present,
        bytes: push.bytes,
        durationMs: push.durationMs,
      });
      return;
    }
    history.pushFailed({
      node: id,
      bucket: pushing.bucket,
      message: push.message,
      durationMs: push.durationMs,
    });
  };

  const installShardNodes = (platform: string, plan: ShardPlan): void => {
    runtime.ctx.cells.nodes.set(installShardTopology(store.get(), platform, plan));
    display.update(store.get());
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
    sealNodeLogs(logicalId);
    updateNode(logicalId, {
      status,
      exitCode: status === "ok" ? 0 : 1,
      startedAt,
      durationMs,
    });
  };

  const startSetup = (platform: string): void => {
    const id = fanId(SETUP, platform);
    if (store.get().nodes[id]?.status !== "pending") return;
    updateNode(id, { status: "running", startedAt: Date.now() });
    if (args.checkoutMoved !== undefined) {
      appendLocal(id, `[odu] ${args.checkoutMoved}\n`);
    }
    if (pushing !== null) {
      appendLocal(
        id,
        `[odu] pushing results to ${pushing.substituter} (bucket ${pushing.bucket})\n`,
      );
      if (args.pushKeyWarning !== undefined) {
        appendLocal(id, `[odu] ${args.pushKeyWarning}\n`);
      }
      for (const task of tasksByPlatform.get(platform) ?? []) {
        const pin = pinDecisionFor(task, platform);
        if (pin.kind === "skipped") {
          appendLocal(id, `[odu] not pinning: ${pin.why}\n`);
        }
      }
    } else {
      const why =
        args.push !== undefined
          ? "the run's write token was not handed over"
          : (args.pushSkipped ?? "this run was launched with no cache target");
      appendLocal(id, `[odu] not pushing: ${why}\n`);
    }
  };

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

  const setupLine = (msg: string, platform: string): void => {
    info(msg);
    const lines = pendingSetupLines.get(platform) ?? [];
    lines.push(`${msg}\n`);
    pendingSetupLines.set(platform, lines);
    setupFlush ??= setImmediate(flushSetupLines);
  };

  const finishSetup = (
    platform: string,
    status: NodeState["status"],
    exitCode: number | null,
  ): void => {
    const id = fanId(SETUP, platform);
    const node = store.get().nodes[id];
    if (node === undefined) return;
    if (node.status !== "pending" && node.status !== "running") return;
    const startedAt = node.startedAt ?? Date.now();
    updateNode(id, {
      status,
      exitCode,
      startedAt,
      durationMs: Date.now() - startedAt,
    });
  };

  mkdirSync(join(repoRoot, ".ci"), { recursive: true });

  const commitUrl = runtime.ctx.cells.header.get().commitUrl;
  const platformsToClaim = claimingLanes(runtime.ctx.cells.header.get()).map(
    (l) => l.platform,
  );
  const claimablePlatforms = new Set(platformsToClaim);

  const publishHeader = (next: RunHeader): void => {
    runtime.ctx.cells.header.set(next);
    display.setHeader(next);
  };

  const publishRoster = (beforeClaim: boolean): void => {
    const lanes = rosterFrom(
      activePlatforms.filter((platform) => !executions.isCancelled(platform)),
      beforeClaim,
    );
    publishHeader({ ...runtime.ctx.cells.header.get(), lanes });
    const hostsSource = runtime.ctx.cells.header.get().hostsSource;
    for (const lane of lanes) {
      history.lane(
        lane.platform,
        lane.state,
        lane.state === "leased" ? lane.host : null,
        lane.state === "claiming" ? lane.pool : [],
        hostsSource,
      );
    }
    const phase = runPhase({ ...runtime.ctx.cells.header.get(), lanes });
    if (phase !== "unstarted") history.phase(phase);
  };
  // `PipelineState.seq` is `Schema.optionalKey`, which rejects a
  // present-but-undefined key on ENCODE as well as decode, so the key is
  // spread in rather than spelled `seq: undefined`.
  runtime.ctx.cells.nodes.set({
    ...store.get(),
    ...(seq === null ? {} : { seq }),
  });
  history.roster(store.get().order);
  finalizeRunRecord = (state, unposted): void => {
    const owed = unposted ?? poster.unposted();
    const startedAt = runtime.ctx.cells.header.get().startedAt;
    const finishedAt = Date.now();
    const nodes = projectNodes(state);
    const withStatus = (want: NodeStatus): string[] =>
      nodes.filter((n) => n.status === want).map((n) => n.id);
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
          lanes: leasedLanes(runtime.ctx.cells.header.get()),
          state,
          unposted: owed,
        }),
      );
      recordWritten = true;
    } catch {
    }
  };

  closeSocket = await serveSocket(served, socketPath, socketLogger(info));
  if (reservation.current.status === "reserved") {
    reservation.current = { ...reservation.current, published: true };
  }

  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(130));

  display.setHeader(runtime.ctx.cells.header.get());
  display.start(store.get());
  display.update(store.get());

  const parkForShutdown = (): Promise<never> => new Promise<never>(() => {});

  const primaryLanes = new Map<string, Lane>();
  const retireLane = (platform: string, lane: Lane): void => {
    lane.close();
    executions.dropLane(platform, lane);
    primaryLanes.delete(platform);
    createdLanes.delete(lane);
  };
  const buildLane = deps.startLane ?? startLane;
  const claimOne = deps.claimVenues ?? claimVenues;

  const laneEpisode = new Map<string, number>();
  const episodeOf = (platform: string): number => laneEpisode.get(platform) ?? 0;
  const maxResurrections = maxLaneResurrections();
  const remotePlatforms = new Set<string>();

  const isResurrectable = (platform: string): boolean =>
    claimablePlatforms.has(platform) &&
    remotePlatforms.has(platform) &&
    shardRootsFor(platform).length === 0;

  const unfinishedTasksFor = (
    platform: string,
    state: PipelineState,
  ): TaskSpec[] => {
    const all = tasksByPlatform.get(platform) ?? [];
    const statusOf = (localId: string): NodeStatus | undefined =>
      state.nodes[fanId(localId, platform)]?.status;
    const unfinished = (task: TaskSpec): boolean => {
      const status = statusOf(task.id);
      return status !== undefined && NON_TERMINAL_STATUSES.has(status);
    };
    const retry = new Map(
      all.filter(unfinished).map((task) => [task.id, task] as const),
    );
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

  const laneDied = (platform: string, episode: number, reason: string): void => {
    if (!laneAccepting(platform)) return;
    if (episode !== episodeOf(platform)) return;
    const spent = episode;
    if (spent < maxResurrections && isResurrectable(platform)) {
      beginClaim(platform);
      try {
        verdicts.releaseAll((id) => onPlatform(id, platform));
        const state = store.get();
        const unfinished = unfinishedTasksFor(platform, state);
        if (unfinished.length > 0) {
          resurrectLane(platform, episode, reason, unfinished, state);
          return;
        }
      } finally {
        endClaim(platform);
      }
    }
    const exhausted =
      spent >= maxResurrections
        ? ` (gave up after ${maxResurrections} lane resurrections)`
        : "";
    const strategy = laneDeath(`lane died: ${reason}${exhausted}`);
    if (exhausted !== "") {
      setupLine(`[odu] lane died: ${reason}${exhausted}`, platform);
    }
    executions.cancel(platform);
    if (claimInFlight(platform)) deferredPlatformStops.set(platform, strategy);
    else terminalizePlatformNodes(platform, strategy);
    checkSettled();
  };

  const resurrectLane = (
    platform: string,
    episode: number,
    reason: string,
    retryTasks: TaskSpec[],
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
    executions.releaseLeases(platform);

    updateNode(fanId(SETUP, platform), REOPENED);
    startSetup(platform);

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
        resolveDrvPath: laneRunnerDrvPath,
      });
      endClaim(platform);
      publishRoster(false);
      if (shuttingDown) {
        if (outcome.ok) for (const lease of outcome.leases) lease.release();
        return;
      }
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
        executions.cancel(platform);
        terminalizePlatformNodes(
          platform,
          laneDeath(`lane died: ${reason}\n[odu] ${outcome.error.message}`),
        );
        checkSettled();
        return;
      }
      for (const id of retryIds) {
        updateNode(id, REOPENED);
        history.resetNode(
          id,
          "the lane running this node died; it was re-run on another venue",
        );
        const nextHost = outcome.lanes[platform];
        if (nextHost === undefined) nodeHosts.delete(id);
        else nodeHosts.set(id, nextHost);
        resetLocal(id, "");
      }
      acceptClaim(platform, outcome, retryTasks);
      checkSettled();
    })();
  };

  const laneSource = (host: string) => {
    const local = isLocalHost(host) && process.env.ODU_SNAPSHOT_TRANSPORT !== "always";
    return {
      origin: local || originUrl === null ? null : fetchUrlFor(originUrl),
      sha: local && ctx.snapshot === null ? null : sha,
      workspace: local ? specSource : null,
      snapshot: ctx.snapshot === null ? null : {
        commit: ctx.snapshot.contentSha, requires: ctx.snapshot.requires,
        bundlePath: ctx.snapshot.bundle?.path ?? null, bytes: ctx.snapshot.bundle?.bytes ?? 0,
      },
    };
  };

  const startPrimaryLane = (
    platform: string,
    host: string,
    tasks: TaskSpec[],
  ): Lane => {
    executions.ensure(platform);
    nodeHosts.set(fanId(SETUP, platform), host);
    startSetup(platform);
    const setupId = fanId(SETUP, platform);
    const publicMainId = (laneId: string): string => {
      const plan = planFor(platform, laneId);
      return plan !== undefined && plan.total > 1
        ? fanId(shardNamepath(laneId, 0, plan.total), platform)
        : fanId(laneId, platform);
    };
    for (const task of tasks) {
      nodeHosts.set(fanId(task.id, platform), host);
      nodeHosts.set(publicMainId(task.id), host);
    }
    const local = isLocalHost(host);
    if (!local) remotePlatforms.add(platform);
    const episode = episodeOf(platform);
    const lane = buildLane({
      platform,
      host,
      tasks,
      pipelineName: spec.name,
      ...laneSource(host),
      resolveDrvPath: laneRunnerDrvPath,
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
          notePush(id, laneNode.push, laneNode.durationMs);
          const plan = planFor(platform, laneId);
          if (plan !== undefined) {
            refreshShardAggregate(platform, plan);
          }
        }
      },
      onLogFrame: (laneId, frame, stream) => {
        const id = publicMainId(laneId);
        if (frame.kind === "append") {
          appendLocal(id, frame.text, stream);
        } else if (frame.kind === "end") {
          if (stream === "push") {
            endLocal(id, "push");
          } else if (laneId !== SETUP) {
            endLocal(id);
            verdicts.release(id);
            const plan = planFor(platform, laneId);
            if (plan !== undefined) {
              refreshShardAggregate(platform, plan);
            }
          }
        } else if (laneId === SETUP) {
          if (frame.text !== "") appendLocal(id, frame.text, stream);
        } else if (!logs.isNoopReset(id, frame.text, stream)) {
          resetLocal(id, frame.text, stream);
        }
      },
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

  const acceptClaim = (
    platform: string,
    claimed: Extract<ClaimOutcome, { ok: true }>,
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

  const seeded =
    ctx.posting && github !== null ? poster.seed() : Promise.resolve();
  for (const id of store.get().order) logs.claim(id);
  for (const platform of platformsToClaim) beginClaim(platform);
  const claimEpisode = new Map(
    platformsToClaim.map((platform) => [platform, episodeOf(platform)] as const),
  );
  const venueSuperseded = (platform: string): boolean =>
    episodeOf(platform) !== (claimEpisode.get(platform) ?? 0);
  const claims = claimPlatformsIndependently(
    platformsToClaim,
    async (platform) => {
      const pending = claimOne({
        repoRoot,
        pools: resolvedPools,
        platforms: [platform],
        validatePlatforms: platformsToClaim,
        identity: { holder: localHolderId(), run: runLabel },
        noWait: args.noWait,
        runLabel,
        onLine: setupLine,
        resolveDrvPath: laneRunnerDrvPath,
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
  if (shuttingDown) {
    return await parkForShutdown();
  }

  for (const platform of platformsToClaim) startSetup(platform);

  for (const platform of activePlatforms) {
    if (platformsToClaim.includes(platform)) continue;
    const host = lanesByPlatform[platform];
    if (host === undefined || executions.isCancelled(platform)) continue;
    const earlyTasks = earlyTasksFor(platform);
    if (earlyTasks.length > 0) startPrimaryLane(platform, host, earlyTasks);
  }

  const claimResults = await claims;
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
    publishRoster(false);

    for (const request of burstRequests) beginClaim(request.platform);
    const preparing = prepareVenues({
        claimed: claimedOutcome,
        existingLanes: lanesByPlatform,
        platforms: activePlatforms,
        bursts: burstRequests,
        pools: resolvedPools,
        identity: { holder: localHolderId(), run: runLabel },
        onLine: setupLine,
        resolveDrvPath: laneRunnerDrvPath,
        ...(deps.leaseBurstSlots === undefined
          ? {}
          : { leaseBurst: deps.leaseBurstSlots }),
      });

    outcome = await preparing;
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
  if (shuttingDown) return await parkForShutdown();

  for (const id of store.get().order) logs.claim(id);

  const cancelledDuringClaim = (platform: string): boolean =>
    executions.isCancelled(platform);
  for (const platform of activePlatforms) {
    if (!cancelledDuringClaim(platform)) continue;
    terminalizePlatformNodes(
      platform,
      deferredPlatformStops.get(platform) ?? CANCELLED_BY_OPERATOR,
    );
    delete lanesByPlatform[platform];
  }
  const survivors = activePlatforms.filter(
    (platform) => !cancelledDuringClaim(platform),
  );

  publishRoster(false);

  if (!outcome.ok) {
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

  checkSettled();

  for (const platform of outcome.ok ? survivors : []) {
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
      for (const root of roots) {
        nodeHosts.set(fanId(root.id, platform), host);
        nodeHosts.set(publicMainId(root.id), host);
      }
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
        for (const id of publicLaneIds) nodeHosts.set(id, lease.host);
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
        burstLane = buildLane({
          platform,
          host: lease.host,
          tasks: tasksForShard(plan.tasks, plan.rootId, index, plan.total),
          pipelineName: `${spec.name}:${plan.rootId}:${index + 1}/${plan.total}`,
          ...laneSource(lease.host),
          resolveDrvPath: laneRunnerDrvPath,
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
              if (laneId === SETUP) updateNode(publicId, patch);
              else verdicts.offer(publicId, patch);
              notePush(publicId, laneNode.push, laneNode.durationMs);
              if (laneId === plan.rootId) {
                refreshShardAggregate(platform, plan);
              }
            }
          },
          onLogFrame: (laneId, frame, stream) => {
            if (!laneAccepting(platform)) return;
            const publicId = publicIdFor(laneId);
            if (frame.kind === "append") appendLocal(publicId, frame.text, stream);
            else if (frame.kind === "snapshot") {
              if (laneId === SETUP) {
                if (frame.text !== "") appendLocal(publicId, frame.text, stream);
              } else if (!logs.isNoopReset(publicId, frame.text, stream)) {
                resetLocal(publicId, frame.text, stream);
              }
            } else if (frame.kind === "end") {
              if (stream === "push") {
                endLocal(publicId, "push");
                return;
              }
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
              const unfinished = status === "pending" || status === "running";
              if (unfinished) {
                appendLocal(id, `\n[odu] shard lane died: ${error}\n`);
              }
              sealNodeLogs(id);
              if (unfinished) {
                verdicts.release(id);
                updateNode(id, {
                  status: status === "running" ? "errored" : "skipped",
                  exitCode: 1,
                });
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

  const verdictCode = (state: PipelineState): number => exitCode(state);

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
    onSettledEach = (): void => {
      writeTimingSidecar(store.get());
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
    checkSettled();
    return await parkForShutdown();
  }

  await allSettled;
  if (shuttingDown) return await parkForShutdown();

  for (const lane of createdLanes) lane.close();
  flushSetupLines();
  endRunLogs();
  for (const lease of acquiredLeases) lease.release();
  acquiredLeases.length = 0;
  const finalState = store.get();
  writeTimingSidecar(finalState);
  const unposted = await poster.finalize();
  finalizeRunRecord(finalState, unposted);
  await flushToReaders();
  closeSocket();
  history.close();

  display.stop(finalState);
  if (!outcome.ok) {
    process.stderr.write(`${outcome.error.message}\n`);
  }
  return reportVerdict(finalState, unposted);
}

function lingerIdleMs(): number {
  const raw = process.env.ODU_LINGER_IDLE_MS;
  if (raw === undefined || raw === "") return 30 * 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30 * 60 * 1000;
}
