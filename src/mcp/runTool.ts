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
 * Two ownership rules make the spawn's whole contract:
 *
 *   - WHERE: the run is a function of its `checkout` — spawn cwd, socket,
 *     run-lock, durable logs all hang off the target checkout, and one live
 *     run per checkout is enforced per checkout (see ./checkout.ts).
 *   - WHO REAPS: nobody — within the lifetime of the host that ran it, and
 *     ONLY within it. A plain EXIT of this server (an agent harness replacing
 *     its `odu mcp`) reaps nothing: the spawn is detached, so the run is
 *     reparented and carries on. But the coordinator lives and dies with the
 *     process that started it — a restart of that host kills the run: the
 *     child sits in the host SERVICE's cgroup, and a service stop kills the
 *     cgroup, `detached` flag or not. There is deliberately no supervisor
 *     escaping that (no `systemd-run --scope`, no double-fork — the human's
 *     ruling, 2026-09-02): the limit is ADMITTED, and the corpse is reported
 *     (`@odu/run-client`'s `deadRun` — `runs` / `wait_for_settle` /
 *     `node_rerun` answer from it). The one hazard the survival half creates
 *     is a dead reader on the child's output pipes, and bun — the runtime
 *     every coordinator ships on — already swallows EPIPE on stdio writes
 *     (pinned by `src/mcp/spawnSurvival.test.ts`, so a runtime bump that
 *     changed it turns this sentence red).
 *   - WHAT'S DURABLE: the coordinator's own writes — the per-node logs
 *     (`.ci/<sha7>/<platform>/<node>.log`, the `logPathFor` spelling) and
 *     the ledger. NOT this server's convenience tee of coordinator
 *     stdout/stderr to `.ci/<sha7>/runs/<seq>.log` (`openRunLog` below):
 *     built from this process's pipe readers, it ends where the server
 *     ends, so a mid-run harness restart TRUNCATES it. Read it as what it
 *     is — MCP-session output capture, not the run's persistent log.
 *
 * The spawn machinery (startup polling, detached spawn) is migrated wholesale
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
import { dialRun, runSocketPath } from "@odu/run-client/dial";
import { type DeadRun, deadRun, describeDeadRun } from "@odu/run-client/deadRun";
import { type CancelResult, cancelRun } from "../coordinator/cancel";
import {
  liveRunLockPid,
  signalRunLockHolder,
  waitForRunLockFree,
} from "../coordinator/checkoutLock";
import { checkoutField, checkoutOf } from "./checkout";

export const runInput = Schema.Struct({
  checkout: checkoutField,
  selectors: Schema.optionalKey(Schema.Array(Schema.String)),
  platforms: Schema.optionalKey(Schema.Array(Schema.String)),
  /** `PLATFORM=ADDR` host pins, one per platform (mirrors `odu run --host`). */
  hosts: Schema.optionalKey(Schema.Array(Schema.String)),
  root: Schema.optionalKey(Schema.String),
  no_strict: Schema.optionalKey(Schema.Boolean),
  no_snapshot: Schema.optionalKey(Schema.Boolean),
  no_post: Schema.optionalKey(Schema.Boolean),
  /** Cancel a run already live in this checkout and start fresh, instead of
   *  refusing — the "stop this, run the fixed commit" move after a fail-fast.
   *
   *  `.annotate`, not this JSDoc, is what a host shows an agent about the
   *  argument — and the missing sentence is the one that matters: this
   *  DESTROYS the live run, every lane of it. An agent reading the tool surface
   *  found `supersede` described and `node_rerun` blank, and concluded it had
   *  to throw away a running darwin lane to retry a flaky linux one. */
  supersede: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Cancel the run already live in this checkout and start a new one. It " +
        "kills the WHOLE run — every platform lane, including the ones still " +
        "green and running — so use it to replace a run with a different " +
        "commit, never to retry a lane. To retry ONE failed or flaky lane on " +
        "the run that is still going, cancelling nothing, use `node_rerun`.",
    }),
  ),
  /** Keep the coordinator alive after the run drains so a node can be rerun
   *  post-settle; call `cancel` (or `run` with supersede) when done. */
  linger: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Keep the coordinator serving after the run drains, so `node_rerun` " +
        "still has a live run to rerun a node on once everything has settled " +
        "(retry a flake without re-running the pipeline). It self-reaps after " +
        "an idle period, or on `cancel`.",
    }),
  ),
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
  /** Present on a started run: the host-coupling the description states — the
   *  answer says it too, because "the run is live now" is exactly the moment
   *  an agent most needs to know the run dies if its host does. */
  coordinator_lifetime?: string;
  /** Present when this start replaced the corpse of a run that died with its
   *  host — says what of it this start cleared (and therefore why no
   *  `supersede` was asked for). */
  cleared?: string;
}

/** The admitted limit, once: the sentence the description, this module's
 *  header, the docs and every started run's answer all carry. */
export const COORDINATOR_LIFETIME =
  "The coordinator lives and dies with the process that started it — a " +
  "restart of that host kills the run.";

/** What a start OVER a corpse answers with — the death, and which parts of
 *  it the incoming coordinator reclaims (the dead run's reservation sentinel
 *  stays: it is the death's tombstone, and `runs` names the run by it). */
function clearedSentence(dead: DeadRun): string {
  const ref =
    dead.sha7 === ""
      ? "the previous run"
      : `the run ${dead.sha7}${dead.seq === null ? "" : `#${dead.seq}`}`;
  return (
    `started over ${ref}, which died with its host (${describeDeadRun(dead)}) ` +
    "— the incoming coordinator reclaims the stale run lock and socket; no " +
    "`supersede` was needed, a corpse holds nothing."
  );
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

/** Children spawned by `run`, kept referenced so V8 doesn't collect the
 *  handle mid-run (unref'd handles still fire their `exit` in this process).
 *  Deliberately NEVER reaped by the server: a spawned coordinator outlives a
 *  plain EXIT of `odu mcp` by design — an agent harness restarts its MCP
 *  server freely, and that must not kill a run. (Outliving the HOST is NOT
 *  promised — the coordinator lives and dies with the process that started
 *  it; see the header's WHO REAPS.) The once-existing `killRuns()` reaping
 *  on server close is what prevented exactly the exit-survival. */
const liveRuns = new Set<ReturnType<typeof spawn>>();

export interface SpawnDeps {
  socketPath?: string;
  /** Injected for tests; defaults to `cancelRun`. Used to supersede a run
   *  already live in this checkout (cancel it + confirm its socket is gone). */
  cancelExisting?: (socketPath: string) => Promise<CancelResult>;
  /** Injected for tests; defaults to spawning the real odu CLI. Receives the
   *  effective checkout so the spawn's `cwd` is asserted, not assumed. */
  spawnRun?: (
    args: string[],
    checkout: string,
  ) => { stderr: string; onExit: Promise<number> };
  /** Poll the socket until it answers (or `exited` resolves); injected for
   *  tests. The default stops early the instant the child dies so a failed run
   *  is reported at once, not after the whole poll window. */
  waitForSocket?: (
    socketPath: string,
    exited: Promise<unknown>,
  ) => Promise<boolean>;
}

/** The spawn options that make a coordinator outlive its LAUNCHER'S plain
 *  exit: its own process group (`detached`) so no signal addressed to the
 *  server ever reaches it by group, and pipes for stdout/stderr so this
 *  server tees the durable run log while it lives — pipes whose death the
 *  bun runtime tolerates natively (EPIPE on stdio never becomes an
 *  uncaughtException; `spawnSurvival.test.ts` pins the whole property). The
 *  caller `unref()`s the handle so the server can exit without waiting.
 *  "Launcher's plain exit" is the whole promise: a service stop kills the
 *  host's whole cgroup, and no spawn flag shields against that — the limit
 *  is the header's WHO REAPS. */
export function coordinatorSpawnSpec(checkout: string): {
  cwd: string;
  stdio: ["ignore", "pipe", "pipe"];
  env: NodeJS.ProcessEnv;
  detached: boolean;
} {
  return { cwd: checkout, stdio: ["ignore", "pipe", "pipe"], env: process.env, detached: true };
}

/**
 * Poll until the coordinator socket answers or the child exits.
 *
 * No fixed startup window. The socket now comes up before the venue claim
 * (juspay/odu#84), so the poll is normally short — but the startup ahead of it
 * (strict gate, `just` DAG ingest, seq reservation) is still unbounded work on a
 * loaded machine, and bounding the poll to SIGTERM a healthy child was a
 * regression once before (juspay/odu#54's lease wait). Child exit is the only
 * failure bound — a dirty-tree refusal / bad justfile dies immediately.
 *
 * A run that returns here is live but may still be PROVISIONING: `wait_for_settle`
 * blocks on it correctly (its nodes are seeded pending), and a claim that fails
 * lands as a red `_ci-setup@<platform>` rather than as this call's error.
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
    const d = await dialRun(socketPath);
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
  const checkout = checkoutOf(input);
  // The run's rendezvous is a function of the TARGET checkout: one live run
  // (socket or run-lock) per checkout so concurrent runs in DIFFERENT
  // checkouts never collide.
  const socketPath = deps.socketPath ?? runSocketPath(checkout);
  // Sibling of the socket (`.ci/odu.run.lock`); absolute when socketPath is.
  const lockPath = join(dirname(socketPath), "odu.run.lock");

  const existing = await dialRun(socketPath);
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

  // Not busy — but is the checkout's `.ci` the CORPSE of a run that died
  // with its host? Starting over it works BECAUSE a corpse holds nothing
  // (the child reclaims the stale socket, the lock's dead PID frees it) —
  // no `supersede` asked for; the answer then says what it cleared, instead
  // of letting the agent believe it started on clean ground.
  const dead = await deadRun(checkout, { socketPath, lockPath });
  const cleared = dead === null ? undefined : clearedSentence(dead);

  const waitForSocket = deps.waitForSocket ?? defaultWaitForSocket;

  if (deps.spawnRun !== undefined) {
    const { stderr, onExit } = deps.spawnRun(args, checkout);
    const r = await awaitStartup(waitForSocket, socketPath, onExit);
    if (r.up) {
      return {
        ok: true,
        started: true,
        coordinator_lifetime: COORDINATOR_LIFETIME,
        ...(cleared === undefined ? {} : { cleared }),
      };
    }
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
  // Tee stdout+stderr to the run log once the coordinator publishes sha7/seq
  // (juspay/odu#61) — THIS server's capture, truncated when it exits (see the
  // header's WHAT'S DURABLE); the coordinator's per-node logs are the ones
  // that persist. Keep an in-memory tail for startup-error reporting.
  const child = spawn(cmd, [...prefix, ...args], coordinatorSpawnSpec(checkout));
  child.unref();
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
    return {
      ok: true,
      started: true,
      pid: child.pid,
      coordinator_lifetime: COORDINATOR_LIFETIME,
      ...(cleared === undefined ? {} : { cleared }),
    };
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

/** Dial the live coordinator for sha7/seq and open the run log path
 *  (`.ci/<sha7>/runs/<seq>.log`) — the MCP server's stdout/stderr tee, not a
 *  coordinator artifact: it ends where the server ends. Best-effort: null
 *  when identity is missing or dial fails. */
export async function openRunLog(
  socketPath: string,
): Promise<WriteStream | null> {
  const dialed = await dialRun(socketPath);
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
    "`odu run` with its own coordinator and returns once the run is live. " +
    "The coordinator lives and dies with the process that started it — a " +
    "restart of that host kills the run: the spawn is detached, so a plain " +
    "EXIT of this MCP server (an agent harness restarting it) reaps nothing, " +
    "but there is no supervisor — a service stop kills the host's whole " +
    "cgroup and the run dies with it, mid-flight, leaving its stale lock, " +
    "socket and unfinalized reservation in `.ci` (" +
    "`runs` / `wait_for_settle` / `node_rerun` then NAME the death rather " +
    "than answering as if it never ran, and starting a new run over the " +
    "residue works without `supersede`). " +
    "Targets `checkout` — another tree's run is started by naming it; default " +
    "is this server's own working directory. Strict " +
    "by default (refuses a dirty tree); pass no_strict for a dev-iteration run " +
    "against the working tree. One run per checkout — so with a run already " +
    "live this refuses unless you pass `supersede`, which CANCELS that run and " +
    "every lane of it. Retrying one failed or flaky lane is NOT that: use " +
    "`node_rerun`, which re-runs a single node on the still-live run alongside " +
    "its siblings and cancels nothing. Supersede is for replacing a run with a " +
    "different commit.",
  input: runInput,
  mutates: true,
  handler: (args) => Effect.promise(() => startRun(args as RunInput)),
};
