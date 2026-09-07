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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  /** The daemon process, so a test can prove a run outlives it. */
  daemon: ChildProcess;
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
  const root = mkdtempSync(join(tmpdir(), "odu-e2e-web-"));
  const home = join(root, "home");
  const state = join(root, "state");
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
  const origin = `http://127.0.0.1:${suitePort()}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    ODU_STATE_DIR: state,
    ODU_HOSTS: hostsFile(root),
    ODU_WEB_ORIGIN: origin,
  };
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
