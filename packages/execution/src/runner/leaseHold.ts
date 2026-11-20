/**
 * Hold model: a child `flock -n -x <lock> -c '…; cat'` keeps the exclusive
 * lock while its stdin stays open. Release closes stdin (and kills the child);
 * agent process death drops the ssh pipe → child dies → flock frees.
 *
 * Box-side dead-man (juspay/odu#54): half-open TCP never EOFs the agent, so
 * the flock would stick until remote sshd times out (~2h). While holding we
 * treat any inbound stdio activity (including ownership probes) as a pulse;
 * ~45s without a pulse releases the flock and exits.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { shellQuoteArg } from "@kolu/shell-quote";
import { DEFAULT_LEASE_LOCK, type LeaseHolder } from "../common/laneSurface";

export function deadManMs(): number {
  return envNumber("ODU_LEASE_DEAD_MAN_MS", 45_000, 1_000);
}

export function maxHoldMs(): number | null {
  const configured = envNumber("ODU_LEASE_MAX_HOLD_MS", 3_600_000, 0);
  return configured === 0 ? null : configured;
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
  readonly lockPath: string;
  readonly heldBy: LeaseHolder;
  isHeld: () => boolean;
  probe: (
    lockPath: string,
  ) => { kind: "busy"; heldBy: LeaseHolder } | { kind: "not-mine" };
  release: () => void;
  noteActivity: () => void;
}

export interface Clock {
  now(): number;
  every(ms: number, tick: () => void): { stop(): void };
}

export const systemClock: Clock = {
  now: () => Date.now(),
  every: (ms, tick) => {
    const id = setInterval(tick, ms);
    id.unref?.();
    return {
      stop: () => {
        clearInterval(id);
      },
    };
  },
};

export interface ClaimLocalOpts {
  settleTimeoutMs?: number;
  clock?: Clock;
  deadManMs?: number;
  maxHoldMs?: number | null;
  onSelfRelease?: (reason: "dead-man" | "max-hold" | "hold-exit") => void;
}

export async function claimLocal(
  lockPath: string,
  identity: { holder: string; run: string | null },
  opts: ClaimLocalOpts = {},
): Promise<
  | { status: "held"; hold: LocalHold }
  | { status: "busy"; heldBy: LeaseHolder | null }
  | { status: "error"; error: string }
> {
  const clock = opts.clock ?? systemClock;
  const claimedMs = clock.now();
  const settleTimeoutMs = opts.settleTimeoutMs ?? 5_000;
  const deadMs = opts.deadManMs ?? deadManMs();
  const maxMs = opts.maxHoldMs === undefined ? maxHoldMs() : opts.maxHoldMs;

  const holderFile = `${lockPath}.holder`;
  const run = identity.run ?? "-";
  const body = `${identity.holder}|${run}|${claimedMs}`;
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
    let lastActivity = clock.now();
    const heldSince = clock.now();
    const heldBy: LeaseHolder = {
      holder: identity.holder,
      run: identity.run,
      sinceMs: claimedMs,
    };

    const doRelease = (): void => {
      if (released) return;
      released = true;
      watch.stop();
      try {
        child.stdin?.end();
      } catch {
      }
      setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM");
      }, 500).unref?.();
      try {
        unlinkSync(holderFile);
      } catch {
      }
    };

    const watch = clock.every(Math.min(5_000, deadMs, maxMs ?? deadMs), () => {
      if (released) return;
      const t = clock.now();
      if (maxMs !== null && t - heldSince >= maxMs) {
        doRelease();
        opts.onSelfRelease?.("max-hold");
        return;
      }
      if (t - lastActivity >= deadMs) {
        doRelease();
        opts.onSelfRelease?.("dead-man");
      }
    });

    const releaseOnHoldExit = (): void => {
      if (released) return;
      released = true;
      watch.stop();
      try {
        unlinkSync(holderFile);
      } catch {
      }
      opts.onSelfRelease?.("hold-exit");
    };

    child.once("close", releaseOnHoldExit);

    return {
      status: "held",
      hold: {
        lockPath,
        heldBy,
        isHeld: () => !released,
        probe: (requestedPath) => {
          if (released || requestedPath !== lockPath) return { kind: "not-mine" };
          lastActivity = clock.now();
          return { kind: "busy", heldBy };
        },
        release: doRelease,
        noteActivity: () => {
          lastActivity = clock.now();
        },
      },
    };
  }

  try {
    if (!child.killed) child.kill("SIGTERM");
  } catch {
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
