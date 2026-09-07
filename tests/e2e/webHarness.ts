/**
 * A REAL web service, in a world of its own — the harness the cross-face suite
 * drives.
 *
 * Everything here is deliberately out-of-process. The daemon is the nix-built
 * binary, started the way `odu web` starts it; the CLI is that same binary in
 * another process; the HTTP MCP face is `curl`-shaped JSON-RPC over a socket;
 * the browser is a headless Chrome when the machine has one. Nothing imports
 * `src/` — the contract under test is what a person and an agent actually meet.
 *
 * **The world is a private one.** `HOME` and `ODU_STATE_DIR` point into a temp
 * directory, so the daemon home, the pid gate, the catalog and the service's
 * request receipts are all this suite's — a developer's own running `odu web`
 * is untouched, and two runs of this suite on one machine do not fight. The
 * port is likewise picked per-suite rather than shared, for the same reason.
 */

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIG, currentNixSystem } from "./harness";

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
  dispose: () => void;
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

/** A hosts file pinning this machine's platform to a localhost lane, so lane
 *  resolution is hermetic wherever the suite runs. */
function hostsFile(root: string): string {
  const path = join(root, "hosts.json");
  writeFileSync(path, JSON.stringify({ [currentNixSystem()]: "localhost" }));
  return path;
}

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

/** A private world for one service: its own HOME, daemon home, catalog, hosts
 *  file and port. Two suites on one machine do not fight, and a developer's own
 *  `odu web` is untouched. */
function privateWorld(port: number): {
  root: string;
  origin: string;
  env: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(join(tmpdir(), "odu-e2e-web-"));
  const home = join(root, "home");
  const state = join(root, "state");
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
  const origin = `http://127.0.0.1:${port}`;
  return {
    root,
    origin,
    env: {
      ...process.env,
      HOME: home,
      // The daemon home (gate + control socket) is derived from XDG_STATE_HOME
      // when it is set and from HOME otherwise — so a developer who exports the
      // former would have this suite's daemon claim their own gate. Named
      // rather than left to the environment.
      XDG_STATE_HOME: join(root, "xdg-state"),
      ODU_STATE_DIR: state,
      ODU_HOSTS: hostsFile(root),
      ODU_WEB_ORIGIN: origin,
    },
  };
}

/** Start a service in a private world and wait for it to say it is ready. */
export async function startWebService(oduBin: string): Promise<WebWorld> {
  const { root, origin, env } = privateWorld(suitePort());
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
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (err) {
        process.stderr.write(`e2e: failed to remove ${root}: ${String(err)}\n`);
      }
    },
  };

  // READINESS IS ASKED FOR, never slept on: the service publishes its own state
  // and this reads it.
  await until("the web service to say it is ready", () => {
    const answer = surfaceCall(world, ["get", "service"]);
    if (answer.status !== 0) return null;
    try {
      const cell = JSON.parse(answer.stdout) as {
        readiness: { state: string };
      };
      return cell.readiness.state === "ready" ? cell : null;
    } catch {
      return null;
    }
  });
  return world;
}

/**
 * Start a service THE WAY A PERSON DOES — `odu web`, which spawns the daemon and
 * returns.
 *
 * Deliberately a different path from {@link startWebService}, which forks
 * `web-daemon` itself. That one exercises the daemon; this one exercises the
 * BOOTSTRAP — the launch-mode decision, the environment allowlist the child
 * gets, and the readiness handshake `odu web` prints a URL on the strength of.
 * A suite that only ever forked the daemon could not have caught a spawn that
 * forced the wrong branch or handed the child an environment it could not run
 * a coordinator in, because it never used either.
 */
export async function startWebServiceViaCommand(
  oduBin: string,
): Promise<WebWorld> {
  // A different port from the forked-daemon world, so the two coexist.
  const { root, origin, env } = privateWorld(suitePort() + 1);
  const logPath = join(root, "xdg-state", "odu-web", "web-daemon.stderr.log");
  const started = spawnSync(oduBin, ["web"], { env, encoding: "utf-8" });
  if (started.status !== 0) {
    throw new Error(
      `e2e: \`odu web\` exited ${started.status}\n${started.stderr}${started.stdout}`,
    );
  }
  const cell = await until("`odu web` to leave a service running", () => {
    const answer = spawnSync(oduBin, ["surface", "get", "service"], {
      env,
      encoding: "utf-8",
      maxBuffer: BIG,
    });
    if (answer.status !== 0) return null;
    try {
      const value = JSON.parse(answer.stdout) as {
        identity: { pid: number };
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
    logPath,
    root,
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
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (err) {
        process.stderr.write(`e2e: failed to remove ${root}: ${String(err)}\n`);
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

/** A throwaway git repo with a `justfile`, committed — the subject of a run. */
export function makeWebFixture(justfile: string): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-e2e-webrepo-"));
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

/** A headless Chrome, if this machine has one. The browser gate is SKIPPED
 *  rather than failed where there is none: a CI runner without a browser is a
 *  real environment, and a suite that failed there would be reporting the
 *  environment rather than the code. */
export function chromePath(): string | null {
  for (const candidate of ["google-chrome", "chromium", "chromium-browser"]) {
    const which = spawnSync("sh", ["-c", `command -v ${candidate}`], {
      encoding: "utf-8",
    });
    if (which.status === 0 && which.stdout.trim() !== "") return which.stdout.trim();
  }
  return null;
}

/** The rendered DOM of a page, after its scripts have run. */
export function renderPage(chrome: string, url: string): string {
  const res = spawnSync(
    chrome,
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--dump-dom",
      "--virtual-time-budget=9000",
      url,
    ],
    { encoding: "utf-8", maxBuffer: BIG },
  );
  return res.stdout;
}

/** Is the run socket for `dir` there yet? */
export function runSocketExists(dir: string): boolean {
  return existsSync(join(dir, ".ci", "odu.sock"));
}
