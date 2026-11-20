import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANE_SLEEP_SECONDS, SLEEP_PAST_ANY_SCENARIO_SECONDS, STEP_TIMEOUT } from "./budgets.ts";

const MAX_CLI_OUTPUT_BYTES = 256 * 1024 * 1024;

export function readOduBin(): string {
  const bin = process.env.ODU_BIN;
  if (bin === undefined || bin === "") {
    throw new Error(
      "ODU_BIN is not set, and this suite has no fallback. It drives the " +
        "PACKAGED odu — `nix build .#odu` → <out>/bin/odu — which is what " +
        "`just e2e-web` builds and passes. A source runtime (`bun " +
        "src/main.ts`) has none of the locators the wrapper bakes (ODU_SELF, " +
        "ODU_WEB_DIST, ODU_BUILD_ID), so it cannot even serve the page these " +
        "features are about.",
    );
  }
  return bin;
}

let system: string | undefined;
export function currentNixSystem(): string {
  return (system ??= execFileSync(
    "nix",
    ["eval", "--impure", "--raw", "--expr", "builtins.currentSystem"],
    { encoding: "utf-8" },
  ).trim());
}

export interface Service {
  odu: string;
  origin: string;
  env: NodeJS.ProcessEnv;
  daemon: ChildProcess;
  logPath: string;
  root: string;
  daemonHome: string;
}

export const ROOT_TOKEN = "acceptance-root-token";

const reservedPorts = new Map<string, number>();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no port was assigned"))));
    });
  });
}

export async function reserveWorldPortsBeforeAnyWorldStarts(): Promise<void> {
  for (const key of ["worker", "door", "stub", "tunnel"]) {
    reservedPorts.set(key, await freePort());
  }
}

function reserved(key: string): number {
  const port = reservedPorts.get(key);
  if (port === undefined) {
    throw new Error(
      `web-acceptance: the ${key} port was asked for before reserveWorldPortsBeforeAnyWorldStarts() ran. ` +
        "Call it first (BeforeAll does): every port this suite binds is one the kernel " +
        "picked, so a daemon an earlier run left behind cannot be holding it.",
    );
  }
  return port;
}

export function workerPort(): number {
  return reserved("worker");
}

export function doorPort(): number {
  return reserved("door");
}

export function stubPort(): number {
  return reserved("stub");
}

export function tunnelPort(): number {
  return reserved("tunnel");
}

export async function until<T>(
  what: string,
  ask: () => Promise<T | null> | (T | null),
  timeoutMs = STEP_TIMEOUT,
  pollMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await ask();
    if (value !== null) return value;
    if (Date.now() > deadline) {
      throw new Error(`web-acceptance: ${what} did not happen within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export function daemonLog(service: Pick<Service, "logPath">): string {
  try {
    return readFileSync(service.logPath, "utf-8").slice(-4000);
  } catch {
    return `(no daemon log at ${service.logPath})`;
  }
}

export async function startService(
  odu: string,
  port: number,
  extraEnv: NodeJS.ProcessEnv = {},
  readyTimeoutMs = 120_000,
): Promise<Service> {
  const root = mkdtempSync(join(tmpdir(), "odu-wa-"));
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const origin = `http://127.0.0.1:${port}`;
  const hosts = join(root, "hosts.json");
  writeFileSync(hosts, JSON.stringify({ [currentNixSystem()]: "localhost" }));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ODU_STATE_DIR: state,
    ODU_HOSTS: hosts,
    ODU_WEB_ORIGIN: origin,
    ODU_ROOT_TOKEN: ROOT_TOKEN,
    ...extraEnv,
  };

  const logPath = join(root, "daemon.log");
  const sink = createWriteStream(logPath);
  const daemon = spawn(odu, ["web-daemon"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  daemon.stdout?.pipe(sink);
  daemon.stderr?.pipe(sink);
  live.add(daemon);
  killLiveDaemonsOnSignalAndReRaise();

  const partial: Pick<Service, "odu" | "env" | "logPath"> = { odu, env, logPath };
  try {
    const cell = await until("the web service to say it is ready", () => {
      const answer = spawnSync(odu, ["surface", "get", "service"], {
        env,
        encoding: "utf-8",
        maxBuffer: MAX_CLI_OUTPUT_BYTES,
      });
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
    }, readyTimeoutMs);
    return { ...partial, origin, daemon, root, daemonHome: cell.identity.home };
  } catch (err) {
    killProcessGroup(daemon);
    live.delete(daemon);
    throw new Error(`${String(err)}\n--- daemon log ---\n${daemonLog(partial)}`);
  }
}

const live = new Set<ChildProcess>();

function killProcessGroup(daemon: ChildProcess): void {
  try {
    if (daemon.pid !== undefined) process.kill(-daemon.pid, "SIGTERM");
  } catch {
  }
}

let sweeping = false;
function killLiveDaemonsOnSignalAndReRaise(): void {
  if (sweeping) return;
  sweeping = true;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      for (const daemon of live) killProcessGroup(daemon);
      live.clear();
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}

export function stopService(service: Service): void {
  killProcessGroup(service.daemon);
  live.delete(service.daemon);
  for (const dir of [service.root, service.daemonHome]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(`web-acceptance: could not remove ${dir}: ${String(err)}\n`);
    }
  }
}

export function oduCli(
  service: Service,
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const answer = spawnSync(service.odu, argv, {
    env: { ...service.env, ...env },
    encoding: "utf-8",
    maxBuffer: MAX_CLI_OUTPUT_BYTES,
  });
  return { status: answer.status, stdout: answer.stdout, stderr: answer.stderr };
}

export function surfaceCall(
  service: Service,
  argv: string[],
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(service.odu, ["surface", ...argv], {
    env: service.env,
    encoding: "utf-8",
    maxBuffer: MAX_CLI_OUTPUT_BYTES,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

export function activeRunsOf(service: Service, checkout: string): string[] {
  const answer = surfaceVerbJson(service, "run_list", { checkout });
  if (answer.status !== 0) {
    throw new Error(
      `web-acceptance: run_list refused (exit ${answer.status})\n${answer.stderr}`,
    );
  }
  const rows =
    (answer.json as { rows?: Array<{ runId: string; settled: boolean }> } | null)?.rows ?? [];
  return rows.filter((row) => !row.settled).map((row) => row.runId);
}

export function cancelRun(service: Service, runId: string): boolean {
  const answer = surfaceVerbJson(service, "run_cancel", {
    runId,
    scope: { kind: "run" },
    requestId: `wa-teardown-${crypto.randomUUID()}`,
  });
  return answer.status === 0;
}

export interface VerbAnswer {
  status: number | null;
  json: unknown;
  stderr: string;
}

export function surfaceVerbJson(
  service: Service,
  name: string,
  input: unknown,
): VerbAnswer {
  const res = surfaceCall(service, [name, "--input", JSON.stringify(input), "--json"]);
  let json: unknown = null;
  try {
    json = JSON.parse(res.status === 0 ? res.stdout : res.stderr);
  } catch {
    json = null;
  }
  return { status: res.status, json, stderr: res.stderr };
}

export const FAILING = `[metadata("ci")]
default: alpha beta

alpha:
    echo "alpha ok"

beta: alpha
    echo "beta is about to fail"
    exit 3
`;

const BURST_OPENING_LINES = 40;
const BURST_OPENING_PACE_SECONDS = 0.15;
const BURST_LINES = 12_000;
const NOISY_BURSTS = 20;
const NOISY_LINES_PER_BURST = 250;
const NOISY_BURST_PAUSE_SECONDS = 0.05;

export const SLOW = `[metadata("ci")]
default: alpha slow

alpha:
    echo "alpha ok"

slow: alpha
    echo "slow start"
    sleep ${SLEEP_PAST_ANY_SCENARIO_SECONDS}
`;

export const FAST_RED = `[parallel]
[metadata("ci")]
default: quick slow

quick:
    echo "BOOM: the quick lane failed"
    exit 1

slow:
    sleep ${LANE_SLEEP_SECONDS}
`;

export const TIMELINE_SHAPES = `[parallel]
[metadata("ci")]
default: quick bad slow last

quick:
    echo "quick done"

bad:
    echo "the stopped lane failed"
    exit 1

slow:
    sleep ${LANE_SLEEP_SECONDS}

last: slow
    echo "never reached in a scenario"
`;

export const LIVE_BURST = `[metadata("ci")]
default: burst

burst:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "__BURST_BEGIN__"
    # A SLOW OPENING, so a follower catches up and parks in a waiting read —
    # which is the state it has to be in for the rest of this to mean anything.
    for i in $(seq 1 ${BURST_OPENING_LINES}); do
      printf 'burst line %06d — padding so every line is the same width in here\\n' "$i"
      sleep ${BURST_OPENING_PACE_SECONDS}
    done
    # THEN EVERYTHING AT ONCE, and exit. Several hundred kilobytes land between
    # one read and the next, so the page that first reports "this log can no
    # longer grow" has many more pages behind it. A follower that stops there
    # keeps the first 64 KiB and loses the rest — including the last line, which
    # for a failure is the diagnosis.
    for i in $(seq ${BURST_OPENING_LINES + 1} ${BURST_LINES}); do
      printf 'burst line %06d — padding so every line is the same width in here\\n' "$i"
    done
    echo "__BURST_END__"
`;

export const LONG_LOG = `[metadata("ci")]
default: noisy

noisy:
    #!/usr/bin/env bash
    set -euo pipefail
    for burst in $(seq 0 ${NOISY_BURSTS - 1}); do
      for i in $(seq 1 ${NOISY_LINES_PER_BURST}); do
        printf 'noisy line %06d — padding so every line is the same width here\\n' "$((burst * ${NOISY_LINES_PER_BURST} + i))"
      done
      sleep ${NOISY_BURST_PAUSE_SECONDS}
    done
    echo "NOISY SUMMARY: ${NOISY_BURSTS * NOISY_LINES_PER_BURST} lines emitted"
`;

export function makeFixture(justfile: string): string {
  const resolvedFixtureDir = realpathSync(mkdtempSync(join(tmpdir(), "odu-wa-repo-")));
  writeFileSync(join(resolvedFixtureDir, ".gitignore"), ".ci/\n");
  writeFileSync(join(resolvedFixtureDir, "justfile"), justfile);
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: resolvedFixtureDir, encoding: "utf-8" });
  };
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.email=acceptance@odu.test",
    "-c",
    "user.name=odu web acceptance",
    "commit",
    "-q",
    "-m",
    "fixture",
  );
  return resolvedFixtureDir;
}

export function headOf(dir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf-8",
  }).trim();
}

export function removeFixture(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`web-acceptance: could not remove ${dir}: ${String(err)}\n`);
  }
}

export function startRun(
  service: Service,
  input: Record<string, unknown>,
): string {
  const start = surfaceVerbJson(service, "run_start", { ...input, noPost: true });
  if (start.status !== 0) {
    throw new Error(
      `web-acceptance: run_start refused (exit ${start.status})\n${start.stderr}\n` +
        `--- daemon log ---\n${daemonLog(service)}`,
    );
  }
  const receipt = start.json as { runId: string; accepted: boolean };
  return receipt.runId;
}

export interface NodeFailure {
  node: string;
  logKey: string;
}

export interface Settled {
  settled: boolean;
  passed: boolean;
  failures: NodeFailure[];
}

export async function waitSettled(
  service: Service,
  runId: string,
  timeoutMs: number,
): Promise<Settled> {
  return await until(
    `run ${runId} to settle`,
    () => {
      const waited = surfaceVerbJson(service, "run_wait", { runId, deadlineMs: 20_000 });
      if (waited.status !== 0) return null;
      const value = waited.json as Settled;
      return value.settled ? value : null;
    },
    timeoutMs,
    0,
  );
}
