/**
 * The `run` bespoke MCP tool — spawn-and-await.
 *
 * `run` is genuinely call-shaped (it spawns a background `odu run` process and
 * blocks until that run's coordinator is serving its socket), so it can't be
 * an exposed surface procedure — it composes over the *process*, not the live
 * client. It rides `@kolu/surface-mcp`'s bespoke-tool slot: a zod `input`, a
 * `handler`, and the `mutates` flag, sharing the package's zod→JSON-Schema +
 * result-framing + signal spine.
 *
 * The spawn machinery (startup polling, child reaping) is migrated wholesale
 * from the old hand-built `src/mcp/tools.ts`.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { BespokeTool } from "@kolu/surface-mcp";
import { type CancelResult, cancelRun } from "../coordinator/cancel";
import {
  liveRunLockPid,
  signalRunLockHolder,
  waitForRunLockFree,
} from "../coordinator/checkoutLock";
import { SOCKET_PATH, tryDialSocket } from "../coordinator/socket";

export const runInput = z.object({
  selectors: z.array(z.string()).optional(),
  platforms: z.array(z.string()).optional(),
  /** `PLATFORM=ADDR` host pins, one per platform (mirrors `odu run --host`). */
  hosts: z.array(z.string()).optional(),
  root: z.string().optional(),
  no_strict: z.boolean().optional(),
  no_snapshot: z.boolean().optional(),
  no_post: z.boolean().optional(),
  /** Cancel a run already live in this checkout and start fresh, instead of
   *  refusing — the "stop this, run the fixed commit" move after a fail-fast. */
  supersede: z.boolean().optional(),
  /** Keep the coordinator alive after the run drains so a node can be rerun
   *  post-settle; call `cancel` (or `run` with supersede) when done. */
  linger: z.boolean().optional(),
  /** Fail immediately when every host in a platform's pool is busy, instead of
   *  waiting in line (mirrors `odu run --no-wait`). */
  no_wait: z.boolean().optional(),
});
export type RunInput = z.infer<typeof runInput>;

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
    d?.close();
    return d !== null;
  };
  return pollUntilSocketOrExit(serving, exited);
}

/** Bring the run up. The wait stops the instant the child dies (a dirty-tree
 *  refusal, a missing `tsx`, or a bad justfile kills it early), so a failed
 *  run is reported at once. While the child lives we keep polling — lease
 *  queue time is unbounded. The socket coming up always wins — a clean run can
 *  fork a detached coordinator and let the launcher exit. */
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
    if (existing !== null) existing.close();
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
  const child = spawn(cmd, [...prefix, ...args], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
    env: process.env,
  });
  liveRuns.add(child);
  // Cap stderr to 64KB so a verbose child process can't grow this unboundedly.
  const MAX_STDERR = 64 * 1024;
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => {
    stderr = (stderr + c.toString("utf-8")).slice(-MAX_STDERR);
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
  // Wait is exit-bounded under `defaultWaitForSocket`. If a custom wait gives
  // up while the child still lives (or exit races), do NOT SIGTERM — a healthy
  // lease waiter (juspay/odu#54) must keep its place in line; killing it was
  // the prior ~60s startup-window regression.
  return { ok: false, started: false, error: startupError(stderr, r.code) };
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
  handler: (args) => startRun(args as RunInput),
};
