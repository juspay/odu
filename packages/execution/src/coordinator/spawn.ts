/**
 *   - Under a systemd unit (an agent harness running odu as a service), a
 *     `detached` child is still inside the unit's cgroup, and `systemctl
 *     restart` kills a cgroup whatever any flag says. `detached` buys the
 *     launcher's plain EXIT and nothing more. So when we detect a unit, the
 *     coordinator is started as a transient user service via `systemd-run
 *     --user`, which puts it in a cgroup of its own.
 *   - Everywhere else — a developer's shell, a CI container, macOS — a
 *     detached, unref'd child in its own process group IS independent: no
 *     signal addressed to the launcher's group reaches it, and its parent
 *     exiting reparents rather than reaps it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import {
  type DaemonSpawnConfig,
  type SpawnDriverDeps,
  survivableSpawnDriver,
} from "@kolu/surface-daemon-supervisor";
import { SURFACE_AGENT_FLAKE_REF_ENV } from "@kolu/surface-remote";
import { readFileSlice } from "@odu/run-history/store";
import { dirname, join } from "node:path";
import { dialRun } from "@odu/run-client/dial";
import { runDetached } from "../common/effectEdge";

/**
 * The argv prefix that re-invokes odu — the Nix wrapper's own absolute path,
 * and nothing else.
 */
export function oduSelfArgv(env: NodeJS.ProcessEnv = process.env): string[] {
  const self = env.ODU_SELF;
  if (self === undefined || self === "") {
    throw new Error(
      "odu: ODU_SELF is unset, so odu cannot re-invoke itself. The Nix wrapper " +
        "bakes it (see default.nix) and nothing sets it at runtime — this is a " +
        "misbuilt package, not a mode. Run odu from its Nix package: " +
        "`nix run github:juspay/odu -- …`, or `nix run . -- …` in a checkout.",
    );
  }
  return [self];
}

/** The spawn options that make a coordinator outlive its LAUNCHER'S plain
 *  exit: its own process group (`detached`) so no signal addressed to the
 *  launcher ever reaches it by group, and pipes for stdout/stderr so a caller
 *  can tee the child's early output. */
export function coordinatorSpawnSpec(checkout: string): {
  cwd: string;
  stdio: ["ignore", "pipe", "pipe"];
  env: NodeJS.ProcessEnv;
  detached: boolean;
} {
  return {
    cwd: checkout,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    detached: true,
  };
}

/** Which mechanism a given environment resolves to, and the sentence that
 *  says why. */
export interface SpawnPlan {
  mechanism: "systemd-run" | "detached";
  reason: string;
  /**
   * Does the spawned process EXITING mean the coordinator died?
   *
   * True for a detached spawn: the process we forked IS the coordinator.
   *
   * FALSE for `systemd-run`: `systemd-run --user` is a SUBMITTER — it asks the
   * user manager to start a transient unit and exits as soon as the manager
   * has accepted the job, normally while the service is still starting.
   */
  exitIsDeath: boolean;
  /** How the launched process's exit code should be read. For a submitter, a
   *  non-zero exit means the job was REFUSED (no manager, a bad unit name) and
   *  is a genuine failure; zero means accepted and says nothing about the
   *  service. */
  describeExit: (code: number) => string;
}

export interface SpawnEnv {
  /** systemd sets this for every process it starts as part of a unit. Its
   *  presence is the documented "I am inside a unit" marker — more reliable
   *  than parsing `/proc/self/cgroup`, which differs between cgroup v1 and v2
   *  and is absent entirely on darwin. */
  INVOCATION_ID?: string | undefined;
  /** Where the session bus is — checked for a real socket, not merely for a
   *  value, because `systemd-run --user` cannot work without a user manager on
   *  the other end of it however confidently the variable is set. */
  DBUS_SESSION_BUS_ADDRESS?: string | undefined;
  XDG_RUNTIME_DIR?: string | undefined;
  ODU_NO_SYSTEMD_RUN?: string | undefined;
  readonly [other: string]: string | undefined;
}

function isSocket(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

/** The filesystem path out of a D-Bus address, or `null` for one that names no
 *  path (an `abstract=` or `tcp:` address, neither of which a session bus
 *  normally is). */
export function busSocketPath(address: string): string | null {
  for (const part of address.split(",")) {
    const at = part.indexOf("path=");
    if (at === -1) continue;
    const path = part.slice(at + "path=".length);
    if (path !== "") return path;
  }
  return null;
}

/**
 * Is there a user systemd manager to submit a transient unit TO?
 *
 * **The name of a bus is not a bus.** `DBUS_SESSION_BUS_ADDRESS` and
 * `XDG_RUNTIME_DIR` are set by plenty of environments that have no user manager
 * at all — a GitHub Actions runner is one — and on those, `systemd-run --user`
 * fails at submission.
 */
export function userManagerReachable(
  env: SpawnEnv,
  exists: (path: string) => boolean = isSocket,
): boolean {
  const address = env.DBUS_SESSION_BUS_ADDRESS;
  if (address !== undefined && address !== "") {
    const path = busSocketPath(address);
    if (path !== null) return exists(path);
  }
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime === undefined || runtime === "") return false;
  return exists(join(runtime, "bus"));
}

/**
 * Decide how to start a coordinator.
 */
export function survivableSpawnPlan(
  env: SpawnEnv,
  platform: NodeJS.Platform,
  unitName: string,
  reachable: (env: SpawnEnv) => boolean = userManagerReachable,
): SpawnPlan {
  const detached = (reason: string): SpawnPlan => ({
    mechanism: "detached",
    reason,
    exitIsDeath: true,
    describeExit: (code) => `the coordinator exited ${code} before serving a socket`,
  });
  if (platform !== "linux") {
    return detached(
      `${platform} has no systemd; a detached process group is independent here`,
    );
  }
  if (env.ODU_NO_SYSTEMD_RUN !== undefined && env.ODU_NO_SYSTEMD_RUN !== "") {
    return detached("ODU_NO_SYSTEMD_RUN is set");
  }
  if (env.INVOCATION_ID === undefined || env.INVOCATION_ID === "") {
    return detached(
      "not running under a systemd unit; a detached process group is already independent",
    );
  }
  if (!reachable(env)) {
    return detached(
      "running under a systemd unit but no user session bus is reachable — " +
        "the coordinator will share this unit's cgroup and a restart of it will kill the run",
    );
  }
  return {
    mechanism: "systemd-run",
    reason: `running under a systemd unit; starting the coordinator as the transient user service ${unitName}`,
    exitIsDeath: false,
    describeExit: (code) =>
      code === 0
        ? "systemd-run accepted the unit but its socket never appeared"
        : `systemd-run refused to start the unit (exit ${code})`,
  };
}

export const ODU_CHILD_ENV_KEYS: readonly string[] = [
  "HOME",
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TZ",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  // Nix. `NIX_CONF_DIR` / `NIX_USER_CONF_FILES` are where `experimental-features`
  // lives on a single-user install, which is what a CI runner is; `NIX_PROFILES`
  // and `NIX_USER_PROFILE_DIR` are how such an install finds itself at all.
  "NIX_PATH",
  "NIX_REMOTE",
  "NIX_CONFIG",
  "NIX_CONF_DIR",
  "NIX_USER_CONF_FILES",
  "NIX_PROFILES",
  "NIX_USER_PROFILE_DIR",
  "NIX_STORE_DIR",
  "NIX_STATE_DIR",
  "NIX_SSL_CERT_FILE",
  "SSL_CERT_FILE",
  "LOCALE_ARCHIVE",
  "GH_TOKEN",
  "GH_HOST",
  "GH_CONFIG_DIR",
  "ODU_HOSTS",
  "ODU_STATE_DIR",
  SURFACE_AGENT_FLAKE_REF_ENV,
  "ODU_SELF",
  "ODU_GH_BIN",
  "ODU_LINGER_IDLE_MS",
  "ODU_SNAPSHOT_MAX_BYTES",
  "ODU_SNAPSHOT_TRANSPORT",
  "ODU_NO_SYSTEMD_RUN",
];

/** Pick the named variables out of an environment. An empty value is UNSET,
 *  not an empty assignment: forwarding `ODU_HOSTS=` into a unit is not the same
 *  as leaving it absent. */
export function pickEnv(
  env: Record<string, string | undefined>,
  keys: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = env[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

export function forwardedEnv(env: SpawnEnv): Record<string, string> {
  return pickEnv(env, ODU_CHILD_ENV_KEYS);
}

export async function pollUntilSocketOrExit(
  ready: () => Promise<boolean>,
  exited: Promise<unknown>,
  intervalMs = 250,
): Promise<boolean> {
  let done = false;
  void exited.then(() => {
    done = true;
  });
  for (;;) {
    if (await ready()) return true;
    if (done) {
      return ready();
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function socketAnswers(socketPath: string): Promise<boolean> {
  const dialed = await dialRun(socketPath);
  await dialed?.close();
  return dialed !== null;
}

export async function defaultWaitForSocket(
  socketPath: string,
  exited: Promise<unknown>,
): Promise<boolean> {
  return pollUntilSocketOrExit(() => socketAnswers(socketPath), exited);
}

export const READINESS_CEILING_MS = 120_000;

/**
 * Wait until `ready` says so, given what this plan's process exit actually
 * means.
 */
export async function waitForReadiness(
  plan: SpawnPlan,
  ready: () => Promise<boolean>,
  onExit: Promise<number>,
  ceilingMs: number = READINESS_CEILING_MS,
): Promise<boolean> {
  if (plan.exitIsDeath) return pollUntilSocketOrExit(ready, onExit);
  const refused = onExit.then((code) => code !== 0);
  const deadline = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ceilingMs);
    timer.unref?.();
  });
  const give = Promise.race([
    refused.then((no) => (no ? undefined : new Promise<void>(() => {}))),
    deadline,
  ]);
  return pollUntilSocketOrExit(ready, give);
}

/**
 * The four values odu supplies to kolu's mechanism — `{binPath, args, env,
 * unitPrefix}` — plus the launch-mode gate.
 */
export function coordinatorSpawnConfig(
  oduArgv: readonly string[],
  env: SpawnEnv,
  plan: SpawnPlan,
  unitName: string,
): DaemonSpawnConfig {
  const [binPath, ...args] = oduArgv;
  if (binPath === undefined) throw new Error("odu: empty coordinator argv");
  return {
    binPath,
    args,
    // On the systemd branch this is the `--setenv` overlay, which is what it
    // must be: a transient unit starts from the user manager's environment, so
    // everything telling odu where to look — the hosts file, the state root,
    // the lane runner's flake — is absent unless it is named. The detached
    // branch never reads it (`inheritParentEnv` carries the real environment).
    env: forwardedEnv(env),
    unitPrefix: unitName,
    ...(plan.mechanism === "detached"
      ? { fromSource: { inheritParentEnv: true } as const }
      : {}),
  };
}

function oduSpawn(
  checkout: string,
  logFd: number,
  plan: SpawnPlan,
  keep: (child: ChildProcess) => void,
): NonNullable<SpawnDriverDeps["spawnProcess"]> {
  return (command, args, options) => {
    const amended =
      plan.mechanism === "systemd-run" ? withSameDir(command, args) : args;
    const child = spawn(command, amended, {
      ...options,
      cwd: checkout,
      stdio: ["ignore", logFd, logFd],
    });
    keep(child);
    return child;
  };
}

/** Insert `--same-dir` into a `systemd-run` argv the driver assembled, right
 *  after the `--user` it always leads with. */
export function withSameDir(command: string, args: readonly string[]): string[] {
  if (command !== "systemd-run" || args[0] !== "--user") {
    throw new Error(
      `odu: kolu's systemd branch changed shape (${command} ${args[0]}) — ` +
        "the coordinator's working directory is no longer being set",
    );
  }
  return ["--user", "--same-dir", ...args.slice(1)];
}

/** Spawned coordinators, kept referenced so V8 does not collect the handle
 *  mid-run (unref'd handles still fire their `exit` in this process). */
const liveRuns = new Set<ChildProcess>();

export interface SpawnedCoordinator {
  child: ChildProcess;
  plan: SpawnPlan;
  onExit: Promise<number>;
  /** A bounded tail of the coordinator's own log, for reporting a startup
   *  failure. */
  stderrTail: () => string;
}

/**
 * Start a coordinator with the strongest independence this environment offers,
 * writing its own narration to `logPath`. The caller owns waiting for its
 * socket.
 */
export function spawnCoordinator(
  oduArgv: readonly string[],
  checkout: string,
  unitName: string,
  logPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SpawnedCoordinator {
  const plan = survivableSpawnPlan(env, platform, unitName);
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a");
  let child: ChildProcess | undefined;
  try {
    runDetached(
      survivableSpawnDriver(coordinatorSpawnConfig(oduArgv, env, plan, unitName), {
        env,
        spawnProcess: oduSpawn(checkout, fd, plan, (spawned) => {
          child = spawned;
        }),
      }).spawn,
    );
  } finally {
    // The child holds its own duplicate; keeping ours open would pin the file
    // in this process for as long as the launcher lives.
    closeSync(fd);
  }
  const spawned: ChildProcess | undefined = child;
  if (spawned === undefined) {
    throw new Error("odu: coordinator spawn produced no child");
  }
  liveRuns.add(spawned);
  const onExit = new Promise<number>((resolve) => {
    spawned.on("exit", (code) => {
      liveRuns.delete(spawned);
      resolve(code ?? -1);
    });
    spawned.on("error", () => {
      liveRuns.delete(spawned);
      resolve(-1);
    });
  });
  return { child: spawned, plan, onExit, stderrTail: () => tailOf(logPath) };
}

/**
 * The last 64 KiB of the coordinator's log — what a launcher quotes when the
 * socket never came up.
 */
function tailOf(path: string): string {
  return readFileSlice(path, { offset: -64 * 1024 })?.text ?? "";
}
