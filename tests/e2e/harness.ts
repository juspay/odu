/**
 * Black-box e2e harness: drive the real, nix-built `odu` binary against a
 * throwaway fixture repo and read back its `--progress json` stream.
 *
 * No imports from `src/` on purpose — the contract under test is the binary's
 * observable behavior (NDJSON shape + exit code), not its internals. See
 * tests/e2e/README.md for the design tradeoffs this harness commits to.
 */

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
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Large maxBuffer for nix output / NDJSON streams (256 MiB). */
export const BIG = 256 * 1024 * 1024;

/** Every directory this process made under `$TMPDIR`. The ordinary `afterEach`
 *  path still does the work; this is what removes the ones a failed test never
 *  reached, and the ones a detached coordinator wrote back afterwards. */
const fixtures = new Set<string>();

/** When this process started, so the sweep can tell a daemon home IT caused
 *  from one that was already on the machine. */
const startedAt = Date.now();

/**
 * A throwaway directory, REGISTERED.
 *
 * Every `mkdtempSync` in this directory goes through here. Four files were
 * making their own and relying on an `afterEach` that a failed test skips, so
 * a suite left fixtures, shim directories and consumer checkouts behind on
 * every red run — the runs where somebody is most likely to look at the
 * machine and least likely to want to sort out what is rubbish.
 */
export function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  fixtures.add(dir);
  return dir;
}

/** This machine's Nix system tuple, asked of Nix itself — the same authority
 *  `resolveSystem` and the `tests/evidence/*.sh` scripts use. A hand-rolled
 *  arch/os table would drift as platforms are added and disagree with Nix
 *  under emulation / cross setups; `builtins.currentSystem` is what odu will
 *  actually build `odu-runner` against, so it is the tuple the lane must name.
 *  Synchronous, like this file's other `nix`/`git` calls; no import from `src/`. */
export function currentNixSystem(): string {
  return execFileSync(
    "nix",
    ["eval", "--impure", "--raw", "--expr", "builtins.currentSystem"],
    { encoding: "utf-8" },
  ).trim();
}

/**
 * A port for THIS suite.
 *
 * Derived from the pid rather than fixed, because the fixed 18440 is a
 * developer's own service and a suite that took it would both fail and be
 * disruptive. Above the ephemeral range's usual floor is not required here —
 * the bind is immediate and the window for a collision is the process's own.
 */
export function suitePort(): number {
  return 18500 + (process.pid % 900);
}

/**
 * EVERY PORT THIS SUITE USES, named in one place.
 *
 * The offsets were scattered across three files as bare `suitePort() + 1` /
 * `+ 2` arithmetic, and the cold-bootstrap gate had skipped the scheme entirely
 * for a hardcoded `18493` — which collided, deterministically, with any second
 * checkout of this suite running at the same time (there are two dozen odu
 * worktrees on the author's machine). Each suite killed the other's daemon and
 * immediately re-bootstrapped, and the failure surfaced as
 * "the stale cold-port daemon to go away did not happen within 120000ms" in a
 * test whose subject is "nothing is serving".
 *
 * A named slot cannot be silently reused the way a `+ 1` can, and adding one is
 * the moment you see the ones already taken.
 */
export const PORT_SLOT = {
  /** {@link startWebService} — the forked `web-daemon`. */
  forkedDaemon: 0,
  /** {@link startWebServiceViaCommand} — `odu web --background`. */
  commandDaemon: 1,
  /** `web.e2e.test.ts`'s foreground `odu web` tenure. */
  foreground: 2,
  /** `mcp.e2e.test.ts` — a bridge bootstrapping onto an empty machine. */
  coldBootstrap: 3,
  /** `mcp.e2e.test.ts` — four cold faces racing for one daemon. */
  coldRace: 4,
  /** `mcp.e2e.test.ts` — a foreign listener, met through `odu mcp`. */
  occupiedAgent: 5,
  /** `lifecycle.e2e.test.ts` — a foreign listener, met through `odu web`. */
  occupiedTerminal: 6,
  /** `lifecycle.e2e.test.ts` — a daemon killed mid-mutation, then restarted. */
  crashWindow: 7,
  /** `lifecycle.e2e.test.ts` — a daemon restarted under live runs. */
  restartUnderRuns: 8,
  /** `lifecycle.e2e.test.ts` — clients that walk away mid-wait. */
  disconnect: 9,
  /** `install.e2e.test.ts` — the daemon a freshly installed launcher starts. */
  freshInstall: 10,
  /** {@link hermeticEnv} — the service every black-box `odu run` in this
   *  directory reaches. It is a SLOT and not the default 18440 because
   *  `odu run` became a client of a per-user singleton: without this, a
   *  fixture run would be executed by whatever daemon the machine already
   *  had, write into the developer's real catalog, and — on a persistent CI
   *  runner with two jobs in flight — be served by the OTHER job's build. */
  blackBoxRuns: 11,
} as const;

/** The port for one named slot in THIS suite's block. */
export function suitePortFor(slot: keyof typeof PORT_SLOT): number {
  return suitePort() + PORT_SLOT[slot];
}


export function hostsFile(root: string): string {
  const path = join(root, "hosts.json");
  writeFileSync(path, JSON.stringify({ [currentNixSystem()]: "localhost" }));
  return path;
}


/**
 * A private world for one service: its own daemon home, catalog, hosts file and
 * port. Two suites on one machine do not fight, and a developer's own `odu web`
 * is untouched.
 *
 * **`HOME` is deliberately NOT redirected.** It was, and that is what made this
 * suite fail on CI in a way no local run could reproduce: a single-user Nix
 * install — which is what a GitHub runner has — keeps
 * `experimental-features = nix-command flakes` in `$HOME/.config/nix/nix.conf`,
 * so a coordinator started inside a world with a synthetic home could not
 * evaluate a flake and every run refused with `launch_failed`. A machine on
 * which `HOME` has to be faked for isolation is a machine odu would not work on
 * either, so the isolation is done with the two variables that actually name
 * what odu owns — the daemon home and the catalog — and everything the
 * toolchain reads out of the real home is left alone.
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
      // The catalog.
      ODU_STATE_DIR: state,
      ODU_HOSTS: hostsFile(root),
      // AND the daemon home, transitively: `daemonHome`'s "state" placement
      // deliberately ignores `XDG_STATE_HOME` (it varies by launch context and
      // would split one daemon's identity), so `~/.local/state/<app>` is the
      // only lever — and odu derives `<app>` from the origin. Moving the origin
      // is therefore what keeps this suite's gate out of a developer's own.
      // `dispose` removes the directory it leaves behind.
      ODU_WEB_ORIGIN: origin,
    },
  };
}


/**
 * A fixture run's env: a PRIVATE WORLD, not the ambient one plus a hosts file.
 *
 * It used to be exactly that — `{...process.env, ODU_HOSTS}` — and it was
 * enough while `odu run` did the work in its own process. It stopped being
 * enough the moment `odu run` became a client: the run is executed by a child
 * of a per-user singleton, so what the fixture reached was whichever daemon the
 * machine already had, with that daemon's catalog and that daemon's build. On a
 * persistent CI runner with two jobs in flight, one suite's runs were served by
 * the other suite's service.
 *
 * The three variables below are the ones that actually name what odu owns — the
 * catalog, the host inventory, and (through the origin) the daemon's home. See
 * {@link privateWorld} on why `HOME` is deliberately left alone.
 */
const blackBox = privateWorld(suitePortFor("blackBoxRuns"));
export const hermeticEnv: NodeJS.ProcessEnv = blackBox.env;

/**
 * A `gh` AT A FIXED PATH, dispatching to whichever stand-in the running test
 * has installed.
 *
 * `$ODU_GH_BIN` has the same shape of problem `$ODU_HOSTS` had, and for the
 * same reason: `protect` is a client now, and the `gh` it means is spawned by
 * the SERVICE. A variable set on the `odu protect` process therefore never
 * reaches the program that runs `gh` — and a test that wrote its stand-in to a
 * fresh temp directory per case could not put that path into a daemon which
 * had already started. Eleven `protect` assertions were being graded against
 * the real GitHub API.
 *
 * So the PATH is fixed and part of the world, which the service inherits, and
 * only the target moves. The pointer starts at the real `gh`, so a suite that
 * installs nothing behaves exactly as before.
 */
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

/**
 * Make this the world's `gh` for the next call.
 *
 * The SCRIPT is written here, not a pointer to one. The first shape of this was
 * a dispatcher that `exec`ed whatever a sibling file named — and what that file
 * named was a stand-in in the test's own temp directory, which `afterEach`
 * removes. The pointer then dangled between tests, and a `protect` that landed
 * on it failed with an exec error naming a path nobody had asked about. One
 * file that is always present and always current has no such window.
 *
 * Tests run one at a time, so the seam needs no locking, and a stand-in that
 * outlives its test is one the next installer replaces.
 */
export function useGh(script: string): void {
  writeFileSync(ghSeam, script);
  chmodSync(ghSeam, 0o755);
}

/**
 * The odu that will be driven, remembered so teardown can reach the service it
 * started. Set by {@link buildOduBinary}, which every suite calls in
 * `beforeAll` — null until then, and teardown does nothing in that case
 * because nothing can have been started either.
 */
let driven: string | null = null;


/**
 * EVERYTHING THIS PROCESS LEAVES ON THE MACHINE, removed once.
 *
 * There are four things and they are easy to miss, because none of them fails
 * a test:
 *
 *   1. **the service** — spawned lazily by whichever `odu run` came first, and
 *      detached ON PURPOSE, which is the property `odu run` exists to have. A
 *      suite that walks away leaves one serving on its port forever. Asked for
 *      its own pid rather than tracked: the process this suite forked is not
 *      necessarily the one serving, and the identity cell is the only thing
 *      that knows which is.
 *   2. **the daemon's home** — `~/.local/state/odu-web-<hash of origin>`, which
 *      is under the REAL state root and not this world's temp directory: odu
 *      derives the home from the origin and deliberately ignores
 *      `XDG_STATE_HOME`, so moving the origin is what isolates it and nothing
 *      moves it back. Forty-seven empty ones had accumulated before this
 *      existed. Read off the identity rather than recomputed — this suite does
 *      not get to own a copy of odu's naming.
 *   3. **the world** — catalog, hosts file, everything under the temp root.
 *   4. **fixture checkouts** — `afterEach` removes them, and a suite killed
 *      mid-test never reaches its `afterEach`.
 *
 * Idempotent and total: `exit` does not fire for a signal, and a suite is
 * interrupted far more often than it completes while somebody is working on
 * it, so the signals run it too and then leave by the route they arrived.
 */
/**
 * Stop whatever is serving at THIS suite's origin, and say where its home was.
 *
 * Asked for its own pid rather than tracked: the process this suite forked is
 * not necessarily the one serving, and the service's identity cell is the only
 * thing that knows which is. `null` when nothing answered, which is the
 * ordinary case and not a fault.
 */
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
    // A service that cannot be reached is a service that is already gone.
    return null;
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
function claimOrigin(odu: string): void {
  // EVERY SLOT, not just this world's. The band is derived from the pid, and on
  // a machine that runs this suite over and over — a persistent CI runner, a
  // developer's laptop — a previous run's pid can land on the same band. A slot
  // this suite does not serve but does BIND (the tests that put a foreign
  // listener on a port to see how odu meets one) then fails with `EADDRINUSE`
  // and reports it as a defect in odu.
  for (const slot of Object.keys(PORT_SLOT) as (keyof typeof PORT_SLOT)[]) {
    claimPort(odu, suitePortFor(slot));
  }
}

/** Take one port: evict whatever odu service is on it, and wait for it to let
 *  go. Silent when the port is free, which is the ordinary case. */
function claimPort(odu: string, port: number): void {
  // ASKED OF THE KERNEL, NOT OF ODU. Every odu command bootstraps its own
  // origin when nothing is serving it — that is the property `odu run` exists
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
    // Best effort; the sweep at exit tries again.
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
      // As above.
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
      // Best effort, on the way out.
    }
  }
}

/** Is this pid still a process? `signal 0` asks without sending anything. */
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
// The signals still get one, for the case `afterAll` cannot cover: a suite
// killed part-way through. They re-raise so a runner reading how its child died
// gets the true answer rather than a synthesised exit code.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    sweepUp();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

/** The odu checkout under test — the worktree this test file lives in. */
export const repoRoot = execFileSync(
  "git",
  ["rev-parse", "--show-toplevel"],
  { cwd: here, encoding: "utf-8" },
).trim();

/**
 * One line of `odu run --progress json` output. Deliberately mirrors — and is
 * NOT imported from — `ProgressEvent` in packages/execution/src/coordinator/display.ts: this is
 * the wire schema the test deserializes, so the assertions verify the binary's
 * real output (black-box). Sharing the type would make the test white-box and
 * hide exactly the wire-format regressions this suite exists to catch.
 */
export interface ProgressEvent {
  node: string; // fanId, e.g. "alpha@x86_64-linux"
  recipe: string; // just namepath, e.g. "alpha"
  platform: string; // e.g. "x86_64-linux"
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
  build(".#odu-runner"); // warm the store path the fixture will realise
  const bin = join(oduOut, "bin", "odu");
  // Remembered for teardown — see the `exit` handler beside `hermeticEnv`.
  driven = bin;
  // And the origin is CLAIMED here, before any test has made a call: this is
  // the one moment every suite in this directory passes through.
  claimOrigin(bin);
  return bin;
}

/**
 * Materialize a fixture into a fresh temp git repo: just the named fixture's
 * `justfile`, with NO flake. The fixture is a plain consumer that never
 * re-exports `odu-runner` — the runner comes from the baked ODU_RUNNER_FLAKE on
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

/** Run `odu run --no-strict --progress json` in `dir` and parse the stream. */
export function oduRun(
  oduBin: string,
  dir: string,
  selectors: string[] = [],
): RunResult {
  const res = spawnSync(
    oduBin,
    ["run", "--no-strict", "--progress", "json", ...selectors],
    { cwd: dir, encoding: "utf-8", maxBuffer: BIG, env: hermeticEnv },
  );
  const events: ProgressEvent[] = [];
  for (const line of res.stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as ProgressEvent);
    } catch (err) {
      // non-JSON noise on stdout is a contract violation — log it so
      // regressions surface here rather than as a mysterious missing-event
      // assertion failure downstream.
      process.stderr.write(`e2e: unparseable NDJSON line: ${line}\n${String(err)}\n`);
    }
  }
  return { status: res.status, events, stdout: res.stdout, stderr: res.stderr };
}

/** The terminal (last-seen) status for each recipe across the event stream. */
export function terminalStatuses(
  events: ProgressEvent[],
): Map<string, ProgressEvent> {
  return new Map(events.map((e) => [e.recipe, e]));
}

/** Best-effort temp-dir cleanup; never throws, but a failure is logged so a
 *  leaked fixture dir is visible in CI rather than silently accumulating. */
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

/** One synchronous `odu <argv…>` call in `dir` — the plain-CLI face used for
 *  the introspection commands (`wait`, `cancel`) a background run is driven
 *  through. Separate from `oduRun` because those return a verdict on stdout
 *  rather than an NDJSON progress stream, and their exit code is a verdict too
 *  (`odu wait` exits non-zero on a red run), so callers read the JSON. */
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

/** Start `odu run …` in `dir` as a background child, the way an agent's `run`
 *  tool does: the coordinator outlives the call and is observed over its socket
 *  instead of by waiting on the process. Returns the child and a promise that
 *  resolves when it exits, so a test can tear the run down deterministically. */
export function oduRunBackground(
  oduBin: string,
  dir: string,
  argv: string[],
): { child: ChildProcess; exited: Promise<void> } {
  const child = spawn(oduBin, ["run", ...argv], {
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
 *  first `odu wait` doesn't race the spawn and get the loud no-run refusal.
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
