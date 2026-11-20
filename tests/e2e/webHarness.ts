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

export { hostsFile, PORT_SLOT, privateWorld, suitePort, suitePortFor };

export interface WebWorld {
  odu: string;
  origin: string;
  env: NodeJS.ProcessEnv;
  daemon: ChildProcess | null;
  logPath: string;
  root: string;
  daemonHome?: string;
  dispose: () => void;
}

/**
 * THE WHOLE PUBLIC VOCABULARY, sorted — every verb the shared contract exposes
 * as a tool, and nothing else.
 *
 * Here rather than in each test file because two faces assert it: the bridge
 * this repo builds (`mcp.e2e.test.ts`) and the MCP server odu's Agent Plugin
 * declares (`install.e2e.test.ts`). Two copies would drift, and the drift would
 * be invisible — each file would still pass against its own stale list.
 *
 * Derived from TWO expose maps by the framework's own naming rule — `<key>_<ns>_<verb>`
 * for a row served as a sibling, `<ns>_<verb>` for the runs' core
 * (`packages/service-client/src/verbs.ts` and `packages/cache/src/surface.ts`).
 * It is deliberately NOT imported from either: this suite is black-box, and a
 * list imported from the code under test would agree with a mistake.
 */
export const SHARED_TOOLS = [
  "cache_bucket_create",
  "cache_bucket_delete",
  "cache_bucket_describe",
  "cache_bucket_domain",
  "cache_bucket_list",
  "cache_bucket_migrate",
  "cache_bucket_paths",
  "cache_bucket_retention",
  "cache_gc_plan",
  "cache_gc_run",
  "cache_pin_create",
  "cache_pin_delete",
  "cache_pin_list",
  "cache_stats_read",
  "cache_token_list",
  "cache_token_mint",
  "cache_token_revoke",
  "catalog_import",
  "catalog_prune",
  "log_read",
  "metrics_token_list",
  "metrics_token_mint",
  "metrics_token_revoke",
  "pipeline_read",
  "protect_apply",
  "run_cancel",
  "run_list",
  "run_read",
  "run_retry",
  "run_start",
  "run_wait",
  "venue_hold",
  "venue_probe",
  "venue_release",
] as const;

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
    }
  }
}

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

export async function startWebService(
  oduBin: string,
  envOver: NodeJS.ProcessEnv = {},
  port: number = suitePortFor("forkedDaemon"),
): Promise<WebWorld> {
  const world0 = privateWorld(port);
  const root = world0.root;
  const origin = world0.origin;
  const env = { ...world0.env, ...envOver };
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
    world.daemonHome = cell.identity.home;
  } catch (err) {
    throw new Error(`${String(err)}\n--- daemon log ---\n${daemonLog(world)}`);
  }
  return world;
}

export async function startWebServiceViaCommand(
  oduBin: string,
  port: number = suitePortFor("commandDaemon"),
  envOver: NodeJS.ProcessEnv = {},
): Promise<WebWorld> {
  const { root, origin, env: worldEnv } = privateWorld(port);
  const env = { ...worldEnv, ...envOver };
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

export function headOf(dir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf-8",
  }).trim();
}

export function runSocketExists(dir: string): boolean {
  return existsSync(join(dir, ".ci", "odu.sock"));
}
