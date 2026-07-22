/**
 * Checkout run-lock — exclusivity for the whole coordinator lifetime, including
 * the unbounded venue-lease wait that precedes `.ci/odu.sock`.
 *
 * `serveSocket` remains the attach surface and a second exclusivity gate, but
 * it only comes up after `leaseLanes`. Without this earlier lock, concurrent
 * `odu run` / MCP `run` starters all see no socket, each reserve a seq, and
 * co-queue on the venue pool (wasted sibling hosts, or accidental serial
 * double-CI on a single-host pool).
 *
 * Mechanism: exclusive create (`O_EXCL`) of a PID file under `.ci/`. Held open
 * for the process lifetime; released on `release()` / process exit. A dead
 * holder's file is treated as free (signal-0 liveness). Pure Node — no local
 * `flock(1)` dependency (macOS coordinators may not have util-linux).
 */

import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** Checkout-scoped path next to `.ci/odu.sock`. */
export const RUN_LOCK_PATH = ".ci/odu.run.lock";

export interface RunLockHandle {
  readonly path: string;
  readonly pid: number;
  /** Drop the lock (unlink). Idempotent. */
  release(): void;
}

function readLockPid(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** PID of a live process holding `lockPath`, or `null` if free / stale. */
export function liveRunLockPid(lockPath: string): number | null {
  const pid = readLockPid(lockPath);
  if (pid === null) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/**
 * Non-blocking exclusive acquire. Returns `null` when another live process
 * holds the lock (or an uncontended race lost on `O_EXCL`).
 */
export function tryAcquireRunLock(lockPath: string): RunLockHandle | null {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  const holder = liveRunLockPid(lockPath);
  if (holder !== null) return null;

  // Stale file from a crashed coordinator — clear before exclusive create.
  try {
    unlinkSync(lockPath);
  } catch {
    // absent is fine
  }

  let fd: number;
  try {
    fd = openSync(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
  } catch {
    // Lost the create race, or filesystem refused — treat as held.
    return null;
  }

  try {
    writeSync(fd, `${process.pid}\n`);
  } catch {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
    return null;
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    // Only unlink if we still own the file (pid matches). A superseder may
    // have already replaced it after killing us.
    if (readLockPid(lockPath) === process.pid) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
  };

  process.once("exit", release);
  return { path: lockPath, pid: process.pid, release };
}

/**
 * Ask a live lock holder to stop (SIGTERM). No-op when free/stale.
 * Returns the pid signaled, or null.
 */
export function signalRunLockHolder(
  lockPath: string,
  signal: NodeJS.Signals = "SIGTERM",
): number | null {
  const pid = liveRunLockPid(lockPath);
  if (pid === null || pid === process.pid) return null;
  try {
    process.kill(pid, signal);
    return pid;
  } catch {
    return null;
  }
}

/** Poll until the lock is free (or timeout). */
export async function waitForRunLockFree(
  lockPath: string,
  opts: {
    timeoutMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 100;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
  for (let i = 0; i < attempts; i += 1) {
    if (liveRunLockPid(lockPath) === null) return true;
    await sleep(pollMs);
  }
  return liveRunLockPid(lockPath) === null;
}
