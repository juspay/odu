/**
 * Checkout run-lock: exclusivity during the venue-lease wait (before
 * `.ci/odu.sock` serves). Concurrent starters must refuse rather than co-queue.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  liveRunLockPid,
  tryAcquireRunLock,
  waitForRunLockFree,
} from "./checkoutLock";
import { ensureCheckoutFree } from "./run";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tmpLock(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-runlock-"));
  dirs.push(dir);
  return join(dir, "odu.run.lock");
}

describe("tryAcquireRunLock", () => {
  it("grants the first claim and refuses a second while held", () => {
    const path = tmpLock();
    const a = tryAcquireRunLock(path);
    expect(a).not.toBeNull();
    expect(liveRunLockPid(path)).toBe(process.pid);

    const b = tryAcquireRunLock(path);
    expect(b).toBeNull();

    a!.release();
    expect(liveRunLockPid(path)).toBeNull();

    const c = tryAcquireRunLock(path);
    expect(c).not.toBeNull();
    c!.release();
  });

  it("treats a stale lock file (dead pid) as free", () => {
    const path = tmpLock();
    // PID 1 is init/launchd — usually not killable as "ours", but signal 0 on
    // a definitely-dead high pid: use a pid that does not exist.
    writeFileSync(path, "2147483646\n");
    expect(liveRunLockPid(path)).toBeNull();
    const a = tryAcquireRunLock(path);
    expect(a).not.toBeNull();
    a!.release();
  });
});

describe("ensureCheckoutFree — run-lock during lease wait", () => {
  it("refuses when the run-lock is held even with no live socket", async () => {
    const lockPath = tmpLock();
    const held = tryAcquireRunLock(lockPath);
    expect(held).not.toBeNull();

    const dial = async () => null;
    const r = await ensureCheckoutFree(
      { socketPath: "/no/such/odu.sock", lockPath },
      false,
      { dial },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected refuse");
    expect(r.reason).toBe("live");
    expect(r.message).toMatch(/already in progress/);

    held!.release();
  });

  it("second starter fails while first holds the lock across a long lease wait", async () => {
    // Models: starter A acquired the lock and is blocked in leaseLanes;
    // starter B's ensureCheckoutFree must refuse immediately (not co-queue).
    const lockPath = tmpLock();
    const first = tryAcquireRunLock(lockPath);
    expect(first).not.toBeNull();

    // Injected "long lease wait" — first still holds the lock.
    await new Promise((r) => setTimeout(r, 20));

    const second = tryAcquireRunLock(lockPath);
    expect(second).toBeNull();

    const refuse = await ensureCheckoutFree(
      { socketPath: "/no/such.sock", lockPath },
      false,
      { dial: async () => null },
    );
    expect(refuse.ok).toBe(false);

    first!.release();
    expect(await waitForRunLockFree(lockPath, { timeoutMs: 500 })).toBe(true);
    const after = tryAcquireRunLock(lockPath);
    expect(after).not.toBeNull();
    after!.release();
  });
});
