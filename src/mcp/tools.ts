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
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import {
  firstSnapshot,
  resolveNodeId,
} from "../cli/introspect";
import { type NodeRowJson, nodeRow, summarize } from "../cli/render";
import { splitFanId } from "../common/nodeId";
import { logPathFor } from "../coordinator/statuses";
import { SOCKET_PATH, tryDialSocket } from "../coordinator/socket";
import { gitTopLevel, headSha7 } from "./git";
import {
  MAX_LOG_CHARS,
  type NodeState,
  type PipelineState,
  STATUS_META,
} from "../common/surface";

/** One node, flattened for the agent (the verbose `needs`/`startedAt` stay
 *  out of the default projection — an agent triaging a failure wants
 *  id/status/exit/duration). */
export interface NodeRow extends NodeRowJson {
  red: boolean;
}

export interface NodesResult {
  run: boolean;
  pipeline: string | null;
  nodes: NodeRow[];
}

function rowOf(node: NodeState): NodeRow {
  return { ...nodeRow(node), red: STATUS_META[node.status].isRed };
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

/** The durable log path for a node id, but only when it provably stays under
 *  `.ci/<sha7>/`. The token is untrusted MCP input and `logPathFor` splices
 *  the namepath straight into a relative path, so a crafted id
 *  (`../../etc/x@plat`, an absolute path, a separator in the platform) could
 *  otherwise escape the run's log dir. Returns `null` for any id that doesn't
 *  resolve to a `.log` file inside the per-SHA directory. */
function durableLogPath(
  repoRoot: string,
  sha7: string,
  token: string,
): string | null {
  const { namepath, platform } = splitFanId(token);
  if (namepath === "" || platform === "" || platform === "unknown") return null;
  const base = resolve(repoRoot, ".ci", sha7);
  const file = resolve(repoRoot, logPathFor(sha7, token));
  const rel = relative(base, file);
  // Must stay under `base` (no `..` escape, not an absolute sibling).
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`${sep}`)) {
    return null;
  }
  return file;
}

/** Read at most the last `MAX_LOG_CHARS` bytes of a file, matching the cap the
 *  live in-memory tail enforces — a durable CI log can be arbitrarily large,
 *  and returning it whole would block the server and blow up the MCP payload. */
function tailFile(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString("utf-8");
  } finally {
    closeSync(fd);
  }
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
  const file = durableLogPath(repoRoot, sha7, token);
  if (file === null) return { node: token, source: "missing", text: "" };
  try {
    return { node: token, source: "file", text: tailFile(file, MAX_LOG_CHARS) };
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
  /** The caller cancelled the wait (the MCP request was cancelled) before the
   *  run settled or timed out. */
  cancelled: boolean;
  duration_ms: number;
}

function redNodes(state: PipelineState): { failed: string[]; errored: string[] } {
  const failed: string[] = [];
  const errored: string[] = [];
  for (const id of state.order) {
    const status = state.nodes[id]?.status;
    // Gate redness on the receptacle (STATUS_META), then bucket by concrete
    // status — mirroring run.ts's verdict. Adding a red NodeStatus is one edit
    // in surface.ts; without this gate the agent verdict would silently desync
    // from the TUI/run verdict.
    if (status && STATUS_META[status].isRed) {
      if (status === "failed") failed.push(id);
      else if (status === "errored") errored.push(id);
    }
  }
  return { failed, errored };
}

export interface WaitOptions {
  timeoutMs?: number;
  /** Return the instant a node goes red, rather than waiting for the whole
   *  run to settle (default true — the "e2e failed, drill in now" loop). */
  failFast?: boolean;
  socketPath?: string;
  /** Caller cancellation (MCP request cancelled): closes the dialed socket and
   *  returns the cancelled verdict promptly instead of holding it open. */
  signal?: AbortSignal;
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
      cancelled: false,
      duration_ms: 0,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Caller cancellation (MCP request cancelled) aborts the same controller, so
  // the dialed socket is closed promptly rather than held until settle/timeout.
  const onCallerAbort = (): void => controller.abort();
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  let last: PipelineState | undefined;
  try {
    for await (const state of await dialed.client.surface.nodes.get(
      {},
      { signal: controller.signal },
    )) {
      last = state;
      const { failed, errored } = redNodes(state);
      if (failFast && failed.length + errored.length > 0) {
        const done = summarize(state).done;
        return {
          settled: done,
          passed: false,
          failed,
          errored,
          fail_fast_tripped: !done,
          timed_out: false,
          cancelled: false,
          duration_ms: now() - started,
        };
      }
      if (summarize(state).done) {
        return {
          settled: true,
          passed: failed.length + errored.length === 0,
          failed,
          errored,
          fail_fast_tripped: false,
          timed_out: false,
          cancelled: false,
          duration_ms: now() - started,
        };
      }
    }
    // Stream ended without us returning from inside the loop — the
    // coordinator closed the socket (crash, interrupt, or a close race) while
    // nodes were still pending/running. `settled` is true only if the last
    // snapshot we saw was already terminal; `passed` requires that — a green
    // verdict must never come from a half-observed run.
    const red = last !== undefined ? redNodes(last) : { failed: [], errored: [] };
    const settled = last !== undefined && summarize(last).done;
    return {
      settled,
      passed: settled && red.failed.length + red.errored.length === 0,
      failed: red.failed,
      errored: red.errored,
      fail_fast_tripped: false,
      timed_out: false,
      cancelled: false,
      duration_ms: now() - started,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      // Distinguish caller cancellation from the timeout firing.
      const cancelled = opts.signal?.aborted === true;
      const red =
        last !== undefined ? redNodes(last) : { failed: [], errored: [] };
      return {
        settled: false,
        passed: false,
        failed: red.failed,
        errored: red.errored,
        fail_fast_tripped: false,
        timed_out: !cancelled,
        cancelled,
        duration_ms: now() - started,
      };
    }
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
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
  /** Poll the socket until it answers (or `exited` resolves); injected for
   *  tests. The default stops early the instant the child dies so a failed run
   *  is reported at once, not after the whole poll window. */
  waitForSocket?: (
    socketPath: string,
    exited: Promise<unknown>,
  ) => Promise<boolean>;
}

async function defaultWaitForSocket(
  socketPath: string,
  exited: Promise<unknown>,
): Promise<boolean> {
  // A flag the exit promise flips; the loop does one final dial after it so a
  // detached coordinator that came up as the launcher exited still counts.
  let done = false;
  void exited.then(() => {
    done = true;
  });
  for (let i = 0; i < 240; i += 1) {
    if (await tryDialSocket(socketPath).then((d) => (d?.close(), d !== null))) {
      return true;
    }
    if (done) {
      // Child has exited — one last dial, then give up rather than poll on.
      return tryDialSocket(socketPath).then((d) => (d?.close(), d !== null));
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Bring the run up. The wait stops the instant the child dies (a dirty-tree
 *  refusal, a missing `tsx`, or a bad justfile kills it early), so a failed
 *  run is reported at once; if the child stays alive but never serves, the
 *  poll window still bounds the wait so we never block forever. The socket
 *  coming up always wins — a clean run can fork a detached coordinator and let
 *  the launcher exit. */
async function awaitStartup(
  waitForSocket: (s: string, exited: Promise<unknown>) => Promise<boolean>,
  socketPath: string,
  onExit: Promise<number>,
): Promise<{ up: true } | { up: false; code: number | null }> {
  let exitCode: number | null = null;
  let exited = false;
  const exitGuard = onExit.then((code) => {
    exitCode = code;
    exited = true;
  });
  const up = await waitForSocket(socketPath, exitGuard);
  if (up) return { up: true };
  // Not up. If the child has already exited (or is about to in this tick),
  // capture its code so we report it; never block on a still-alive child.
  await Promise.race([exitGuard, Promise.resolve()]);
  return { up: false, code: exited ? exitCode : null };
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

  const waitForSocket = deps.waitForSocket ?? defaultWaitForSocket;

  if (deps.spawnRun !== undefined) {
    const { stderr, onExit } = deps.spawnRun(args);
    const r = await awaitStartup(waitForSocket, socketPath, onExit);
    if (r.up) return { ok: true, started: true };
    return {
      ok: false,
      started: false,
      error: startupError(stderr, r.code),
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

  const r = await awaitStartup(waitForSocket, socketPath, onExit);
  if (r.up) return { ok: true, started: true, pid: child.pid };
  // Timed out with the child still alive (it never served a socket): kill it
  // rather than leak a process and then block forever awaiting its exit.
  if (r.code === null) child.kill("SIGTERM");
  return { ok: false, started: false, error: startupError(stderr, r.code) };
}

/** The failure message when a run never serves a socket — the run's own
 *  stderr when it died, else a code- or timeout-flavored explanation. */
function startupError(stderr: string, code: number | null): string {
  const trimmed = stderr.trim();
  if (trimmed !== "") return trimmed;
  return code === null
    ? "odu run did not serve a socket within the startup window"
    : `odu run exited ${code} before serving a socket`;
}
