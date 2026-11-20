/**
 * Checkout run-lock: exclusive create (`O_EXCL`) of a PID file under `.ci/`,
 * released on `release()` / process exit; a dead holder's file is free
 * (signal-0 liveness). Pure Node — macOS coordinators may not have
 * `flock(1)` from util-linux.
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

export const RUN_LOCK_PATH = ".ci/odu.run.lock";

export interface RunLockHandle {
  readonly path: string;
  readonly pid: number;
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

/** Non-blocking exclusive acquire. Returns `null` when another live process
 *  holds the lock (or an uncontended race lost on `O_EXCL`). */
export function tryAcquireRunLock(lockPath: string): RunLockHandle | null {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  const holder = liveRunLockPid(lockPath);
  if (holder !== null) return null;

  try {
    unlinkSync(lockPath);
  } catch {
  }

  let fd: number;
  try {
    fd = openSync(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
  } catch {
    return null;
  }

  try {
    writeSync(fd, `${process.pid}\n`);
  } catch {
    try {
      closeSync(fd);
    } catch {
    }
    try {
      unlinkSync(lockPath);
    } catch {
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
    }
    if (readLockPid(lockPath) === process.pid) {
      try {
        unlinkSync(lockPath);
      } catch {
      }
    }
  };

  process.once("exit", release);
  return { path: lockPath, pid: process.pid, release };
}

/** Ask a live lock holder to stop (SIGTERM). No-op when free/stale. Returns the
 *  pid signaled, or null. */
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
