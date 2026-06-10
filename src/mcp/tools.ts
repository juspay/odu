/**
 * The MCP tools — the agent face's request/response verbs. Each is stateless
 * and dials `.ci/odu.sock` per call, exactly like `odu status` / `logs` /
 * `monitor` (src/cli/introspect.ts): the runner owns the state, a tool is a
 * thin attach-read-detach. They return plain data; `server.ts` wraps it for
 * the wire and owns the MCP plumbing.
 *
 * The design fact that makes a request/response protocol enough (justci's
 * MCP #22 couldn't get this from process-compose's "no streaming" surface):
 * an agent doesn't want a byte stream, it wants (a) a point-in-time snapshot
 * (`get_nodes` / `tail_log`) and (b) one blocking "tell me when it's done"
 * (`wait_for_settle`, backed by the live `nodes` cell). Live push for hosts
 * that want it lives in resources.ts.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  firstSnapshot,
  resolveNodeId,
} from "../cli/introspect";
import { logPathFor } from "../coordinator/statuses";
import { SOCKET_PATH, tryDialSocket } from "../coordinator/socket";
import { gitTopLevel, headSha7 } from "./git";
import {
  type NodeState,
  type PipelineState,
  STATUS_META,
} from "../common/surface";

/** One node, flattened for the agent (the verbose `needs`/`startedAt` stay
 *  out of the default projection — an agent triaging a failure wants
 *  id/status/exit/duration). */
export interface NodeRow {
  id: string;
  name: string;
  status: NodeState["status"];
  exit_code: number | null;
  duration_ms: number | null;
  red: boolean;
}

export interface NodesResult {
  run: boolean;
  pipeline: string | null;
  nodes: NodeRow[];
}

function rowOf(node: NodeState): NodeRow {
  return {
    id: node.id,
    name: node.name,
    status: node.status,
    exit_code: node.exitCode,
    duration_ms: node.durationMs,
    red: STATUS_META[node.status].isRed,
  };
}

function rowsOf(state: PipelineState): NodeRow[] {
  return state.order
    .map((id) => state.nodes[id])
    .filter((n): n is NodeState => n !== undefined)
    .map(rowOf);
}

/** `get_nodes` — the whole pipeline as one structured snapshot, or
 *  `{ run: false }` when nothing is live. */
export async function getNodes(
  socketPath: string = SOCKET_PATH,
): Promise<NodesResult> {
  const dialed = await tryDialSocket(socketPath);
  if (dialed === null) return { run: false, pipeline: null, nodes: [] };
  try {
    const state = await firstSnapshot(dialed.client);
    return { run: true, pipeline: state.name, nodes: rowsOf(state) };
  } finally {
    dialed.close();
  }
}

export interface TailLogResult {
  node: string;
  /** "live" — read off the running coordinator's stream; "file" — the run is
   *  no longer live, read from the durable per-SHA log; "missing" — neither. */
  source: "live" | "file" | "missing";
  text: string;
}

/** `tail_log` — one node's output so far. Prefers the live stream's buffered
 *  snapshot (replays a finished node too); when no run is live, falls back to
 *  the durable `.ci/<sha7>/<platform>/<node>.log` the coordinator wrote — so
 *  an agent can still read a failure after the run process has exited. */
export async function tailLog(
  token: string,
  socketPath: string = SOCKET_PATH,
): Promise<TailLogResult> {
  const dialed = await tryDialSocket(socketPath);
  if (dialed !== null) {
    try {
      const state = await firstSnapshot(dialed.client);
      const id = resolveNodeId(state, token);
      for await (const frame of await dialed.client.surface.nodeLog.get({
        id,
      })) {
        // Non-follow: the first (snapshot) frame is the whole buffer.
        return { node: id, source: "live", text: frame.text };
      }
      return { node: id, source: "live", text: "" };
    } finally {
      dialed.close();
    }
  }
  // No live run — try the durable file. The token must be a full
  // `<namepath>@<platform>` id here (no live state to disambiguate against).
  const repoRoot = gitTopLevel();
  const sha7 = headSha7(repoRoot);
  if (repoRoot === null || sha7 === null) {
    return { node: token, source: "missing", text: "" };
  }
  const file = join(repoRoot, logPathFor(sha7, token));
  try {
    return { node: token, source: "file", text: readFileSync(file, "utf-8") };
  } catch {
    return { node: token, source: "missing", text: "" };
  }
}

export interface RerunResult {
  ok: boolean;
  node?: string;
  error?: string;
}

/** `rerun_node` — the only mutation. Resets the node + its transitive
 *  dependents on the live DAG and reschedules (no new run process). */
export async function rerunNode(
  token: string,
  socketPath: string = SOCKET_PATH,
): Promise<RerunResult> {
  const dialed = await tryDialSocket(socketPath);
  if (dialed === null) return { ok: false, error: "no run in progress" };
  try {
    const state = await firstSnapshot(dialed.client);
    const id = resolveNodeId(state, token);
    const { ok } = await dialed.client.surface.node.rerun({ id });
    return { ok, node: id };
  } finally {
    dialed.close();
  }
}

export interface SettleVerdict {
  /** Every node reached a terminal state within the timeout. */
  settled: boolean;
  /** Settled (or fail-fast tripped) with no red node. `false` while a red
   *  node exists or on timeout. */
  passed: boolean;
  failed: string[];
  errored: string[];
  /** Returned early because a node went red (fail-fast), before the slow
   *  lanes finished. */
  fail_fast_tripped: boolean;
  timed_out: boolean;
  duration_ms: number;
}

function redNodes(state: PipelineState): { failed: string[]; errored: string[] } {
  const failed: string[] = [];
  const errored: string[] = [];
  for (const id of state.order) {
    const status = state.nodes[id]?.status;
    if (status === "failed") failed.push(id);
    else if (status === "errored") errored.push(id);
  }
  return { failed, errored };
}

function isDone(state: PipelineState): boolean {
  return state.order.every((id) => {
    const s = state.nodes[id]?.status;
    return s !== "pending" && s !== "running";
  });
}

export interface WaitOptions {
  timeoutMs?: number;
  /** Return the instant a node goes red, rather than waiting for the whole
   *  run to settle (default true — the "e2e failed, drill in now" loop). */
  failFast?: boolean;
  socketPath?: string;
  /** Injected clock for tests; defaults to `Date.now`. */
  now?: () => number;
}

/** `wait_for_settle` — block on the live `nodes` cell and return the verdict
 *  the instant a node goes red (fail-fast) or the whole run settles. The
 *  blocking-pull floor that works on every MCP host (the model is inside a
 *  tool call when the answer lands), independent of resource notifications. */
export async function waitForSettle(
  opts: WaitOptions = {},
): Promise<SettleVerdict> {
  const failFast = opts.failFast ?? true;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const now = opts.now ?? Date.now;
  const socketPath = opts.socketPath ?? SOCKET_PATH;
  const started = now();

  const dialed = await tryDialSocket(socketPath);
  if (dialed === null) {
    return {
      settled: false,
      passed: false,
      failed: [],
      errored: [],
      fail_fast_tripped: false,
      timed_out: false,
      duration_ms: 0,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let last: PipelineState | undefined;
  try {
    for await (const state of await dialed.client.surface.nodes.get(
      {},
      { signal: controller.signal },
    )) {
      last = state;
      const { failed, errored } = redNodes(state);
      if (failFast && failed.length + errored.length > 0) {
        return {
          settled: isDone(state),
          passed: false,
          failed,
          errored,
          fail_fast_tripped: !isDone(state),
          timed_out: false,
          duration_ms: now() - started,
        };
      }
      if (isDone(state)) {
        return {
          settled: true,
          passed: failed.length + errored.length === 0,
          failed,
          errored,
          fail_fast_tripped: false,
          timed_out: false,
          duration_ms: now() - started,
        };
      }
    }
    // Stream ended without a terminal frame (coordinator closed the socket).
    const red = last !== undefined ? redNodes(last) : { failed: [], errored: [] };
    return {
      settled: last !== undefined ? isDone(last) : false,
      passed: last !== undefined && red.failed.length + red.errored.length === 0,
      failed: red.failed,
      errored: red.errored,
      fail_fast_tripped: false,
      timed_out: false,
      duration_ms: now() - started,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      const red =
        last !== undefined ? redNodes(last) : { failed: [], errored: [] };
      return {
        settled: false,
        passed: false,
        failed: red.failed,
        errored: red.errored,
        fail_fast_tripped: false,
        timed_out: true,
        duration_ms: now() - started,
      };
    }
    throw err;
  } finally {
    clearTimeout(timer);
    dialed.close();
  }
}

export interface RunInput {
  selectors?: string[];
  platforms?: string[];
  /** `PLATFORM=ADDR` host pins, one per platform (mirrors `odu run --host`). */
  hosts?: string[];
  root?: string;
  no_strict?: boolean;
  no_snapshot?: boolean;
  no_post?: boolean;
}

export interface RunResult {
  ok: boolean;
  started: boolean;
  pid?: number;
  error?: string;
}

/** The argv prefix that re-invokes the odu CLI. The nix wrapper bakes
 *  `ODU_SELF` to its own store path; in a dev checkout we re-exec the entry
 *  through `tsx`. */
export function oduSelfArgv(): string[] {
  const self = process.env.ODU_SELF;
  if (self !== undefined && self !== "") return [self];
  const entry = process.argv[1];
  return entry !== undefined ? ["tsx", entry] : ["tsx"];
}

function runArgsFrom(input: RunInput): string[] {
  const args = ["run", ...(input.selectors ?? [])];
  for (const p of input.platforms ?? []) args.push("--platform", p);
  for (const h of input.hosts ?? []) args.push("--host", h);
  if (input.root !== undefined) args.push("--root", input.root);
  if (input.no_strict) args.push("--no-strict");
  if (input.no_snapshot) args.push("--no-snapshot");
  if (input.no_post) args.push("--no-post");
  return args;
}

/** Children spawned by `run`, so the server can reap them on shutdown and so
 *  V8 doesn't collect the handle mid-run. */
const liveRuns = new Set<ReturnType<typeof spawn>>();

export function killRuns(): void {
  for (const child of liveRuns) child.kill("SIGTERM");
  liveRuns.clear();
}

export interface SpawnDeps {
  socketPath?: string;
  /** Injected for tests; defaults to spawning the real odu CLI. */
  spawnRun?: (args: string[]) => { stderr: string; onExit: Promise<number> };
  /** Poll the socket until it answers; injected for tests. */
  waitForSocket?: (socketPath: string) => Promise<boolean>;
}

async function defaultWaitForSocket(socketPath: string): Promise<boolean> {
  for (let i = 0; i < 240; i += 1) {
    if (await tryDialSocket(socketPath).then((d) => (d?.close(), d !== null))) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** `run` — start a pipeline the agent can then watch and drive. Spawns a
 *  background `odu run` (its own coordinator owning `.ci/odu.sock`) and
 *  returns once the socket is live, so a following `wait_for_settle` /
 *  `get_nodes` / resource subscribe attaches to it. One run per checkout: a
 *  live socket means a run is already in progress, so we refuse rather than
 *  collide on the lock. */
export async function startRun(
  input: RunInput,
  deps: SpawnDeps = {},
): Promise<RunResult> {
  const socketPath = deps.socketPath ?? SOCKET_PATH;

  const existing = await tryDialSocket(socketPath);
  if (existing !== null) {
    existing.close();
    return {
      ok: false,
      started: false,
      error: "a run is already in progress in this checkout",
    };
  }

  const args = runArgsFrom(input);

  if (deps.spawnRun !== undefined) {
    const { stderr, onExit } = deps.spawnRun(args);
    const up = await (deps.waitForSocket ?? defaultWaitForSocket)(socketPath);
    if (up) return { ok: true, started: true };
    const code = await onExit;
    return {
      ok: false,
      started: false,
      error: stderr.trim() || `odu run exited ${code} before serving a socket`,
    };
  }

  const [cmd, ...prefix] = oduSelfArgv();
  if (cmd === undefined) {
    return { ok: false, started: false, error: "cannot locate the odu binary" };
  }
  const child = spawn(cmd, [...prefix, ...args], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
    env: process.env,
  });
  liveRuns.add(child);
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => {
    stderr += c.toString("utf-8");
  });
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

  const up = await (deps.waitForSocket ?? defaultWaitForSocket)(socketPath);
  if (up) return { ok: true, started: true, pid: child.pid };
  const code = await onExit;
  return {
    ok: false,
    started: false,
    error: stderr.trim() || `odu run exited ${code} before serving a socket`,
  };
}
