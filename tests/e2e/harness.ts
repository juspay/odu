import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const BIG = 256 * 1024 * 1024;

const fixtures = new Set<string>();

const startedAt = Date.now();

export function scratchDir(prefix: string): string {
  // RESOLVED, because a chroot store's root may not pass through a symlink and
  // `$TMPDIR` is one on macOS (`/var` → `/private/var`, and `/tmp` → `/private/tmp`
  // where a shell handed us `TMPDIR=/tmp`). Nix refuses with `the path "/tmp" is
  // a symlink; this is not allowed for the Nix store and its parent directories`
  // — a sentence about the store's PARENT that reads like a test bug, three
  // levels below the call that caused it.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  fixtures.add(dir);
  return dir;
}

export function currentNixSystem(): string {
  return execFileSync(
    "nix",
    ["eval", "--impure", "--raw", "--expr", "builtins.currentSystem"],
    { encoding: "utf-8" },
  ).trim();
}

export function suitePort(): number {
  return 18500 + (process.pid % 900);
}

export const PORT_SLOT = {
  forkedDaemon: 0,
  commandDaemon: 1,
  foreground: 2,
  coldBootstrap: 3,
  coldRace: 4,
  occupiedAgent: 5,
  occupiedTerminal: 6,
  crashWindow: 7,
  restartUnderRuns: 8,
  disconnect: 9,
  freshInstall: 10,
  blackBoxRuns: 11,
  callerInventory: 12,
  dirtyLocal: 13,
  dirtyTransport: 14,
  catalogScale: 15,
  cache: 16,
  authCli: 17,
  authStub: 18,
  bridgeRedial: 19,
  metrics: 20,
  runPush: 21,
  runPushForeign: 22,
  checkoutBranch: 23,
} as const;

export function suitePortFor(slot: keyof typeof PORT_SLOT): number {
  return suitePort() + PORT_SLOT[slot];
}


export function hostsFile(root: string): string {
  const path = join(root, "hosts.json");
  writeFileSync(path, JSON.stringify({ [currentNixSystem()]: "localhost" }));
  return path;
}


/**
 * **`HOME` is deliberately NOT redirected.**
 */
export function privateWorld(port: number): {
  root: string;
  origin: string;
  env: NodeJS.ProcessEnv;
} {
  const root = scratchDir("odu-e2e-web-");
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const origin = `http://127.0.0.1:${port}`;
  return {
    root,
    origin,
    env: {
      ...process.env,
      ODU_STATE_DIR: state,
      ODU_HOSTS: hostsFile(root),
      ODU_WEB_ORIGIN: origin,
    },
  };
}

const blackBox = privateWorld(suitePortFor("blackBoxRuns"));
export const hermeticEnv: NodeJS.ProcessEnv = blackBox.env;

const ghSeam = join(blackBox.root, "gh");
writeFileSync(
  ghSeam,
  `#!/bin/sh\nexec ${
    spawnSync("sh", ["-c", "command -v gh || true"], { encoding: "utf-8" })
      .stdout.trim() || "/bin/false"
  } "$@"\n`,
);
chmodSync(ghSeam, 0o755);
hermeticEnv.ODU_GH_BIN = ghSeam;

export function useGh(script: string): void {
  writeFileSync(ghSeam, script);
  chmodSync(ghSeam, 0o755);
}

let driven: string | null = null;

function stopService(odu: string, origin?: string): string | null {
  try {
    const said = spawnSync(odu, ["surface", "get", "service"], {
      env:
        origin === undefined
          ? hermeticEnv
          : { ...hermeticEnv, ODU_WEB_ORIGIN: origin },
      encoding: "utf-8",
      maxBuffer: BIG,
    });
    if (said.status !== 0) return null;
    const cell = JSON.parse(said.stdout) as {
      identity: { pid: number; home: string };
    };
    process.kill(cell.identity.pid, "SIGTERM");
    return cell.identity.home;
  } catch {
    return null;
  }
}

function claimOrigin(odu: string): void {
  for (const slot of Object.keys(PORT_SLOT) as (keyof typeof PORT_SLOT)[]) {
    claimPort(odu, suitePortFor(slot));
  }
}

/**
 * TAKE THE ORIGIN BEFORE USING IT — evict anything already serving there.
 *
 * `ensureService` ADOPTS a daemon that answers at the right origin with a
 * compatible build, which is exactly right in production and silently voids
 * this world in a suite: a daemon left behind by a previous run of these tests
 * answers, is adopted, and then serves every call out of the PREVIOUS run's
 * environment — its catalog, its hosts file, its `$ODU_GH_BIN`. All three of
 * those point into a temp directory that has since been removed, so `protect`
 * failed with `ENOENT … posix_spawn` on a stand-in this process had written and
 * the daemon could not see.
 *
 * The port band is this suite's own (see {@link PORT_SLOT}), so anything on it
 * is by construction a leftover of ours, and stopping it is not a decision
 * about somebody else's process.
 */
function claimPort(odu: string, port: number): void {
  // ASKED OF THE KERNEL, NOT OF ODU. Every odu command bootstraps its own
  // origin when nothing is serving it — that is the property `odu ci run` exists
  // to have — so using one to check whether a port is free STARTS a daemon,
  // and using one in a loop starts a daemon per iteration. This is what that
  // mistake looks like from outside: the eviction below killed the incumbent,
  // the probe brought it straight back, and fifteen seconds of that left a
  // machine covered in services nobody had asked for.
  if (!portIsOpen(port)) return;
  const home = stopService(odu, `http://127.0.0.1:${port}`);
  // Wait for the PORT, not for the pid: a successor cannot bind until the
  // incumbent has let go, and that is the thing the next call is about to do.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && portIsOpen(port)) {
    // Synchronous by design — this runs inside `beforeAll`, before any test has
    // an opinion, and a spin here is cheaper than making every caller async.
    spawnSync("sleep", ["0.1"]);
  }
  if (home === null) return;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
  }
}

/** Is anything accepting on this port? A raw connect, so it cannot start what
 *  it is asking about. */
function portIsOpen(port: number): boolean {
  const probe = spawnSync(
    "bash",
    ["-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`],
    { stdio: "ignore" },
  );
  return probe.status === 0;
}

let sweptUp = false;
function sweepUp(): void {
  if (sweptUp) return;
  sweptUp = true;
  const home = driven === null ? null : stopService(driven);
  for (const dir of [...fixtures, blackBox.root, ...(home === null ? [] : [home])]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
  sweepDaemonHomes();
}

/**
 * Daemon homes THIS process caused, removed.
 *
 * `~/.local/state/odu-web-<hash of origin>` is created by every service a test
 * starts, and several tests start their own on their own ports. Two conditions
 * together make removing one safe: its recorded pid is dead, and the directory
 * was created after this process began. The second is what keeps a developer's
 * own daemon home — which is alive anyway, and older — out of the sweep.
 */
function sweepDaemonHomes(): void {
  const state = join(homedir(), ".local", "state");
  let entries: string[];
  try {
    entries = readdirSync(state).filter((name) => name.startsWith("odu-web-"));
  } catch {
    return;
  }
  for (const name of entries) {
    const dir = join(state, name);
    try {
      if (statSync(dir).birthtimeMs < startedAt) continue;
      const pidFile = readdirSync(dir).find((f) => f.endsWith(".pid"));
      if (pidFile !== undefined) {
        const pid = Number(readFileSync(join(dir, pidFile), "utf-8").trim());
        if (Number.isInteger(pid) && alive(pid)) continue;
      }
      rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// HANDED TO THE PRELOAD, because it is the only place that runs ONCE.
//
// Two hooks were tried and both were wrong. `process.on("exit")` never fires —
// `bun test` ends its process without calling exit listeners, so a teardown
// hung on it exists only in the source. And an `afterAll` from here registers
// into the scope of whichever file imported this module FIRST, so it fired at
// the end of file one and took the shared service away from the ten files that
// still needed it.
//
// `bunfig.toml`'s preload registers a global `afterAll` and calls this from it.
(globalThis as { ODU_TEST_TEARDOWN?: () => void }).ODU_TEST_TEARDOWN = sweepUp;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    sweepUp();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

export const repoRoot = execFileSync(
  "git",
  ["rev-parse", "--show-toplevel"],
  { cwd: here, encoding: "utf-8" },
).trim();

/**
 * Deliberately mirrors — and is NOT imported from — `ProgressEvent` in
 * packages/execution/src/coordinator/display.ts.
 */
export interface ProgressEvent {
  node: string;
  recipe: string;
  platform: string;
  status: "running" | "success" | "failed" | "skipped" | "errored";
  exit_code?: number;
  log: string;
}

export interface RunResult {
  status: number | null;
  events: ProgressEvent[];
  stdout: string;
  stderr: string;
}

/**
 * Build `odu` (and warm `odu-runner`) from the worktree and return the path to
 * the `odu` executable. Prebuilding the runner means the fixture's in-flight
 * `nix eval …odu-runner.drvPath` resolves to an already-realised store path.
 */
export function buildOduBinary(): string {
  const build = (attr: string): string =>
    execFileSync(
      "nix",
      [
        "build",
        attr,
        "--no-link",
        "--print-out-paths",
        "--accept-flake-config",
      ],
      { cwd: repoRoot, encoding: "utf-8", maxBuffer: BIG },
    ).trim();

  const oduOut = build(".#odu");
  build(".#odu-runner");
  const bin = join(oduOut, "bin", "odu");
  driven = bin;
  // And the origin is CLAIMED here, before any test has made a call: this is
  // the one moment every suite in this directory passes through.
  claimOrigin(bin);
  return bin;
}

/**
 * Materialize a fixture into a fresh temp git repo: just the named fixture's
 * `justfile`, with NO flake. The fixture is a plain consumer that never
 * re-exports `odu-runner` — the runner comes from the agent source baked onto
 * the `.#odu` binary under test, so this exercises exactly the cross-repo path
 * (coordinator ships its own runner, consumer exports nothing) that issue #30
 * was about. The coordinator reads HEAD, so we commit before returning.
 */
export function makeFixture(name: string): string {
  // Registered before anything else can throw: a fixture that failed halfway
  // through `git init` is still a directory somebody has to remove.
  const dir = scratchDir(`odu-e2e-${name}-`);
  cpSync(join(here, "fixtures", name), dir, { recursive: true });

  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
  };
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.email=e2e@odu.test",
    "-c",
    "user.name=odu e2e",
    "commit",
    "-q",
    "-m",
    "fixture",
  );
  return dir;
}

export function oduRun(
  oduBin: string,
  dir: string,
  selectors: string[] = [],
): RunResult {
  const res = spawnSync(
    oduBin,
    ["ci", "run", "--no-strict", "--progress", "json", ...selectors],
    { cwd: dir, encoding: "utf-8", maxBuffer: BIG, env: hermeticEnv },
  );
  const events: ProgressEvent[] = [];
  for (const line of res.stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as ProgressEvent);
    } catch (err) {
      process.stderr.write(`e2e: unparseable NDJSON line: ${line}\n${String(err)}\n`);
    }
  }
  return { status: res.status, events, stdout: res.stdout, stderr: res.stderr };
}

export function terminalStatuses(
  events: ProgressEvent[],
): Map<string, ProgressEvent> {
  return new Map(events.map((e) => [e.recipe, e]));
}

export function cleanup(dir: string): void {
  // NOT deregistered. A run's coordinator is a detached process group that
  // outlives the test which started it, and it goes on writing `.ci/` — so a
  // directory removed here comes BACK, and the final sweep has to remove it
  // again. Keeping the registration is what lets it.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`e2e: failed to remove fixture ${dir}: ${String(err)}\n`);
  }
}

export function oduCli(
  oduBin: string,
  dir: string,
  argv: string[],
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(oduBin, argv, {
    cwd: dir,
    encoding: "utf-8",
    maxBuffer: BIG,
    env: hermeticEnv,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

export function oduRunBackground(
  oduBin: string,
  dir: string,
  argv: string[],
): { child: ChildProcess; exited: Promise<void> } {
  const child = spawn(oduBin, ["ci", "run", ...argv], {
    cwd: dir,
    env: hermeticEnv,
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
  });
  return { child, exited };
}

/** Block until the background coordinator has published its socket, so the
 *  first `odu ci wait` doesn't race the spawn and get the loud no-run refusal.
 *  Polls rather than watches: the file appears once, early, and a watcher on a
 *  directory that does not exist yet is its own race. */
export async function awaitRunSocket(
  dir: string,
  timeoutMs = 120_000,
): Promise<void> {
  const sock = join(dir, ".ci", "odu.sock");
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(sock)) {
    if (Date.now() > deadline) {
      throw new Error(`e2e: no ${sock} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
