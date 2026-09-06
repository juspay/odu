/**
 * How a coordinator is STARTED, and what it survives.
 *
 * One module because there are now two callers — the MCP `run` tool and the
 * native launcher a finalized retry goes through — and the thing they share is
 * not "spawning a process", it is a claim about ownership that has to be true
 * for both.
 *
 * THE CLAIM. A coordinator owns a run: its venue leases, its checkout lock, its
 * durable record. So the process must belong to the RUN, not to whatever
 * started it. Two mechanisms, and which applies is a property of where the
 * launcher itself is running:
 *
 *   - Under a systemd unit (an agent harness running odu as a service), a
 *     `detached` child is still inside the unit's cgroup, and `systemctl
 *     restart` kills a cgroup whatever any flag says. `detached` buys the
 *     launcher's plain EXIT and nothing more. So when we detect a unit, the
 *     coordinator is started as a transient user service via `systemd-run
 *     --user`, which puts it in a cgroup of its own — genuinely independent of
 *     the one that asked for it.
 *   - Everywhere else — a developer's shell, a CI container, macOS — a
 *     detached, unref'd child in its own process group IS independent: no
 *     signal addressed to the launcher's group reaches it, and its parent
 *     exiting reparents rather than reaps it.
 *
 * WHAT CHANGED, AND THE RULING IT REVISITS. `packages/cli/src/mcp/runTool.ts` records a
 * decision (2026-09-02) that odu would NOT escape the host's cgroup — the
 * limit was admitted and the corpse reported instead. That decision is why
 * `deadRun` exists and why every face names a death rather than answering as
 * if the run never happened, and none of that is undone here: a coordinator
 * can still die, and the reporting is still the honest answer when it does.
 * What changes is that the native launcher no longer has to accept the death
 * as inevitable where the platform offers a way out. The MCP `run` tool keeps
 * its documented behaviour; this escape is offered to the launcher and is
 * opt-outable, so the two are not silently merged.
 *
 * WHY THIS IS NOT `@kolu/surface-daemon-supervisor`. Kolu ships this exact
 * mechanism — `survivableSpawnDriver` in that package's `driver.ts`, whose own
 * header names "the odu CLI / odu-web next" as its second tenant. Every
 * decision below is taken FROM it rather than re-derived: the `INVOCATION_ID`
 * gate between the two branches, per-spawn unique `--unit` names because a
 * dead unit lingers loaded and refuses a reused one, `--collect` to GC it, an
 * absolute binary path because a transient unit's PATH is minimal, `--setenv`
 * per forwarded var because a transient unit starts from systemd's
 * environment rather than ours, a file for a detaching child's stderr because
 * nobody holds it, and — the one that cost the most to learn here — the split
 * between a launch being ACCEPTED and a service being READY.
 *
 * It is not IMPORTED for two reasons, and only the first is temporary:
 *
 *   - Hydration is per-package, and that package's manifest declares
 *     `osfacts-client: workspace:*`, which is absent from odu's pinned kolu
 *     revision (f3ba639). The directory cannot be satisfied as-is. `driver.ts`
 *     alone imports nothing but `node:*` and `effect`, but it is not on the
 *     export map, so there is no supported way to take only it.
 *   - The `.` entry is a daemon-ENDPOINT state machine — a rendezvous socket a
 *     per-host daemon is expected to be holding, with squatter recovery, gate
 *     identity, and contract-skew handling for the case where somebody else
 *     already listens there. An odu coordinator is not that. It is per-RUN, its
 *     socket is absent for most of any checkout's life (`@odu/run-client`'s
 *     README states that as the design), and a second process on the same
 *     socket is prevented by the ownership fence in `@odu/run-history`, not by
 *     probing who holds it. Adopting the endpoint would mean answering
 *     questions this lifecycle does not ask.
 *
 * The first reason dissolves when the pin carries `osfacts-client`; the second
 * dissolves for `odu web`/`odu serve`, which IS a long-lived daemon behind a
 * rendezvous socket and is the tenant kolu's header actually names. So PR 2
 * inherits a decision, not a fork: when it stands that daemon up, it should
 * hydrate the supervisor and drive it, and this module's systemd branch should
 * become a call into `survivableSpawnDriver` rather than a second copy of its
 * argv. What is here is deliberately the smaller thing — one plan function and
 * one spawn — so that replacement is a deletion.
 *
 * HONEST ABOUT WHAT IS MEASURED. The detached branch is exercised by
 * `packages/cli/src/mcp/spawnSurvival.test.ts` against the real runtime and the real spawn
 * options. The systemd branch is NOT covered by odu's suite: it needs a user
 * manager and a session bus, which the Nix build sandbox and the CI container
 * do not have. {@link survivableSpawnPlan} is pure and IS tested — what a
 * given environment resolves to, and why — so the decision is pinned even
 * where the syscall cannot be.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { readFileSlice } from "@odu/run-history/store";
import { dirname } from "node:path";
import { dialRun } from "@odu/run-client/dial";

/** The argv prefix that re-invokes the odu CLI. The nix wrapper bakes
 *  `ODU_SELF` to its own store path; in a dev checkout we re-exec the entry
 *  through the very bun that is running us (`process.execPath`), so the child
 *  gets this exact runtime rather than whatever a bare `bun` on its PATH
 *  resolves to. */
export function oduSelfArgv(env: NodeJS.ProcessEnv = process.env): string[] {
  const self = env.ODU_SELF;
  if (self !== undefined && self !== "") return [self];
  const entry = process.argv[1];
  return entry !== undefined ? [process.execPath, entry] : [process.execPath];
}

/** The spawn options that make a coordinator outlive its LAUNCHER'S plain
 *  exit: its own process group (`detached`) so no signal addressed to the
 *  launcher ever reaches it by group, and pipes for stdout/stderr so a caller
 *  can tee the child's early output. The caller `unref()`s the handle so the
 *  launcher can exit without waiting.
 *
 *  PIPES ARE ONLY SAFE WHILE SOMEBODY IS READING THEM — see
 *  {@link spawnCoordinator}, which does not use this shape for exactly that
 *  reason. This variant is for a launcher that OUTLIVES the run it started
 *  (the MCP server, which tees the child's output for the life of the
 *  session). */
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
 *  says why. The `reason` is not decoration: it is what a launcher reports so
 *  an operator can tell "your run is in its own cgroup" from "your run dies
 *  with this shell", which are different promises. */
export interface SpawnPlan {
  mechanism: "systemd-run" | "detached";
  reason: string;
  /** The argv to actually execute, given the odu argv. */
  argv: (oduArgv: readonly string[]) => string[];
  /**
   * Does the spawned process EXITING mean the coordinator died?
   *
   * True for a detached spawn: the process we forked IS the coordinator, so
   * its exit is its death and a readiness wait should stop at once rather than
   * poll a socket that will never appear.
   *
   * FALSE for `systemd-run`, and getting this wrong is a false refusal on the
   * happy path. `systemd-run --user` is a SUBMITTER: it asks the user manager
   * to start a transient unit and exits as soon as the manager has accepted
   * the job — normally while the service is still starting. Treating that exit
   * as the coordinator's would abandon a run that is coming up perfectly well,
   * report a failure to the caller, and leave the run executing anyway with
   * nobody watching it. So launch ACCEPTANCE and service READINESS are two
   * facts here, and only the first is what this process's exit reports.
   */
  exitIsDeath: boolean;
  /** How the launched process's exit code should be read. For a submitter, a
   *  non-zero exit means the job was REFUSED (no manager, a bad unit name) and
   *  is a genuine failure; zero means accepted and says nothing about the
   *  service. */
  describeExit: (code: number) => string;
}

/** The environment facts the plan turns on, named so a test states a world
 *  rather than mutating the process's. */
export interface SpawnEnv {
  /** systemd sets this for every process it starts as part of a unit. Its
   *  presence is the documented "I am inside a unit" marker — more reliable
   *  than parsing `/proc/self/cgroup`, which differs between cgroup v1 and v2
   *  and is absent entirely on darwin. */
  INVOCATION_ID?: string | undefined;
  /** Without a session bus there is no user manager to ask, so `systemd-run
   *  --user` cannot work even inside a unit. */
  DBUS_SESSION_BUS_ADDRESS?: string | undefined;
  XDG_RUNTIME_DIR?: string | undefined;
  /** The explicit opt-out. A caller that has its own supervision, or that has
   *  measured `systemd-run` misbehaving on its host, sets this and gets the
   *  detached spawn with the reason recorded. */
  ODU_NO_SYSTEMD_RUN?: string | undefined;
  /** The index signature is what makes `process.env` assignable here; the
   *  named fields above are the ones the decision actually reads. */
  readonly [other: string]: string | undefined;
}

/**
 * Decide how to start a coordinator. Pure — every input is an argument — so
 * the decision is testable on a machine that has none of these mechanisms.
 *
 * `unitName` scopes the transient service to the run, so two coordinators
 * never collide on a unit name and `systemctl --user status` names the run an
 * operator is asking about.
 */
export function survivableSpawnPlan(
  env: SpawnEnv,
  platform: NodeJS.Platform,
  unitName: string,
): SpawnPlan {
  const detached = (reason: string): SpawnPlan => ({
    mechanism: "detached",
    reason,
    argv: (oduArgv) => [...oduArgv],
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
    // Not inside a unit, so there is no cgroup to escape: a detached child of
    // a shell is already nobody's dependant. Reaching for systemd-run here
    // would add a failure mode and buy nothing.
    return detached(
      "not running under a systemd unit; a detached process group is already independent",
    );
  }
  const hasBus =
    (env.DBUS_SESSION_BUS_ADDRESS !== undefined &&
      env.DBUS_SESSION_BUS_ADDRESS !== "") ||
    (env.XDG_RUNTIME_DIR !== undefined && env.XDG_RUNTIME_DIR !== "");
  if (!hasBus) {
    // Inside a unit but with no user manager to ask. Said out loud, because
    // this is the case where the coordinator genuinely WILL die with its host
    // and an operator is entitled to know before the run does.
    return detached(
      "running under a systemd unit but no user session bus is reachable — " +
        "the coordinator will share this unit's cgroup and a restart of it will kill the run",
    );
  }
  return {
    mechanism: "systemd-run",
    reason: `running under a systemd unit; starting the coordinator as the transient user service ${unitName}`,
    argv: (oduArgv) => [
      "systemd-run",
      "--user",
      // Reap the unit's own bookkeeping when it exits, so a machine that runs
      // a hundred CI runs does not accumulate a hundred failed unit stubs.
      "--collect",
      // Inherit the launcher's cwd — the run is a function of its checkout.
      "--same-dir",
      `--unit=${unitName}`,
      "--quiet",
      // CARRY THE ENVIRONMENT ACROSS. A transient unit starts from the user
      // manager's environment, not from ours, so everything that tells odu
      // where to look — the hosts file, the state root, the flake the lane
      // runner comes from — is simply absent unless it is named. A coordinator
      // that starts with none of them is not a coordinator that started.
      ...forwardedEnv(env).flatMap((pair) => ["--setenv", pair]),
      "--",
      ...oduArgv,
    ],
    // The submitter's exit is not the run's. See `exitIsDeath`.
    exitIsDeath: false,
    describeExit: (code) =>
      code === 0
        ? "systemd-run accepted the unit but its socket never appeared"
        : `systemd-run refused to start the unit (exit ${code})`,
  };
}

/** The variables a transient unit must be told about, as `KEY=VALUE`.
 *
 *  An allowlist, not the whole environment: a unit inherits the manager's
 *  `PATH`/`HOME` already, and forwarding a launcher's entire environment into
 *  a service is how an orchestrator's ambient identity variables end up inside
 *  every recipe the run executes. What is named here is what odu itself reads
 *  and what the platform needs to find its own runtime directory. */
export function forwardedEnv(env: SpawnEnv): string[] {
  const KEYS = [
    "ODU_HOSTS",
    "ODU_STATE_DIR",
    "ODU_RUNNER_FLAKE",
    "ODU_SELF",
    "ODU_GH_BIN",
    "ODU_AGENT_SUBSTITUTERS",
    "ODU_AGENT_TRUSTED_PUBLIC_KEYS",
    "ODU_LINGER_IDLE_MS",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
    "NIX_PATH",
    "PATH",
    "HOME",
  ];
  return KEYS.flatMap((k) => {
    const v = env[k];
    return v === undefined || v === "" ? [] : [`${k}=${v}`];
  });
}

/**
 * Poll until the coordinator socket answers or the child exits.
 *
 * No fixed startup window. The socket comes up before the venue claim
 * (juspay/odu#84), so the poll is normally short — but the startup ahead of it
 * (strict gate, `just` DAG ingest, seq reservation) is still unbounded work on
 * a loaded machine, and bounding the poll to SIGTERM a healthy child was a
 * regression once before (juspay/odu#54's lease wait). Child exit is the only
 * failure bound — a dirty-tree refusal / bad justfile dies immediately.
 */
export async function pollUntilSocketOrExit(
  ready: () => Promise<boolean>,
  exited: Promise<unknown>,
  intervalMs = 250,
): Promise<boolean> {
  // A flag the exit promise flips; the loop does one final probe after it so a
  // detached coordinator that came up as the launcher exited still counts.
  let done = false;
  void exited.then(() => {
    done = true;
  });
  for (;;) {
    if (await ready()) return true;
    if (done) {
      // Child has exited — one last probe, then give up rather than poll on.
      return ready();
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Probe a coordinator socket and release the probe at once — we only want to
 *  know it answers, not to hold it open. */
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

/** How long to keep polling for a socket after the launch was ACCEPTED but the
 *  process we forked has gone (the `systemd-run` case). Generous, because what
 *  happens between acceptance and a bound socket is odu's whole startup — the
 *  strict gate, the `just` DAG ingest, the seq reservation — on a machine that
 *  may be loaded. Bounded, because a caller must eventually be answered. */
export const READINESS_CEILING_MS = 120_000;

/**
 * Wait until the coordinator is serving, given what this plan's process exit
 * actually means.
 *
 * Two different waits behind one call, because the launch mechanisms report
 * two different things. A DETACHED spawn forked the coordinator itself, so its
 * exit is the run's death and the poll should stop there. `systemd-run` merely
 * SUBMITTED the unit and exits while the service is still starting, so its
 * exit bounds nothing — a non-zero code means the job was refused, and a zero
 * code means the wait carries on against its own deadline.
 */
export async function waitForReadiness(
  plan: SpawnPlan,
  socketPath: string,
  onExit: Promise<number>,
  ceilingMs: number = READINESS_CEILING_MS,
): Promise<boolean> {
  if (plan.exitIsDeath) return defaultWaitForSocket(socketPath, onExit);
  const refused = onExit.then((code) => code !== 0);
  const deadline = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ceilingMs);
    timer.unref?.();
  });
  // Stop when the submitter REFUSED the job, or when the ceiling is reached —
  // never merely because it returned.
  const give = Promise.race([
    refused.then((no) => (no ? undefined : new Promise<void>(() => {}))),
    deadline,
  ]);
  return pollUntilSocketOrExit(() => socketAnswers(socketPath), give);
}

/** Spawned coordinators, kept referenced so V8 does not collect the handle
 *  mid-run (unref'd handles still fire their `exit` in this process).
 *  Deliberately never reaped: a coordinator outlives a plain exit of whatever
 *  started it, which is the whole point. */
const liveRuns = new Set<ChildProcess>();

export interface SpawnedCoordinator {
  child: ChildProcess;
  /** The mechanism actually used, and why — reported to the caller so it can
   *  say what the run's lifetime really is. */
  plan: SpawnPlan;
  onExit: Promise<number>;
  /** A bounded tail of the coordinator's own log, for reporting a startup
   *  failure. Read from the file at the moment it is asked for, so it carries
   *  everything the child wrote — not only what arrived before the launcher
   *  stopped listening. */
  stderrTail: () => string;
}

/**
 * Start a coordinator with the strongest independence this environment offers,
 * writing its own narration to `logPath`. The caller owns waiting for its
 * socket.
 *
 * A FILE, NOT A PIPE, and this is the load-bearing difference between this
 * function and {@link coordinatorSpawnSpec}. A launcher that exits as soon as
 * the socket answers — which is what a launcher should do — leaves the read
 * end of every pipe it gave the child closed, and the child is at that moment
 * about to narrate a venue claim, a lane's provisioning, and every node
 * transition into it. MEASURED, not reasoned: a coordinator spawned with pipes
 * whose launcher exits at socket-up dies part-way through provisioning, with
 * its journal ending at the lane lease and no verdict anywhere. A file has no
 * reader to lose.
 *
 * It is also strictly more useful. The output stops being a convenience the
 * launcher happened to be holding and becomes a durable artifact addressed by
 * run: a startup failure is readable after the fact, and so is the
 * coordinator's own account of a run that went wrong in a way its per-node
 * logs do not show.
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
  const argv = plan.argv(oduArgv);
  const [cmd, ...rest] = argv;
  if (cmd === undefined) throw new Error("odu: empty coordinator argv");
  mkdirSync(dirname(logPath), { recursive: true });
  // Append: a takeover re-launching into the same run id adds to the account
  // rather than erasing the one that explains why it had to.
  const fd = openSync(logPath, "a");
  let child: ChildProcess;
  try {
    child = spawn(cmd, rest, {
      cwd: checkout,
      stdio: ["ignore", fd, fd],
      env: process.env,
      detached: true,
    });
  } finally {
    // The child holds its own duplicate; keeping ours open would pin the file
    // in this process for as long as the launcher lives.
    closeSync(fd);
  }
  child.unref();
  liveRuns.add(child);
  const onExit = new Promise<number>((resolve) => {
    child.on("exit", (code) => {
      liveRuns.delete(child);
      resolve(code ?? -1);
    });
    child.on("error", () => {
      liveRuns.delete(child);
      resolve(-1);
    });
  });
  return { child, plan, onExit, stderrTail: () => tailOf(logPath) };
}

/**
 * The last 64 KiB of the coordinator's log — what a launcher quotes when the
 * socket never came up.
 *
 * A negative offset over `readFileSlice`, which is the run catalog's own
 * bounded, race-free read. It was a hand-rolled open/fstat/read loop here, and
 * a third copy of the same twelve lines: the technique — one descriptor, a
 * non-fatal decode at the slice boundary, a partial-read retry — is one thing,
 * and which file it is applied to is the only part that differs.
 */
function tailOf(path: string): string {
  return readFileSlice(path, { offset: -64 * 1024 })?.text ?? "";
}
