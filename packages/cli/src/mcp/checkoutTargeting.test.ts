/**
 * The per-call `checkout` argument, end to end per verb: the tool dials (or
 * reads) the NAMED checkout's `.ci`, never only the server's cwd — and two
 * checkouts never see each other's run.
 *
 * Each "live run" is a real `oduSurface` served on the checkout's rendezvous
 * path (`<dir>/.ci/odu.sock`, via `serveTestSurface` pinned there) so the
 * dial path under test is the shipping one, not a stub of `dialRun`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { runSocketPath } from "@odu/run-client/dial";
import type { PipelineState } from "@odu/run-client/surface";
import { pendingNode } from "@odu/run-client/surface";
import type { RunRecord } from "@odu/run-history/legacy/record";
import { writeRunRecord } from "@odu/run-history/legacy/ledger";
import {
  readLeaseRecord,
  upsertPlatformLease,
} from "@odu/execution/coordinator/leaseRecord";
import { cancelTool } from "./cancelTool";
import { releaseTool } from "./leaseTool";
import { laneCancelTool, nodeCancelTool } from "./partialCancelTools";
import { rerunTool } from "./rerunTool";
import { listRuns } from "./runsTool";
import { makeWaitTool } from "./waitTool";
import { serveTestSurface, type TestSurface } from "@odu/execution/coordinator/serveForTest";
import type { SettleVerdict } from "@odu/execution/coordinator/waitForSettle";

const dirs: string[] = [];
const surfaces: TestSurface[] = [];
afterEach(() => {
  for (const s of surfaces.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function checkout(): string {
  const d = mkdtempSync(join(tmpdir(), "odu-mcp-target-"));
  dirs.push(d);
  return d;
}

function doneState(): PipelineState {
  const id = "ci::unit@x86_64-linux";
  return {
    name: "test",
    sha7: "abc1234",
    dirty: false,
    seq: 3,
    order: [id],
    nodes: {
      [id]: {
        ...pendingNode({ id, name: id, command: "echo", needs: [] }),
        status: "ok",
        exitCode: 0,
        durationMs: 1,
      },
    },
  };
}

/** Serve a live `oduSurface` at the checkout's OWN rendezvous path. The
 *  `onCancel` hook makes `run.cancel` tear the listener down exactly as the
 *  real coordinator exits, so `cancelRun`'s wait-for-gone confirms. */
async function serveIn(
  dir: string,
  initial: PipelineState,
): Promise<TestSurface> {
  const s = await serveTestSurface(initial, undefined, {
    socketPath: runSocketPath(dir),
    onCancel: (close) => close(),
  });
  surfaces.push(s);
  return s;
}

/** A verbose stand-in for the B-client the default branch would get: every
 *  member THROWS, so a checkout-named call that routed through it (instead of
 *  dialing the named checkout) fails loudly rather than silently passing. */
const NO_CLIENT = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error("checkout-named call must dial, not reuse a client");
    },
  },
) as never;

describe("cancel({checkout})", () => {
  it("cancels the named checkout's run and confirms teardown", async () => {
    const dir = checkout();
    const s = await serveIn(dir, doneState());
    const r = (await Effect.runPromise(
      cancelTool.handler({ checkout: dir }, NO_CLIENT, undefined),
    )) as { ok: boolean; cancelled: boolean; confirmed: boolean };
    expect(r).toEqual({ ok: true, cancelled: true, confirmed: true });
    expect(s.cancels()).toBe(1);
  });

  it("is a clean no-op in a checkout with no run", async () => {
    const empty = checkout();
    const r = (await Effect.runPromise(
      cancelTool.handler({ checkout: empty }, NO_CLIENT, undefined),
    )) as { ok: boolean; cancelled: boolean; confirmed: boolean };
    expect(r).toEqual({ ok: true, cancelled: false, confirmed: true });
  });
});

describe("node_rerun / node_cancel / lane_cancel ({checkout})", () => {
  it("each verb reaches the NAMED checkout's run", async () => {
    const dir = checkout();
    const s = await serveIn(dir, doneState());

    await Effect.runPromise(
      rerunTool.handler({ id: "ci::unit@x86_64-linux", checkout: dir }, NO_CLIENT, undefined),
    );
    await Effect.runPromise(
      nodeCancelTool.handler({ id: "ci::unit@x86_64-linux", checkout: dir }, NO_CLIENT, undefined),
    );
    await Effect.runPromise(
      laneCancelTool.handler({ platform: "aarch64-darwin", checkout: dir }, NO_CLIENT, undefined),
    );

    expect(s.reruns).toEqual(["ci::unit@x86_64-linux"]);
    expect(s.nodeCancels).toEqual(["ci::unit@x86_64-linux"]);
    expect(s.laneCancels).toEqual(["aarch64-darwin"]);
  });

  it("a checkout with no run answers {ok:false}, not an error", async () => {
    const empty = checkout();
    const r = (await Effect.runPromise(
      rerunTool.handler({ id: "ci::unit@x86_64-linux", checkout: empty }, NO_CLIENT, undefined),
    )) as { ok: boolean };
    expect(r).toEqual({ ok: false });
  });
});

describe("wait_for_settle({checkout})", () => {
  it("returns the named checkout's verdict", async () => {
    const dir = checkout();
    await serveIn(dir, doneState());
    const verdict = (await Effect.runPromise(
      makeWaitTool().handler(
        { checkout: dir, timeout_ms: 5_000 },
        NO_CLIENT,
        undefined,
      ),
    )) as SettleVerdict;
    expect(verdict.settled).toBe(true);
    expect(verdict.passed).toBe(true);
    expect(verdict.sha7).toBe("abc1234");
  });

  it("refuses loudly (never an empty verdict) in a checkout with no run", async () => {
    const empty = checkout();
    await expect(
      Effect.runPromise(
        makeWaitTool().handler(
          { checkout: empty, timeout_ms: 2_000 },
          NO_CLIENT,
          undefined,
        ),
      ),
    ).rejects.toThrow(/no run in progress/);
  });
});

describe("runs({checkout}) — ledgers are per-checkout", () => {
  it("reads the named checkout's ledger, not another's", async () => {
    const dirA = checkout();
    const dirB = checkout();
    const record: RunRecord = {
      version: 1,
      repo: null,
      sha: "abc1234def00000000000000000000000000beef",
      seq: 1,
      dirty: false,
      pipeline: "test",
      outcome: "passed",
      startedAt: 1,
      finishedAt: 2,
      lanes: [{ platform: "x86_64-linux", host: "box" }],
      nodes: [
        {
          id: "ci::unit@x86_64-linux",
          name: "ci::unit",
          status: "ok",
          exitCode: 0,
          durationMs: 1,
        },
      ],
    };
    writeRunRecord(dirA, "abc1234", record);

    const noCorpse = async () => null;
    const a = await listRuns({ checkout: dirA, detectDead: noCorpse });
    expect(a.runs).toHaveLength(1);
    expect(a.runs[0]?.sha).toBe(record.sha);
    const b = await listRuns({ checkout: dirB, detectDead: noCorpse });
    expect(b.runs).toEqual([]);
  });
});

describe("release({checkout}) — the record is per-checkout", () => {
  it("signals the named checkout's holder and drops its record", async () => {
    const dir = checkout();
    // A REAL child as the holder process: `release` SIGTERMs it — kills by
    // explicit PID, and the pid being a real process is what keeps the
    // record from being reconciled away before release reads it.
    const holder = spawn("sleep", ["30"], { stdio: "ignore" });
    if (holder.pid === undefined) throw new Error("spawn gave no pid");
    upsertPlatformLease(dir, "x86_64-linux", {
      host: "box",
      holderPid: holder.pid,
      since: Date.now(),
      state: "held",
      waitingBehind: null,
      run: null,
    });
    try {
      const r = (await Effect.runPromise(
        releaseTool.handler({ checkout: dir }, NO_CLIENT, undefined),
      )) as { ok: boolean; code: number };
      expect(r).toEqual({ ok: true, code: 0 });
      expect(readLeaseRecord(dir)["x86_64-linux"]).toBeUndefined();
    } finally {
      try {
        process.kill(holder.pid, "SIGKILL");
      } catch {
        /* release already signalled it */
      }
    }
  });
});
