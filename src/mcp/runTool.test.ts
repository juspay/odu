/**
 * `startRun` — the `run` tool's spawn-and-await, with the spawn, socket-wait,
 * and supersede-cancel seams injected so the lock/supersede policy is tested
 * without a real coordinator. The "already live" branch needs a real socket to
 * dial, so it's served via `serveTestSurface`.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { CancelResult } from "../coordinator/cancel";
import { pendingNode, type PipelineState } from "../common/surface";
import { serveTestSurface, type TestSurface } from "./serveForTest";
import { startRun } from "./runTool";

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
});

describe("startRun — linger flag plumbing", () => {
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
});
