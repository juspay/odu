/**
 * A REAL web service, in a world of its own — the harness the cross-face suite
 * drives.
 *
 * Everything here is deliberately out-of-process. The daemon is the nix-built
 * binary, started the way `odu web` starts it; the CLI is that same binary in
 * another process; the HTTP MCP face is `curl`-shaped JSON-RPC over a socket.
 * Nothing imports `src/` — the contract under test is what a person and an agent
 * actually meet.
 *
 * The BROWSER is driven from `packages/web-acceptance` instead, through
 * Playwright against this same binary. It used to be driven from here with
 * `chrome --headless --dump-dom`, which is ONE STATIC SNAPSHOT of a live page —
 * and which skipped itself where no browser was on PATH, so on a CI runner it
 * graded nothing. Those three helpers are deleted rather than left standing
 * beside the new suite: an unused, silently-skipping browser path in the tree is
 * the finding, not a spare.
 *
 * **The world is a private one, and privacy stops where odu stops.** The port
 * is picked per suite and `ODU_STATE_DIR` points into a temp directory, so the
 * catalog, the receipts, the daemon home and its pid gate are all this suite's
 * — a developer's own running `odu web` is untouched and two runs of this suite
 * on one machine do not fight.
 *
 * What is NOT redirected is `HOME`, and that is a correction rather than an
 * omission: it used to be, and a synthetic home takes `~/.config/nix/nix.conf`
 * with it. On a single-user Nix install — which is what a CI runner is — that
 * file is where `experimental-features = nix-command flakes` lives, so every
 * coordinator this suite started could not evaluate a flake and every run
 * refused. It passed locally, on a machine with a system-wide nix.conf, and
 * failed on CI for a reason that had nothing to do with the code under test. A
 * host where odu needs a faked home is a host odu does not work on.
 */

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { connect as netConnect } from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BIG,
  currentNixSystem,
  hostsFile,
  PORT_SLOT,
  privateWorld,
  scratchDir,
  suitePort,
  suitePortFor,
} from "./harness";

// The port scheme and the private world moved to `./harness`, because the
// black-box suite needs them too: `odu run` is a client now, so a fixture run
// reaches a daemon and must reach ITS OWN. Re-exported here so the web tests
// that have always named them here do not have to learn where they went.
export { hostsFile, PORT_SLOT, privateWorld, suitePort, suitePortFor };

/** One service, and the world it owns. */
export interface WebWorld {
  /** The `odu` binary under test. */
  odu: string;
  /** Where the service is bound. */
  origin: string;
  /** The private HOME/state the daemon was started with. */
  env: NodeJS.ProcessEnv;
  /** The daemon process when this suite forked it directly; `null` when it was
   *  started by `odu web`, which is the whole point of that path — the daemon
   *  is nobody's child. */
  daemon: ChildProcess | null;
  /** The daemon's log, for a failure that needs to say why. */
  logPath: string;
  root: string;
  /** Where the daemon put its gate and control socket — read off the service's
   *  own identity rather than re-derived, and removed at teardown so a suite
   *  leaves nothing under the developer's state root. */
  daemonHome?: string;
  dispose: () => void;
}

/**
 * THE WHOLE PUBLIC VOCABULARY, sorted — every verb the shared contract exposes
 * as a tool, and nothing else.
 *
 * Here rather than in each test file because two faces assert it: the bridge
 * this repo builds (`mcp.e2e.test.ts`) and the launcher a fresh consumer
 * installs (`install.e2e.test.ts`). Two copies would drift, and the drift would
 * be invisible — each file would still pass against its own stale list.
 *
 * Derived from `packages/service-client/src/verbs.ts`'s `ODU_SERVICE_EXPOSE` by
 * the framework's own `toolName(ns, verb)` = `<ns>_<verb>`. It is deliberately
 * NOT imported from there: this suite is black-box, and a list imported from the
 * code under test would agree with a mistake.
 */
export const SHARED_TOOLS = [
  "catalog_import",
  "catalog_prune",
  "log_read",
  "pipeline_read",
  "protect_apply",
  "run_cancel",
  "run_read",
  "run_retry",
  "run_start",
  "run_wait",
  "venue_hold",
  "venue_probe",
  "venue_release",
] as const;

/** A hosts file pinning this machine's platform to a localhost lane, so lane
 *  resolution is hermetic wherever the suite runs. */
/** Whatever the daemon has said about itself, for a failure that needs to name
 *  a cause rather than a status code. Absent is normal on the systemd branch,
 *  where the journal has it instead. */
export function daemonLog(world: WebWorld): string {
  try {
    return readFileSync(world.logPath, "utf-8").slice(-4000);
  } catch {
    return `(no daemon log at ${world.logPath})`;
  }
}

/**
 * IS ANYTHING ACCEPTING AT THIS ORIGIN? A raw TCP connect, and nothing more.
 *
 * The only honest way for a test to observe ABSENCE. Every odu face bootstraps
 * now, so asking odu whether a service is running STARTS one — a poll loop
 * written that way kills a daemon and immediately spawns its replacement,
 * forever. That is not a flaw in the bootstrap; it is what "no face reports
 * nothing-serving without trying to fix it" means, and a test that wants to see
 * an empty port has to look from outside odu.
 *
 * TCP rather than `fetch`: a listener that accepts and then says nothing (which
 * is exactly the foreign-program case the occupied-port gates set up) leaves a
 * `fetch` hanging on its own timeout, and answers a connect instantly.
 */
export function tcpListening(origin: string, timeoutMs = 1_000): Promise<boolean> {
  const url = new URL(origin);
  return new Promise<boolean>((resolve) => {
    const socket = netConnect({
      host: url.hostname,
      port: Number(url.port === "" ? 80 : url.port),
    });
    const settle = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/**
 * Stop a daemon and everything it leads.
 *
 * The GROUP first — a daemon is a session leader on either launch branch, and a
 * plain kill would leave a coordinator behind — then the pid, for a host where
 * it is not. Both throws are swallowed: "already gone" is a success here, and a
 * teardown that failed on it would turn a passing test red.
 */
export function killDaemon(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
    } catch {
      // Already gone, or never a group leader.
    }
  }
}

/** Poll until `ask` answers, or fail with a sentence naming what was waited on. */
export async function until<T>(
  what: string,
  ask: () => Promise<T | null> | (T | null),
  timeoutMs = 120_000,
  pollMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await ask();
    if (value !== null) return value;
    if (Date.now() > deadline) {
      throw new Error(`e2e: ${what} did not happen within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Start a service in a private world and wait for it to say it is ready. */
export async function startWebService(oduBin: string): Promise<WebWorld> {
  const { root, origin, env } = privateWorld(suitePortFor("forkedDaemon"));
  const logPath = join(root, "daemon.log");
  const log = Bun.file(logPath);
  const daemon = spawn(oduBin, ["web-daemon"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const sink = Bun.file(logPath).writer();
  daemon.stdout?.on("data", (chunk: Buffer) => sink.write(chunk));
  daemon.stderr?.on("data", (chunk: Buffer) => sink.write(chunk));
  void log;

  const world: WebWorld = {
    odu: oduBin,
    origin,
    env,
    daemon,
    logPath,
    root,
    dispose: () => {
      try {
        // The whole process GROUP: the daemon is detached, and a coordinator it
        // started is detached from IT, so a plain kill would leave one behind.
        if (daemon.pid !== undefined) process.kill(-daemon.pid, "SIGTERM");
      } catch {
        // Already gone. Nothing to do, and nothing worth failing a teardown for.
      }
      void sink.end();
      for (const dir of [root, world.daemonHome]) {
        if (dir === undefined) continue;
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          process.stderr.write(`e2e: failed to remove ${dir}: ${String(err)}\n`);
        }
      }
    },
  };

  // READINESS IS ASKED FOR, never slept on: the service publishes its own state
  // and this reads it.
  try {
    const cell = await until("the web service to say it is ready", () => {
      const answer = surfaceCall(world, ["get", "service"]);
      if (answer.status !== 0) return null;
      try {
        const value = JSON.parse(answer.stdout) as {
          identity: { home: string };
          readiness: { state: string };
        };
        return value.readiness.state === "ready" ? value : null;
      } catch {
        return null;
      }
    });
    // The daemon home lives under the real `~/.local/state`, named for this
    // suite's origin — so it is ours to remove and nobody else's to trip over.
    world.daemonHome = cell.identity.home;
  } catch (err) {
    // A daemon that never answered has usually SAID why, and a bare "did not
    // happen within 120000ms" throws that away — which on a CI runner is the
    // whole of what a failure gets to say.
    throw new Error(`${String(err)}\n--- daemon log ---\n${daemonLog(world)}`);
  }
  return world;
}

/**
 * Start a service the way a person leaves one running — `odu web --background`,
 * which spawns the daemon and returns.
 *
 * Deliberately a different path from {@link startWebService}, which forks
 * `web-daemon` itself. That one exercises the daemon; this one exercises the
 * BOOTSTRAP — the launch-mode decision, the environment allowlist the child
 * gets, and the readiness handshake the command prints a URL on the strength of.
 * A suite that only ever forked the daemon could not have caught a spawn that
 * forced the wrong branch or handed the child an environment it could not run
 * a coordinator in, because it never used either.
 */
export async function startWebServiceViaCommand(
  oduBin: string,
  port: number = suitePortFor("commandDaemon"),
): Promise<WebWorld> {
  // A different port from the forked-daemon world, so the two coexist — which
  // they can only do because the gate is derived from the origin. A caller that
  // needs a world of its very own (the lifecycle gates kill and restart their
  // daemon, which no other test may be sharing) names its own slot.
  const { root, origin, env } = privateWorld(port);
  const started = spawnSync(oduBin, ["web", "--background"], {
    env,
    encoding: "utf-8",
  });
  if (started.status !== 0) {
    throw new Error(
      `e2e: \`odu web --background\` exited ${started.status}\n${started.stderr}${started.stdout}`,
    );
  }
  const cell = await until("`odu web --background` to leave a service running", () => {
    const answer = spawnSync(oduBin, ["surface", "get", "service"], {
      env,
      encoding: "utf-8",
      maxBuffer: BIG,
    });
    if (answer.status !== 0) return null;
    try {
      const value = JSON.parse(answer.stdout) as {
        identity: { pid: number; home: string };
        readiness: { state: string };
      };
      return value.readiness.state === "ready" ? value : null;
    } catch {
      return null;
    }
  });
  return {
    odu: oduBin,
    origin,
    env,
    daemon: null,
    // Where the daemon says its own home is, rather than a path this file
    // re-derives — the crash-catcher lives in it, and a second derivation is a
    // second thing that can be wrong about where the daemon put its reasons.
    logPath: join(cell.identity.home, "web-daemon.stderr.log"),
    root,
    daemonHome: cell.identity.home,
    dispose: () => {
      // Its GROUP first — the daemon is a session leader on either branch — and
      // then the pid, for a host where it is not.
      for (const target of [-cell.identity.pid, cell.identity.pid]) {
        try {
          process.kill(target, "SIGTERM");
        } catch {
          // Already gone, or never a group leader. Nothing worth failing on.
        }
      }
      for (const dir of [root, cell.identity.home]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          process.stderr.write(`e2e: failed to remove ${dir}: ${String(err)}\n`);
        }
      }
    },
  };
}

/** One `odu surface …` call against this world's service. */
export function surfaceCall(
  world: WebWorld,
  argv: string[],
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(world.odu, ["surface", ...argv], {
    env: world.env,
    encoding: "utf-8",
    maxBuffer: BIG,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** A verb call with a JSON input, answered as JSON. */
export function verb(
  world: WebWorld,
  name: string,
  input: unknown,
): { status: number | null; json: unknown; stderr: string } {
  const res = surfaceCall(world, [name, "--input", JSON.stringify(input), "--json"]);
  let json: unknown = null;
  const text = res.status === 0 ? res.stdout : res.stderr;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, stderr: res.stderr };
}

/** One JSON-RPC message to the HTTP MCP endpoint. */
export async function mcp(
  world: WebWorld,
  method: string,
  params?: unknown,
  id = 1,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${world.origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
  });
  return (await response.json()) as Record<string, unknown>;
}

/**
 * A throwaway git repo with a `justfile`, committed — the subject of a run.
 *
 * The path is RESOLVED before it is returned. `tmpdir()` is `/var/folders/...`
 * on macOS and `/private/var/folders/...` once anything resolves it, and a run
 * records the second (git's `--show-toplevel`) while a test holding the first
 * would compare two spellings of one directory and find them different. That is
 * not a macOS quirk worth working around per assertion; it is the fixture's
 * identity, so it is settled once, here.
 */
export function makeWebFixture(justfile: string): string {
  const dir = realpathSync(scratchDir("odu-e2e-webrepo-"));
  // `.ci/` is ignored so a SECOND run in the same checkout still sees a clean
  // tree: odu writes its per-checkout ledger there, and strict mode refuses a
  // dirty one — which is correct, and would otherwise make every fixture
  // single-use.
  writeFileSync(join(dir, ".gitignore"), ".ci/\n");
  writeFileSync(join(dir, "justfile"), justfile);
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

/** The commit a fixture is on. */
export function headOf(dir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf-8",
  }).trim();
}

/** Is the run socket for `dir` there yet? */
export function runSocketExists(dir: string): boolean {
  return existsSync(join(dir, ".ci", "odu.sock"));
}
