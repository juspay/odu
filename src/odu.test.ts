/**
 * Falsifiability suite for the lane runner, over the real stdio framing —
 * a loopback stream pair, exactly the transport ssh carries in production.
 * Adapted from the mini-ci example's suite, extended for odu's deltas:
 * idle-until-configure, the builtin `_ci-setup` node, configure rejection.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdioLink } from "@kolu/surface/links/stdio";
import { createLoopbackPair, greetLoopback } from "@kolu/surface/loopback";
import { serveOverStdio } from "@kolu/surface/peer-server";
import { afterEach, describe, expect, it } from "bun:test";
import {
  type NodeLogMessage,
  type NodesSnapshot,
  type PipelineState,
} from "@odu/run-client/surface";
import {
  countsLine,
  exitCode,
  OUTCOME_MARK,
  outcomeOf,
  summarize,
  verdictLine,
} from "./cli/render";
import type { TaskSpec } from "./common/spec";
import {
  type LaneClient,
  laneClientOver,
  laneSurface,
} from "./common/laneSurface";
import { firstFrame, runUnary, subscribe } from "./common/effectEdge";
import { createLaneRunner, SETUP_NODE_ID } from "./runner/runner";

interface Harness {
  client: LaneClient;
  states: NodesSnapshot[];
  configure: (
    tasks: TaskSpec[],
    workspace?: string,
  ) => Promise<{
    ok: boolean;
    error: string | null;
  }>;
  dispose: () => void;
}

/** The text a log frame carries. `end` carries none — it says the node has
 *  finished producing output, not what it said — so the assertions below can
 *  read as "what is in this log" instead of as a union narrowing. */
function frameText(frame: NodeLogMessage | undefined): string {
  return frame !== undefined && frame.kind !== "end" ? frame.text : "";
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function harness(): Promise<Harness> {
  const runner = createLaneRunner();
  const pair = createLoopbackPair();
  void serveOverStdio({
    group: runner.group,
    handlers: runner.handlers,
    transport: pair.server,
  });
  // The epoch gate (juspay/kolu#2101). `serveOverStdio` greets on its own only
  // when the PROCESS is the agent — the construction-time discriminant is
  // exactly the `transport` we pass above, so over an explicit loopback the
  // caller plays the server and greets, as a daemon front does after it
  // converges. `greetLoopback` is the real protocol, not a shortcut around it:
  // it writes the banner on the server half and reads it back off the client
  // half, which is what keeps this round-trip honest evidence about the ssh leg.
  const readiness = await greetLoopback(pair);
  // Every wire link is ASYNC now (building the protocol layer and its fibers is
  // an effect) and owns a scope holding those fibers — hence the await here and
  // the `dispose()` in teardown.
  const link = await stdioLink({
    group: laneSurface.group,
    read: pair.client.read,
    write: pair.client.write,
    readiness,
  });
  const client = laneClientOver(link.dispatch);

  const states: NodesSnapshot[] = [];
  void (async () => {
    try {
      for await (const state of subscribe(client.surface.nodes.get(undefined))) {
        states.push(state);
      }
    } catch {
      // teardown races are unremarkable
    }
  })();

  const dispose = (): void => {
    // Client goes away first (runner sees EOF and disposes), then the
    // client.s inbound closes so live iterators end — mini-ci.s ordering.
    void link.dispose();
    pair.client.write.end();
    runner.dispose();
    pair.client.read.destroy();
  };
  cleanups.push(dispose);

  return {
    client,
    states,
    configure: (tasks, workspace = tmpdir()) =>
      runUnary(
        client.surface.run.configure({
        name: "test",
        origin: null,
        sha: null,
          workspace,
          tasks,
        }),
      ),
    dispose,
  };
}

async function until(
  predicate: () => boolean,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // A throwing predicate is "not yet" — e.g. `last(h)` before the first frame.
  const ready = (): boolean => {
    try {
      return predicate();
    } catch {
      return false;
    }
  };
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("until: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const last = (h: Harness): NodesSnapshot => {
  const state = h.states.at(-1);
  if (state === undefined) throw new Error("no state yet");
  return state;
};

/**
 * Wait for a CONFIGURED pipeline of `nodes` nodes to settle.
 *
 * The count is load-bearing, not decoration. `summarize().done` means "no node
 * is pending or running", which an EMPTY node set satisfies VACUOUSLY — so in
 * the window before configure's first frame lands, `done` is already true, and
 * a bare `until(() => summarize(last(h)).done)` returns immediately on a state
 * with no nodes in it. Every assertion after it then reads `undefined` and the
 * test fails with `Expected: "failed" / Received: undefined`.
 *
 * It only loses that race on a loaded machine, which is why it survived here
 * for so long and then went red on a busy CI runner — twice, on two different
 * tests, in the two files that spelled the wait without a count. Waiting for
 * the node set to EXIST and then settle is one thought, so it gets one name
 * rather than a clause each caller has to remember (`_ci-setup` is why the
 * count is tasks + 1).
 */
const settledWith = (h: Harness, nodes: number): Promise<void> =>
  until(() => last(h).order.length === nodes && summarize(last(h)).done);

const chain: TaskSpec[] = [
  { id: "build", command: "echo building", needs: [] },
  { id: "test", command: "echo testing", needs: ["build"] },
];

describe("odu lane runner over stdio (loopback)", () => {
  it("spawns idle, then configure seeds _ci-setup + tasks and runs to green", async () => {
    const h = await harness();
    const ack = await h.configure(chain);
    expect(ack).toEqual({ ok: true, error: null });

    await settledWith(h, 3);
    const final = last(h);
    expect(final.order).toEqual([SETUP_NODE_ID, "build", "test"]);
    for (const id of final.order) {
      expect(final.nodes[id]?.status).toBe("ok");
    }

    // Race-free topo invariant across every captured frame: a node is only
    // ever running/ok after each of its needs is ok.
    for (const state of h.states) {
      for (const id of state.order) {
        const node = state.nodes[id];
        if (node === undefined) continue;
        if (node.status === "running" || node.status === "ok") {
          for (const dep of node.needs) {
            expect(state.nodes[dep]?.status).toBe("ok");
          }
        }
      }
    }
  });

  it("rejects a second configure (one run per lane process)", async () => {
    const h = await harness();
    expect((await h.configure(chain)).ok).toBe(true);
    const again = await h.configure(chain);
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already configured/);
  });

  it("fails _ci-setup on a missing workspace and skip-cascades every task", async () => {
    const h = await harness();
    const ack = await h.configure(chain, "/nonexistent/odu-workspace");
    expect(ack.ok).toBe(true); // ack-fast: the failure surfaces as the node
    await settledWith(h, 3);
    const final = last(h);
    expect(final.nodes[SETUP_NODE_ID]?.status).toBe("failed");
    expect(final.nodes.build?.status).toBe("skipped");
    expect(final.nodes.test?.status).toBe("skipped");
    expect(summarize(final).failedOverall).toBe(true);
  });

  it("gives a late subscriber the full snapshot as its first frame", async () => {
    const h = await harness();
    await h.configure(chain);
    await settledWith(h, 3);

    // A late subscriber still leads with the CURRENT snapshot — the cell.s
    // snapshot is taken at subscribe time (the stream is lazy), not when the
    // handler was built.
    const first = await firstFrame(h.client.surface.nodes.get(undefined));
    expect(first?.nodes.test?.status).toBe("ok");
  });

  it("replays a node's log to a late subscriber as a snapshot frame", async () => {
    const h = await harness();
    await h.configure([
      { id: "mark", command: "echo MARK-ODU-LOG", needs: [] },
    ]);
    await until(() => last(h).nodes.mark?.status === "ok");

    const frame = await firstFrame(h.client.surface.nodeLog.get({ id: "mark" }));
    expect(frame?.kind).toBe("snapshot");
    expect(frameText(frame)).toContain("MARK-ODU-LOG");
  });

  it("ends a finished node's log, so a reader can tell 'that was all'", async () => {
    // The whole of juspay/odu#87 in one assertion: without a terminal frame,
    // "the lane still owes me this node's output" is unobservable, and the
    // coordinator's only option is to guess — which it lost, silently, at
    // exactly the moment a long recipe's summary was still in flight.
    const h = await harness();
    await h.configure([{ id: "mark", command: "echo MARK-ODU-LOG", needs: [] }]);
    await until(() => last(h).nodes.mark?.status === "ok");

    const frames: string[] = [];
    for await (const frame of subscribe(
      h.client.surface.nodeLog.get({ id: "mark" }),
    )) {
      frames.push(frame.kind);
      if (frame.kind === "end") break;
    }
    // A LATE subscriber missed the live `end`, so the log replays one: whether
    // this node is finished is a property of the log, not of when you attached.
    expect(frames).toEqual(["snapshot", "end"]);
  });

  it("ends the log of a node that never ran — skipped counts as complete", async () => {
    // Terminal status and log terminal stay in lockstep on every path, so a
    // reader waiting for the whole lane can wait on all nodes alike instead of
    // knowing which ones were going to produce output.
    const h = await harness();
    await h.configure([
      { id: "build", command: "exit 3", needs: [] },
      { id: "test", command: "echo never", needs: ["build"] },
    ]);
    await until(() => last(h).nodes.test?.status === "skipped");

    const sub = subscribe(h.client.surface.nodeLog.get({ id: "test" }));
    await sub.next(); // the snapshot; the frame after it is the one under test
    expect((await sub.next()).value?.kind).toBe("end");
    void sub.return?.();
  });

  it("re-opens the EMPTY log of a rerun skipped node — the silent case", async () => {
    // The nastiest shape of "completion is not a latch": a skipped node's log
    // is empty AND ended, so its rerun's snapshot carries no text over no
    // buffer. Anything downstream that guards its reset on emptiness will
    // swallow that frame and keep insisting the log is complete — which is
    // exactly how a coordinator-side latch stayed stuck (caught in review).
    const h = await harness();
    await h.configure([
      { id: "build", command: "exit 3", needs: [] },
      { id: "test", command: "echo never", needs: ["build"] },
    ]);
    await until(() => last(h).nodes.test?.status === "skipped");

    const kinds: string[] = [];
    const sub = subscribe(h.client.surface.nodeLog.get({ id: "test" }));
    void (async () => {
      for await (const frame of sub) kinds.push(frame.kind);
    })();
    await until(() => kinds.length === 2); // snapshot(""), end
    expect(kinds).toEqual(["snapshot", "end"]);

    // Rerun the FAILED dep so the skipped node becomes pending again.
    expect(
      (await runUnary(h.client.surface.node.rerun({ id: "build" }))).ok,
    ).toBe(true);
    // The re-opening snapshot must arrive even though it carries nothing.
    await until(() => kinds.length > 2);
    expect(kinds[2]).toBe("snapshot");
    void sub.return?.();
  });

  it("re-opens an ended log on rerun — completion is not a latch", async () => {
    const h = await harness();
    await h.configure([{ id: "mark", command: "echo FIRST", needs: [] }]);
    await until(() => last(h).nodes.mark?.status === "ok");

    // Subscribe while the node is already finished, then rerun underneath the
    // subscription: the ended log must re-open, or a rerun's output would
    // arrive on a stream its reader had already written off as complete.
    const frames: Array<{ kind: string; text?: string }> = [];
    const sub = subscribe(h.client.surface.nodeLog.get({ id: "mark" }));
    void (async () => {
      for await (const frame of sub) {
        frames.push(frame.kind === "end" ? { kind: "end" } : frame);
      }
    })();
    await until(() => frames.length === 2); // snapshot, end

    expect((await runUnary(h.client.surface.node.rerun({ id: "mark" }))).ok).toBe(
      true,
    );
    // A fresh snapshot re-opens the log, and the new invocation ends it again.
    await until(() => frames.length > 2 && frames.at(-1)?.kind === "end");
    expect(frames.slice(2).map((f) => f.kind)).toContain("snapshot");
    void sub.return?.();
  });

  it("reruns a node and its transitive dependents", async () => {
    const h = await harness();
    await h.configure(chain);
    await settledWith(h, 3);

    const before = h.states.length;
    const result = await runUnary(h.client.surface.node.rerun({ id: "build" }));
    expect(result.ok).toBe(true);
    await until(() => h.states.length > before && summarize(last(h)).done);
    const reran = h.states
      .slice(before)
      .some((s) => s.nodes.test?.status === "pending");
    expect(reran).toBe(true);
    expect(last(h).nodes.build?.status).toBe("ok");
    expect(last(h).nodes.test?.status).toBe("ok");
  });

  it("skips dependents of a failed node — no false greens", async () => {
    const h = await harness();
    await h.configure([
      { id: "build", command: "exit 3", needs: [] },
      { id: "test", command: "echo never", needs: ["build"] },
    ]);
    await settledWith(h, 3);
    const final = last(h);
    expect(final.nodes.build?.status).toBe("failed");
    expect(final.nodes.build?.exitCode).toBe(3);
    expect(final.nodes.test?.status).toBe("skipped");
    expect(summarize(final).failedOverall).toBe(true);
  });

  it("gives nodes reopenable stdio — `pretty:/dev/stderr` class consumers", async () => {
    // Node's 'pipe' stdio is an AF_UNIX socketpair and Linux can't open() a
    // socket by path, so without the `| cat` interposition this exact shape
    // (cucumber's pretty:/dev/stderr) dies with ENXIO. Regression for the
    // first dogfood run's ci::e2e@x86_64-linux failure.
    const h = await harness();
    await h.configure([
      { id: "reopen", command: "echo REOPENED > /dev/stderr", needs: [] },
    ]);
    await until(
      () =>
        last(h).nodes.reopen?.status !== undefined && summarize(last(h)).done,
    );
    expect(last(h).nodes.reopen?.status).toBe("ok");

    const frame = await firstFrame(
      h.client.surface.nodeLog.get({ id: "reopen" }),
    );
    expect(frameText(frame)).toContain("REOPENED");
  });

  it("rejects rerun of an unknown node", async () => {
    const h = await harness();
    await h.configure(chain);
    const result = await runUnary(h.client.surface.node.rerun({ id: "nope" }));
    expect(result.ok).toBe(false);
  });

  it("cancels a running node and skips its dependents", async () => {
    const h = await harness();
    await h.configure([
      { id: "slow", command: "sleep 30", needs: [] },
      { id: "after", command: "echo never", needs: ["slow"] },
    ]);
    await until(() => last(h).nodes.slow?.status === "running");
    const result = await runUnary(h.client.surface.node.cancel({ id: "slow" }));
    expect(result.ok).toBe(true);
    await settledWith(h, 3);
    expect(last(h).nodes.slow?.status).toBe("cancelled");
    expect(last(h).nodes.after?.status).toBe("skipped");
    expect(summarize(last(h)).failedOverall).toBe(false);
    expect(summarize(last(h)).clean).toBe(false);
    expect(exitCode(last(h))).toBe(1);
  });

  it("rejects cancel of an unknown or already-terminal node", async () => {
    const h = await harness();
    await h.configure([{ id: "ok", command: "true", needs: [] }]);
    await settledWith(h, 2);
    expect((await runUnary(h.client.surface.node.cancel({ id: "nope" }))).ok).toBe(
      false,
    );
    expect((await runUnary(h.client.surface.node.cancel({ id: "ok" }))).ok).toBe(false);
  });
});

// The production leak (juspay/odu#70-class): recipe trees are spawned
// `detached` — their own process groups — so the ONLY thing that ever kills
// them is the runner's explicit group kill. These pin the two in-run paths a
// tree used to escape through: a cancel whose single SIGTERM was ignored, and
// a node that finished while a backgrounded stray was still alive in its
// group. (Runner-death-by-signal — the localhost-lane path — is pinned in
// runner/processTeardown.test.ts; the reaper's own contract in
// runner/reap.test.ts.)
describe("recipe process-tree reaping", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const readPid = (file: string): number =>
    Number(readFileSync(file, "utf-8").trim());

  it("cancel escalates a TERM-ignoring recipe tree to SIGKILL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-reap-"));
    const pidFile = join(dir, "pid");
    const h = await harness();
    // $BASHPID (not $$): the recipe body runs in the pipeline subshell, and
    // that subshell — which ignores SIGTERM and keeps respawning sleeps — is
    // the process that must NOT survive the cancel.
    await h.configure([
      {
        id: "stubborn",
        command: `echo $BASHPID > ${pidFile}; trap '' TERM; while :; do sleep 0.1; done`,
        needs: [],
      },
    ]);
    await until(() => existsSync(pidFile) && readPid(pidFile) > 0);
    const pid = readPid(pidFile);
    await until(() => last(h).nodes.stubborn?.status === "running");
    expect((await runUnary(h.client.surface.node.cancel({ id: "stubborn" }))).ok).toBe(
      true,
    );
    // SIGTERM → bounded grace → SIGKILL: the tree dies even though it
    // ignores SIGTERM. Before the reaper this leaked forever (ppid 1).
    await until(() => !alive(pid));
  }, 15_000);

  it("reaps a stray the recipe left behind in its group when the node finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-reap-"));
    const strayFile = join(dir, "stray");
    const h = await harness();
    // The stray redirects its stdio, so `cat` sees EOF and the node settles
    // ok while the stray lives on in the (otherwise unowned) process group.
    await h.configure([
      {
        id: "leaky",
        command: `sleep 30 </dev/null >/dev/null 2>&1 & echo $! > ${strayFile}`,
        needs: [],
      },
    ]);
    await until(() => last(h).nodes.leaky?.status === "ok");
    const stray = readPid(strayFile);
    // Node finish reaps the group: the stray dies instead of leaking to init.
    await until(() => !alive(stray));
  }, 15_000);
});

describe("render helpers", () => {
  const state: PipelineState = {
    name: "p",
    sha7: "abc1234",
    dirty: false,
    order: ["a", "b", "c"],
    nodes: {
      a: mkNode("a", "ok", 9_000),
      b: mkNode("b", "errored", 61_000),
      c: mkNode("c", "skipped", null),
    },
  };

  function mkNode(
    id: string,
    status: PipelineState["nodes"][string]["status"],
    durationMs: number | null,
  ): PipelineState["nodes"][string] {
    return {
      id,
      name: id,
      command: `echo ${id}`,
      needs: [],
      status,
      exitCode: null,
      startedAt: null,
      durationMs,
    };
  }

  it("summarize counts errored toward failedOverall", () => {
    const summary = summarize(state);
    expect(summary.done).toBe(true);
    expect(summary.errored).toBe(1);
    expect(summary.failedOverall).toBe(true);
  });

  it("verdictLine names the outcome, the counts and the red nodes", () => {
    // Pure in the state: the host prints it once its viewport is gone, so
    // there is no "call stop() first" ordering to get wrong.
    const line = verdictLine(state);
    expect(line).toContain(state.name);
    expect(line).toContain(state.sha7);
    // The outcome mark and the counts, asserted against the same projections
    // the frame uses — not restated here, or the test pins a second spelling.
    expect(line).toContain(OUTCOME_MARK[outcomeOf(summarize(state))]);
    expect(line).toContain(countsLine(summarize(state)));
    // The red node is named. A verdict that hides one is worse than none.
    expect(line).toContain("⚠ b");
  });

});
