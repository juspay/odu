/**
 * `startRun` — the `run` tool's spawn-and-await, with the spawn, socket-wait,
 * and supersede-cancel seams injected so the lock/supersede policy is tested
 * without a real coordinator. The "already live" branch needs a real socket to
 * dial, so it's served via `serveTestSurface`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, jest } from "bun:test";
import type { CancelResult } from "../coordinator/cancel";
import { tryAcquireRunLock } from "../coordinator/checkoutLock";
import { pendingNode, type PipelineState } from "@odu/run-client/surface";
import { serveTestSurface, type TestSurface } from "./serveForTest";
import {
  appendPreOpen,
  openRunLog,
  pollUntilSocketOrExit,
  startRun,
} from "./runTool";
import { existsSync, readFileSync } from "node:fs";

function liveState(): PipelineState {
  return {
    name: "test",
    sha7: "abc1234",
    dirty: false,
    order: ["ci::e2e@x86_64-linux"],
    nodes: {
      "ci::e2e@x86_64-linux": {
        ...pendingNode({
          id: "ci::e2e@x86_64-linux",
          name: "ci::e2e",
          command: "just e2e",
          needs: [],
        }),
        status: "running",
      },
    },
  };
}

const open: TestSurface[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});
async function serveLive(): Promise<TestSurface> {
  const s = await serveTestSurface(liveState());
  open.push(s);
  return s;
}

/** A spawn stub that records the argv it was handed and reports a clean start. */
function captureSpawn() {
  const calls: string[][] = [];
  const spawnRun = (args: string[]) => {
    calls.push(args);
    return { stderr: "", onExit: new Promise<number>(() => {}) };
  };
  return { calls, spawnRun };
}

const socketUp = async (): Promise<boolean> => true;

describe("startRun — lock + supersede", () => {
  it("refuses when a run is already live and supersede is not set", async () => {
    const s = await serveLive();
    const { calls, spawnRun } = captureSpawn();
    const r = await startRun(
      {},
      { socketPath: s.socketPath, spawnRun, waitForSocket: socketUp },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already in progress/);
    expect(r.error).toMatch(/supersede/);
    expect(calls).toHaveLength(0); // never spawned
  });

  it("supersede cancels the live run, then spawns once it's confirmed gone", async () => {
    const s = await serveLive();
    const { calls, spawnRun } = captureSpawn();
    const cancelled: string[] = [];
    const cancelExisting = async (path: string): Promise<CancelResult> => {
      cancelled.push(path);
      return { cancelled: true, confirmed: true };
    };
    const r = await startRun(
      { supersede: true },
      { socketPath: s.socketPath, spawnRun, waitForSocket: socketUp, cancelExisting },
    );
    expect(cancelled).toEqual([s.socketPath]);
    expect(r).toMatchObject({ ok: true, started: true });
    expect(calls).toHaveLength(1);
  });

  it("supersede gives up (no spawn) when the existing run won't shut down", async () => {
    const s = await serveLive();
    const { calls, spawnRun } = captureSpawn();
    const cancelExisting = async (): Promise<CancelResult> => ({
      cancelled: true,
      confirmed: false,
    });
    const r = await startRun(
      { supersede: true },
      { socketPath: s.socketPath, spawnRun, waitForSocket: socketUp, cancelExisting },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not shut down/);
    expect(calls).toHaveLength(0);
  });

  it("refuses when the run-lock is held with no socket (lease-wait window)", async () => {
    // Concurrent starter during venue lease wait: no .ci/odu.sock yet, but
    // the PID run-lock is held — must not spawn a second coordinator.
    const dir = mkdtempSync(join(tmpdir(), "odu-mcp-lock-"));
    const socketPath = join(dir, "odu.sock");
    const lockPath = join(dir, "odu.run.lock");
    const held = tryAcquireRunLock(lockPath);
    expect(held).not.toBeNull();
    try {
      const { calls, spawnRun } = captureSpawn();
      const r = await startRun(
        {},
        { socketPath, spawnRun, waitForSocket: socketUp },
      );
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/already in progress/);
      expect(calls).toHaveLength(0);
    } finally {
      held!.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("startRun — linger / no_wait flag plumbing", () => {
  it("passes --linger through to the spawned run", async () => {
    const { calls, spawnRun } = captureSpawn();
    const r = await startRun(
      { linger: true },
      { socketPath: "/no/such/odu.sock", spawnRun, waitForSocket: socketUp },
    );
    expect(r).toMatchObject({ ok: true, started: true });
    expect(calls[0]).toContain("--linger");
  });

  it("omits --linger by default", async () => {
    const { calls, spawnRun } = captureSpawn();
    await startRun(
      {},
      { socketPath: "/no/such/odu.sock", spawnRun, waitForSocket: socketUp },
    );
    expect(calls[0]).not.toContain("--linger");
  });

  it("passes --no-wait through to the spawned run", async () => {
    const { calls, spawnRun } = captureSpawn();
    const r = await startRun(
      { no_wait: true },
      { socketPath: "/no/such/odu.sock", spawnRun, waitForSocket: socketUp },
    );
    expect(r).toMatchObject({ ok: true, started: true });
    expect(calls[0]).toContain("--no-wait");
  });
});

describe("pollUntilSocketOrExit — exit-bounded wait (no fixed startup window)", () => {
  it("keeps polling past the former ~60s window while the child lives", async () => {
    // 240 × 250ms was the old hard cap. Simulate a busy-pool queue longer than
    // that many polls; the waiter must not give up while the child is alive.
    const OLD_MAX_POLLS = 240;
    let polls = 0;
    const ready = jest.fn(async () => {
      polls += 1;
      return polls > OLD_MAX_POLLS + 10;
    });
    const exited = new Promise<number>(() => {
      /* child still running — lease queue */
    });
    const up = await pollUntilSocketOrExit(ready, exited, 0);
    expect(up).toBe(true);
    expect(polls).toBeGreaterThan(OLD_MAX_POLLS);
  });

  it("stops when the child exits without a socket", async () => {
    let resolveExit!: () => void;
    const exited = new Promise<void>((r) => {
      resolveExit = r;
    });
    let polls = 0;
    const ready = jest.fn(async () => {
      polls += 1;
      if (polls === 3) resolveExit();
      return false;
    });
    const up = await pollUntilSocketOrExit(ready, exited, 0);
    expect(up).toBe(false);
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it("startRun reports failure without requiring the child to have exited", async () => {
    // Custom wait aborts while onExit never settles (stand-in for a still-alive
    // lease waiter under a non-default wait). Must fail closed, not hang.
    const neverExit = new Promise<number>(() => {});
    const r = await startRun(
      {},
      {
        socketPath: "/no/such/odu.sock",
        spawnRun: () => ({ stderr: "", onExit: neverExit }),
        waitForSocket: async () => false,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.started).toBe(false);
    expect(r.error).toMatch(/did not serve a socket|still running/);
  });
});

describe("appendPreOpen — pre-open tee cap (juspay/odu#61)", () => {
  it("caps total buffered bytes and truncates the overflow chunk", () => {
    const chunks: Buffer[] = [];
    let n = appendPreOpen(chunks, Buffer.from("hello "), 10, 0);
    expect(n).toBe(6);
    n = appendPreOpen(chunks, Buffer.from("world!!!"), 10, n);
    expect(n).toBe(10);
    expect(Buffer.concat(chunks).toString()).toBe("hello worl");
    // Further appends are no-ops once at the cap.
    expect(appendPreOpen(chunks, Buffer.from("more"), 10, n)).toBe(10);
  });
});

describe("openRunLog — durable coordinator log path", () => {
  it("writes under .ci/<sha7>/runs/<seq>.log when the surface has identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-runlog-"));
    const socketPath = join(dir, "odu.sock");
    // Serve a surface with sha7+seq so openRunLog can place the file.
    const state = { ...liveState(), sha7: "abc1234", seq: 7 };
    const s = await serveTestSurface(state, undefined, { socketPath });
    open.push(s);
    try {
      const stream = await openRunLog(socketPath);
      expect(stream).not.toBeNull();
      stream!.write("coordinator boot\n");
      await new Promise<void>((resolve, reject) => {
        stream!.end((err: Error | null | undefined) =>
          err ? reject(err) : resolve(),
        );
      });
      const logPath = join(dir, "abc1234", "runs", "7.log");
      expect(existsSync(logPath)).toBe(true);
      expect(readFileSync(logPath, "utf-8")).toContain("coordinator boot");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the socket cannot be dialed", async () => {
    expect(await openRunLog("/no/such/odu.sock")).toBeNull();
  });
});
