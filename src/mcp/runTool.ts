/**
 * The `run` bespoke MCP tool — spawn-and-await.
 *
 * `run` is genuinely call-shaped (it spawns a background `odu run` process and
 * blocks until that run's coordinator is serving its socket), so it can't be
 * an exposed surface procedure — it composes over the *process*, not the live
 * client. It rides `@kolu/surface-mcp`'s bespoke-tool slot: an Effect Schema
 * `input`, a `handler`, and the `mutates` flag, sharing the package's
 * result-framing + signal spine.
 *
 * The spawn machinery (startup polling, child reaping) is migrated wholesale
 * from the old hand-built `src/mcp/tools.ts`.
 */

import { spawn } from "node:child_process";
import {
  createWriteStream,
  mkdirSync,
  type WriteStream,
} from "node:fs";
import { dirname, join } from "node:path";
import { firstFrame } from "../common/effectEdge";
import { Effect, Schema } from "effect";
import type { BespokeTool } from "@kolu/surface-mcp";
import { type CancelResult, cancelRun } from "../coordinator/cancel";
import {
  liveRunLockPid,
  signalRunLockHolder,
  waitForRunLockFree,
} from "../coordinator/checkoutLock";
import { SOCKET_PATH, tryDialSocket } from "../coordinator/socket";

export const runInput = Schema.Struct({
  selectors: Schema.optionalKey(Schema.Array(Schema.String)),
  platforms: Schema.optionalKey(Schema.Array(Schema.String)),
  /** `PLATFORM=ADDR` host pins, one per platform (mirrors `odu run --host`). */
  hosts: Schema.optionalKey(Schema.Array(Schema.String)),
  root: Schema.optionalKey(Schema.String),
  no_strict: Schema.optionalKey(Schema.Boolean),
  no_snapshot: Schema.optionalKey(Schema.Boolean),
  no_post: Schema.optionalKey(Schema.Boolean),
  /** Cancel a run already live in this checkout and start fresh, instead of
   *  refusing — the "stop this, run the fixed commit" move after a fail-fast. */
  supersede: Schema.optionalKey(Schema.Boolean),
  /** Keep the coordinator alive after the run drains so a node can be rerun
   *  post-settle; call `cancel` (or `run` with supersede) when done. */
  linger: Schema.optionalKey(Schema.Boolean),
  /** Fail immediately when every host in a platform's pool is busy, instead of
   *  waiting in line (mirrors `odu run --no-wait`). */
  no_wait: Schema.optionalKey(Schema.Boolean),
});
export type RunInput = typeof runInput.Type;

export interface RunResult {
  ok: boolean;
  started: boolean;
  pid?: number;
  error?: string;
}

/** The argv prefix that re-invokes the odu CLI. The nix wrapper bakes
 *  `ODU_SELF` to its own store path; in a dev checkout we re-exec the entry
 *  through the very bun that is running us (`process.execPath`), so the child
 *  gets this exact runtime rather than whatever a bare `bun` on its PATH
 *  resolves to. */
export function oduSelfArgv(): string[] {
  const self = process.env.ODU_SELF;
  if (self !== undefined && self !== "") return [self];
  const entry = process.argv[1];
  return entry !== undefined
    ? [process.execPath, entry]
    : [process.execPath];
}

function runArgsFrom(input: RunInput): string[] {
  const args = ["run", ...(input.selectors ?? [])];
  for (const p of input.platforms ?? []) args.push("--platform", p);
  for (const h of input.hosts ?? []) args.push("--host", h);
  if (input.root !== undefined) args.push("--root", input.root);
  if (input.no_strict) args.push("--no-strict");
  if (input.no_snapshot) args.push("--no-snapshot");
  if (input.no_post) args.push("--no-post");
  if (input.linger) args.push("--linger");
  if (input.no_wait) args.push("--no-wait");
  // `supersede` is handled here in `startRun` (cancel the live run, confirm
  // it's gone, then spawn), so the spawned coordinator binds a free lock and
  // never needs the flag — and `awaitStartup` can't mistake the dying run's
  // socket for the new one.
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
  /** Injected for tests; defaults to `cancelRun`. Used to supersede a run
   *  already live in this checkout (cancel it + confirm its socket is gone). */
  cancelExisting?: (socketPath: string) => Promise<CancelResult>;
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

/**
 * Poll until the coordinator socket answers or the child exits.
 *
 * No fixed startup window: venue-lease wait-in-line (juspay/odu#54) can exceed
 * minutes while the child is healthy and has not yet served `.ci/odu.sock`
 * (`leaseLanes` runs before `serveSocket`). Bounding the poll and SIGTERM-ing
 * a still-alive waiter was a regression vs pre-lease spawn. Child exit is the
 * only failure bound — a dirty-tree refusal / bad justfile dies immediately.
 *
 * Exported for unit tests of the exit-bounded policy.
 */
export async function pollUntilSocketOrExit(
  ready: () => Promise<boolean>,
  exited: Promise<unknown>,
  intervalMs = 250,
): Promise<boolean> {
  // A flag the exit promise flips; the loop does one final probe after it so a
  // detached coordinator that came up as the launcher exited still counts.
  let done = false;
  void exited.then(() => {
    done = true;
  });
  for (;;) {
    if (await ready()) return true;
    if (done) {
      // Child has exited — one last probe, then give up rather than poll on.
      return ready();
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function defaultWaitForSocket(
  socketPath: string,
  exited: Promise<unknown>,
): Promise<boolean> {
  // Probe the socket and release the probe connection at once — we only want
  // to know it answers, not to hold it open.
  const serving = async (): Promise<boolean> => {
    const d = await tryDialSocket(socketPath);
    await d?.close();
    return d !== null;
  };
  return pollUntilSocketOrExit(serving, exited);
}

/** Bring the run up. The wait stops the instant the child dies (a dirty-tree
 *  refusal, an odu entry bun can't load, or a bad justfile kills it early), so
 *  a failed run is reported at once. While the child lives we keep polling —
 *  lease queue time is unbounded. The socket coming up always wins — a clean
 *  run can fork a detached coordinator and let the launcher exit. */
async function awaitStartup(
  waitForSocket: (s: string, exited: Promise<unknown>) => Promise<boolean>,
  socketPath: string,
  onExit: Promise<number>,
): Promise<{ up: true } | { up: false; code: number | null }> {
  // `exitCode` is null until the child exits; non-null means "has exited with
  // this code", so both the sentinel and the value live in one variable.
  let exitCode: number | null = null;
  const exitGuard = onExit.then((code) => {
    exitCode = code;
  });
  const up = await waitForSocket(socketPath, exitGuard);
  if (up) return { up: true };
  // Not up. If the child has already exited (or is about to in this tick),
  // capture its code so we report it; never block on a still-alive child.
  await Promise.race([exitGuard, Promise.resolve()]);
  return { up: false, code: exitCode };
}

/** `run` — start a pipeline the agent can then watch and drive. Spawns a
 *  background `odu run` (its own coordinator owning `.ci/odu.sock`) and returns
 *  once the socket is live, so a following `wait_for_settle` / `nodes` read /
 *  resource subscribe attaches to it. One run per checkout: a live socket *or*
 *  a held run-lock (lease wait before the socket serves) means a run is already
 *  in progress, so we refuse rather than co-queue on the venue pool. */
export async function startRun(
  input: RunInput,
  deps: SpawnDeps = {},
): Promise<RunResult> {
  const socketPath = deps.socketPath ?? SOCKET_PATH;
  // Sibling of the socket (`.ci/odu.run.lock`); absolute when socketPath is.
  const lockPath = join(dirname(socketPath), "odu.run.lock");

  const existing = await tryDialSocket(socketPath);
  const busy = existing !== null || liveRunLockPid(lockPath) !== null;

  if (busy) {
    if (existing !== null) await existing.close();
    if (!input.supersede) {
      return {
        ok: false,
        started: false,
        error:
          "a run is already in progress in this checkout " +
          "(pass supersede to cancel it and start fresh)",
      };
    }
    // Supersede: cancel via socket when up; always clear a lease-waiting
    // holder that never reached serveSocket (SIGTERM on the run-lock PID).
    const supersedeTimeout = {
      ok: false as const,
      started: false as const,
      error: "supersede: the existing run did not shut down in time",
    };
    if (existing !== null) {
      const cancel = deps.cancelExisting ?? cancelRun;
      const result = await cancel(socketPath);
      if (!result.confirmed) return supersedeTimeout;
    }
    if (liveRunLockPid(lockPath) !== null) {
      signalRunLockHolder(lockPath, "SIGTERM");
      if (!(await waitForRunLockFree(lockPath))) return supersedeTimeout;
    }
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
  // Tee stdout+stderr to the durable run log once the coordinator publishes
  // sha7/seq (juspay/odu#61); keep an in-memory tail for startup-error reporting.
  const child = spawn(cmd, [...prefix, ...args], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  liveRuns.add(child);
  // Cap the in-memory startup tail and the pre-open tee buffer so a verbose
  // child (or a failed openRunLog) can't grow this unboundedly.
  const MAX_STDERR = 64 * 1024;
  const MAX_PREOPEN = 64 * 1024;
  let stderr = "";
  const preOpen: Buffer[] = [];
  let preOpenBytes = 0;
  /** Once true, stop buffering into preOpen (stream open failed or cap hit). */
  let stopPreOpen = false;
  let logStream: WriteStream | null = null;
  const onChunk = (c: Buffer): void => {
    stderr = (stderr + c.toString("utf-8")).slice(-MAX_STDERR);
    if (logStream !== null) {
      logStream.write(c);
      return;
    }
    if (stopPreOpen) return;
    preOpenBytes = appendPreOpen(preOpen, c, MAX_PREOPEN, preOpenBytes);
    if (preOpenBytes >= MAX_PREOPEN) stopPreOpen = true;
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  const onExit = new Promise<number>((resolve) => {
    child.on("exit", (code) => {
      liveRuns.delete(child);
      logStream?.end();
      resolve(code ?? -1);
    });
    child.on("error", () => {
      liveRuns.delete(child);
      logStream?.end();
      resolve(-1);
    });
  });

  const r = await awaitStartup(waitForSocket, socketPath, onExit);
  if (r.up) {
    // Open `.ci/<sha7>/runs/<seq>.log` from the live surface identity and flush
    // the buffered startup output into it; further chunks stream in live.
    void openRunLog(socketPath).then((stream) => {
      if (stream === null) {
        // Durable log unavailable — drop the buffer; keep the 64KB startup tail.
        preOpen.length = 0;
        preOpenBytes = 0;
        stopPreOpen = true;
        return;
      }
      for (const chunk of preOpen) stream.write(chunk);
      preOpen.length = 0;
      preOpenBytes = 0;
      logStream = stream;
    });
    return { ok: true, started: true, pid: child.pid };
  }
  // Wait is exit-bounded under `defaultWaitForSocket`. If a custom wait gives
  // up while the child still lives (or exit races), do NOT SIGTERM — a healthy
  // lease waiter (juspay/odu#54) must keep its place in line; killing it was
  // the prior ~60s startup-window regression.
  return { ok: false, started: false, error: startupError(stderr, r.code) };
}

/**
 * Append `chunk` to a pre-open buffer capped at `maxBytes`. Returns the new
 * total byte count (never above maxBytes). Exported for unit tests.
 */
export function appendPreOpen(
  chunks: Buffer[],
  chunk: Buffer,
  maxBytes: number,
  currentBytes: number,
): number {
  if (currentBytes >= maxBytes) return currentBytes;
  const room = maxBytes - currentBytes;
  if (chunk.length <= room) {
    chunks.push(chunk);
    return currentBytes + chunk.length;
  }
  chunks.push(chunk.subarray(0, room));
  return maxBytes;
}

/** Dial the live coordinator for sha7/seq and open the durable run log path.
 *  Best-effort: null when identity is missing or dial fails. */
export async function openRunLog(
  socketPath: string,
): Promise<WriteStream | null> {
  const dialed = await tryDialSocket(socketPath);
  if (dialed === null) return null;
  try {
    // ONE frame, then done. `firstFrame` ends the stream, which releases the
    // subscription through its own finalizers — the socket below is closed
    // right after, and a held-open `get` would have outlived it.
    const state = await firstFrame(dialed.client.surface.nodes.get(undefined));
    const sha7 = state?.sha7 ?? "";
    const seq = state?.seq;
    if (sha7 === "" || seq === undefined) return null;
    const dir = join(dirname(socketPath), sha7, "runs");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${seq}.log`);
    return createWriteStream(path, { flags: "a" });
  } catch {
    // Best-effort durable log only: dial/identity/fs failures must not fail the
    // run tool — the agent still gets live surface frames without a disk tee.
    return null;
  } finally {
    await dialed.close();
  }
}

/** The failure message when a run never serves a socket — the run's own
 *  stderr when it died, else a code- or wait-flavored explanation. */
function startupError(stderr: string, code: number | null): string {
  const trimmed = stderr.trim();
  if (trimmed !== "") return trimmed;
  return code === null
    ? "odu run did not serve a socket before the wait ended (child still running)"
    : `odu run exited ${code} before serving a socket`;
}

/** The `run` bespoke tool — spawn-and-await a background run. Mutating: it
 *  starts a process and acquires the checkout's run lock. Typed as the loose
 *  `BespokeTool` (the package's `tools` slot is `Record<string, BespokeTool>`,
 *  invariant in the input type); `input` validates and the handler narrows. */
export const runTool: BespokeTool = {
  description:
    "Start a CI run the agent can then watch and drive. Spawns a background " +
    "`odu run` (its own coordinator) and returns once the run is live. Strict " +
    "by default (refuses a dirty tree); pass no_strict for a dev-iteration run " +
    "against the working tree. One run per checkout.",
  input: runInput,
  mutates: true,
  handler: (args) => Effect.promise(() => startRun(args as RunInput)),
};
