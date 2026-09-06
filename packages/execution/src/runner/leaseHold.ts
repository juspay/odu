/**
 * Venue lock held *inside* the odu-runner agent process.
 *
 * The coordinator never runs flock over raw ssh. It dials this agent via
 * surface-remote and calls `lease.claim` / `lease.probe` / `lease.release`.
 * Flock comes from odu-runner's Nix-wrapped PATH (`util-linux`), so builders
 * do not need a system-installed flock.
 *
 * Hold model: a child `flock -n -x <lock> -c '…; cat'` keeps the exclusive
 * lock while its stdin stays open. Release closes stdin (and kills the child);
 * agent process death drops the ssh pipe → child dies → flock frees.
 *
 * Box-side dead-man (juspay/odu#54): half-open TCP never EOFs the agent, so
 * the flock would stick until remote sshd times out (~2h). While holding we
 * treat any inbound stdio activity (including ownership probes) as a pulse;
 * ~45s without a pulse releases the flock and exits.
 * Max-hold (default 1h, `ODU_LEASE_MAX_HOLD_MS`) self-releases forgotten holds.
 * No separate `lease.beat` — normal RPC traffic and ownership probes pulse it.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { shellQuoteArg } from "@kolu/shell-quote";
import { DEFAULT_LEASE_LOCK, type LeaseHolder } from "../common/laneSurface";

/** Idle without inbound activity before the hold self-releases (ms). */
export function deadManMs(): number {
  return envNumber("ODU_LEASE_DEAD_MAN_MS", 45_000, 1_000);
}

/** Absolute hold ceiling (ms). Default 1h; `0` = unlimited. */
export function maxHoldMs(): number {
  return envNumber("ODU_LEASE_MAX_HOLD_MS", 3_600_000, 0);
}

function envNumber(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function agentLeaseLockPath(override?: string): string {
  if (override !== undefined && override !== "") return override;
  const fromEnv = process.env.ODU_LEASE_LOCK;
  return fromEnv !== undefined && fromEnv !== ""
    ? fromEnv
    : DEFAULT_LEASE_LOCK;
}

export function parseHolderBody(body: string): LeaseHolder | null {
  const line = body.trim().split("\n")[0]?.trim() ?? "";
  if (line === "") return null;
  const parts = line.split("|");
  if (parts.length >= 3) {
    const holder = parts[0] ?? "";
    const runRaw = parts[1] ?? "";
    const since = Number(parts[2]);
    if (holder === "" || !Number.isFinite(since)) return null;
    return {
      holder,
      run: runRaw === "" || runRaw === "-" ? null : runRaw,
      sinceMs: since,
    };
  }
  return { holder: line, run: null, sinceMs: Date.now() };
}

function readHolderFile(lockPath: string): LeaseHolder | null {
  const path = `${lockPath}.holder`;
  if (!existsSync(path)) return null;
  try {
    return parseHolderBody(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function flockMissingError(): string {
  return "flock(1) missing on agent PATH — odu-runner must ship util-linux";
}

/** Non-blocking probe; never holds. */
export function probeLocal(
  lockPath: string,
):
  | { state: "free"; heldBy: null }
  | { state: "busy"; heldBy: LeaseHolder | null }
  | { state: "error"; error: string } {
  const r = spawnSync("flock", ["-n", lockPath, "-c", "true"], {
    encoding: "utf8",
  });
  if (r.error !== undefined) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { state: "error", error: flockMissingError() };
    }
    return { state: "error", error: r.error.message };
  }
  if (r.status === 0) {
    return { state: "free", heldBy: null };
  }
  return { state: "busy", heldBy: readHolderFile(lockPath) };
}

export interface LocalHold {
  /** The one lock this child actually owns. */
  readonly lockPath: string;
  /** Stable identity written beside the lock when it was acquired. */
  readonly heldBy: LeaseHolder;
  /** False after explicit release, self-release, or unexpected child exit. */
  isHeld: () => boolean;
  /**
   * Answer an ownership probe for this hold without forking `flock`.
   * `null` means this hold cannot answer (different path or no longer held).
   */
  probe: (
    lockPath: string,
  ) => { state: "busy"; heldBy: LeaseHolder } | null;
  release: () => void;
  /** Mark inbound activity (RPC / stdio pulse) for the dead-man timer. */
  noteActivity: () => void;
}

export interface ClaimLocalOpts {
  nowMs?: number;
  settleTimeoutMs?: number;
  /** Injected clock for tests. */
  now?: () => number;
  /** Injected timers for tests. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  deadManMs?: number;
  maxHoldMs?: number;
  /** Called when dead-man or max-hold fires (after release). */
  onSelfRelease?: (reason: "dead-man" | "max-hold" | "hold-exit") => void;
}

/**
 * Non-blocking claim. On success, keeps a child flock session until
 * `release()` or dead-man / max-hold self-release.
 */
export async function claimLocal(
  lockPath: string,
  identity: { holder: string; run: string | null },
  opts: ClaimLocalOpts = {},
): Promise<
  | { status: "held"; hold: LocalHold }
  | { status: "busy"; heldBy: LeaseHolder | null }
  | { status: "error"; error: string }
> {
  const nowMs = opts.nowMs ?? (opts.now?.() ?? Date.now());
  const settleTimeoutMs = opts.settleTimeoutMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const setInt = opts.setIntervalFn ?? setInterval;
  const clearInt = opts.clearIntervalFn ?? clearInterval;
  const deadMs = opts.deadManMs ?? deadManMs();
  const maxMs = opts.maxHoldMs ?? maxHoldMs();

  const holderFile = `${lockPath}.holder`;
  const run = identity.run ?? "-";
  const body = `${identity.holder}|${run}|${nowMs}`;
  const cmd = [
    `printf '%s\\n' ${shellQuoteArg(body)} > ${shellQuoteArg(holderFile)}`,
    `printf 'READY\\n'`,
    `cat`,
    `rm -f ${shellQuoteArg(holderFile)}`,
  ].join(" && ");

  let child: ChildProcess;
  try {
    child = spawn("flock", ["-n", "-x", lockPath, "-c", cmd], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return { status: "error", error: flockMissingError() };
    }
    return { status: "error", error: err.message ?? String(e) };
  }

  const settle = await settleClaimChild(child, settleTimeoutMs);
  if (settle.kind === "ready") {
    let released = false;
    let lastActivity = now();
    const heldSince = now();
    const heldBy: LeaseHolder = {
      holder: identity.holder,
      run: identity.run,
      sinceMs: nowMs,
    };

    const doRelease = (): void => {
      if (released) return;
      released = true;
      clearInt(watch);
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
      setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM");
      }, 500).unref?.();
      try {
        unlinkSync(holderFile);
      } catch {
        /* child may have removed it */
      }
    };

    const watch = setInt(() => {
      if (released) return;
      const t = now();
      if (maxMs > 0 && t - heldSince >= maxMs) {
        doRelease();
        opts.onSelfRelease?.("max-hold");
        return;
      }
      if (t - lastActivity >= deadMs) {
        doRelease();
        opts.onSelfRelease?.("dead-man");
      }
    }, Math.min(5_000, deadMs, maxMs > 0 ? maxMs : deadMs));
    watch.unref?.();

    // A direct child failure is ownership loss even though the runner itself
    // is still alive. Surface that through the same teardown path as the two
    // timers; otherwise an in-process self probe could report a dead hold as
    // healthy until an external flock probe happened to run.
    child.once("close", () => {
      if (released) return;
      released = true;
      clearInt(watch);
      try {
        unlinkSync(holderFile);
      } catch {
        /* child may have removed it */
      }
      opts.onSelfRelease?.("hold-exit");
    });

    return {
      status: "held",
      hold: {
        lockPath,
        heldBy,
        isHeld: () => !released,
        probe: (requestedPath) => {
          if (released || requestedPath !== lockPath) return null;
          lastActivity = now();
          return { state: "busy", heldBy };
        },
        release: doRelease,
        noteActivity: () => {
          lastActivity = now();
        },
      },
    };
  }

  try {
    if (!child.killed) child.kill("SIGTERM");
  } catch {
    /* ignore */
  }

  if (settle.kind === "enoent") {
    return { status: "error", error: flockMissingError() };
  }
  if (settle.kind === "busy") {
    return { status: "busy", heldBy: readHolderFile(lockPath) };
  }
  if (settle.kind === "error") {
    return { status: "error", error: settle.message };
  }
  return {
    status: "error",
    error: "lease claim timed out waiting for flock hold",
  };
}

type Settle =
  | { kind: "ready" }
  | { kind: "busy" }
  | { kind: "enoent" }
  | { kind: "error"; message: string }
  | { kind: "timeout" };

function settleClaimChild(
  child: ChildProcess,
  timeoutMs: number,
): Promise<Settle> {
  return new Promise((resolve) => {
    let done = false;
    let stdout = "";
    const finish = (s: Settle): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(s);
    };

    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (/\bREADY\b/.test(stdout)) finish({ kind: "ready" });
    });

    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") finish({ kind: "enoent" });
      else finish({ kind: "error", message: e.message });
    });

    child.on("close", (code) => {
      if (code === 0) {
        finish({
          kind: "error",
          message: "flock hold exited before READY",
        });
        return;
      }
      finish({ kind: "busy" });
    });
  });
}
