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
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Large maxBuffer for nix output / NDJSON streams (256 MiB). */
export const BIG = 256 * 1024 * 1024;

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
  const root = mkdtempSync(join(tmpdir(), "odu-e2e-web-"));
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
 * The odu that will be driven, remembered so teardown can reach the service it
 * started. Set by {@link buildOduBinary}, which every suite calls in
 * `beforeAll` — null until then, and teardown does nothing in that case
 * because nothing can have been started either.
 */
let driven: string | null = null;

/**
 * STOP THE SERVICE THIS SUITE STARTED. Nobody else will.
 *
 * The daemon is spawned lazily, by whichever `odu run` came first, and it is
 * detached ON PURPOSE — that is the property `odu run` exists to have, and it
 * means a suite that walks away leaves a service running on its port with a
 * catalog under a temp directory nothing will ever read again.
 *
 * Asked for its own pid rather than tracked: the process this suite forked is
 * not necessarily the one serving (a launcher may hand off), and the service's
 * identity cell is the only thing that knows which one is.
 */
process.on("exit", () => {
  if (driven !== null) {
    try {
      const said = spawnSync(driven, ["surface", "get", "service"], {
        env: hermeticEnv,
        encoding: "utf-8",
        maxBuffer: BIG,
      });
      if (said.status === 0) {
        const cell = JSON.parse(said.stdout) as { identity: { pid: number } };
        process.kill(cell.identity.pid, "SIGTERM");
      }
    } catch {
      // Teardown, on the way out. A service that cannot be reached is a
      // service that is already gone, and a throw here would replace a suite's
      // real verdict with a cleanup error.
    }
  }
  try {
    rmSync(blackBox.root, { recursive: true, force: true });
  } catch {
    // Same.
  }
});

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
  const dir = mkdtempSync(join(tmpdir(), `odu-e2e-${name}-`));
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
