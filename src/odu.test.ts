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
import { createLoopbackPair } from "@kolu/surface/loopback";
import { serveOverStdio } from "@kolu/surface/peer-server";
import { afterEach, describe, expect, it } from "bun:test";
import {
  exitCode,
  summarize,
} from "./cli/render";
import type { TaskSpec } from "./common/spec";
import type {
  laneSurface,
  NodesSnapshot,
  PipelineState,
} from "./common/surface";
import { createLaneRunner, SETUP_NODE_ID } from "./runner/runner";

type Client = ReturnType<typeof stdioLink<typeof laneSurface.contract>>;

interface Harness {
  client: Client;
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

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harness(): Harness {
  const runner = createLaneRunner();
  const pair = createLoopbackPair();
  void serveOverStdio({ router: runner.router, transport: pair.server });
  const client = stdioLink<typeof laneSurface.contract>({
    read: pair.client.read,
    write: pair.client.write,
  });

  const states: NodesSnapshot[] = [];
  void (async () => {
    try {
      for await (const state of await client.surface.nodes.get({})) {
        states.push(state);
      }
    } catch {
      // teardown races are unremarkable
    }
  })();

  const dispose = (): void => {
    // Client goes away first (runner sees EOF and disposes), then the
    // client's inbound closes so live iterators end — mini-ci's ordering.
    pair.client.write.end();
    runner.dispose();
    pair.client.read.destroy();
  };
  cleanups.push(dispose);

  return {
    client,
    states,
    configure: (tasks, workspace = tmpdir()) =>
      client.surface.run.configure({
        name: "test",
        origin: null,
        sha: null,
        workspace,
        tasks,
      }),
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

const chain: TaskSpec[] = [
  { id: "build", command: "echo building", needs: [] },
  { id: "test", command: "echo testing", needs: ["build"] },
];

describe("odu lane runner over stdio (loopback)", () => {
  it("spawns idle, then configure seeds _ci-setup + tasks and runs to green", async () => {
    const h = harness();
    const ack = await h.configure(chain);
    expect(ack).toEqual({ ok: true, error: null });

    await until(() => summarize(last(h)).done && last(h).order.length === 3);
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
    const h = harness();
    expect((await h.configure(chain)).ok).toBe(true);
    const again = await h.configure(chain);
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already configured/);
  });

  it("fails _ci-setup on a missing workspace and skip-cascades every task", async () => {
    const h = harness();
    const ack = await h.configure(chain, "/nonexistent/odu-workspace");
    expect(ack.ok).toBe(true); // ack-fast: the failure surfaces as the node
    await until(() => summarize(last(h)).done);
    const final = last(h);
    expect(final.nodes[SETUP_NODE_ID]?.status).toBe("failed");
    expect(final.nodes.build?.status).toBe("skipped");
    expect(final.nodes.test?.status).toBe("skipped");
    expect(summarize(final).failedOverall).toBe(true);
  });

  it("gives a late subscriber the full snapshot as its first frame", async () => {
    const h = harness();
    await h.configure(chain);
    await until(() => summarize(last(h)).done && last(h).order.length === 3);

    let first: NodesSnapshot | undefined;
    for await (const state of await h.client.surface.nodes.get({})) {
      first = state;
      break;
    }
    expect(first?.nodes.test?.status).toBe("ok");
  });

  it("replays a node's log to a late subscriber as a snapshot frame", async () => {
    const h = harness();
    await h.configure([
      { id: "mark", command: "echo MARK-ODU-LOG", needs: [] },
    ]);
    await until(() => last(h).nodes.mark?.status === "ok");

    for await (const frame of await h.client.surface.nodeLog.get({
      id: "mark",
    })) {
      expect(frame.kind).toBe("snapshot");
      expect(frame.text).toContain("MARK-ODU-LOG");
      break;
    }
  });

  it("reruns a node and its transitive dependents", async () => {
    const h = harness();
    await h.configure(chain);
    await until(() => summarize(last(h)).done && last(h).order.length === 3);

    const before = h.states.length;
    const result = await h.client.surface.node.rerun({ id: "build" });
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
    const h = harness();
    await h.configure([
      { id: "build", command: "exit 3", needs: [] },
      { id: "test", command: "echo never", needs: ["build"] },
    ]);
    await until(() => summarize(last(h)).done);
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
    const h = harness();
    await h.configure([
      { id: "reopen", command: "echo REOPENED > /dev/stderr", needs: [] },
    ]);
    await until(
      () =>
        last(h).nodes.reopen?.status !== undefined && summarize(last(h)).done,
    );
    expect(last(h).nodes.reopen?.status).toBe("ok");

    for await (const frame of await h.client.surface.nodeLog.get({
      id: "reopen",
    })) {
      expect(frame.text).toContain("REOPENED");
      break;
    }
  });

  it("rejects rerun of an unknown node", async () => {
    const h = harness();
    await h.configure(chain);
    const result = await h.client.surface.node.rerun({ id: "nope" });
    expect(result.ok).toBe(false);
  });

  it("cancels a running node and skips its dependents", async () => {
    const h = harness();
    await h.configure([
      { id: "slow", command: "sleep 30", needs: [] },
      { id: "after", command: "echo never", needs: ["slow"] },
    ]);
    await until(() => last(h).nodes.slow?.status === "running");
    const result = await h.client.surface.node.cancel({ id: "slow" });
    expect(result.ok).toBe(true);
    await until(() => summarize(last(h)).done);
    expect(last(h).nodes.slow?.status).toBe("cancelled");
    expect(last(h).nodes.after?.status).toBe("skipped");
    expect(summarize(last(h)).failedOverall).toBe(false);
    expect(summarize(last(h)).clean).toBe(false);
    expect(exitCode(last(h))).toBe(1);
  });

  it("rejects cancel of an unknown or already-terminal node", async () => {
    const h = harness();
    await h.configure([{ id: "ok", command: "true", needs: [] }]);
    await until(() => summarize(last(h)).done);
    expect((await h.client.surface.node.cancel({ id: "nope" })).ok).toBe(
      false,
    );
    expect((await h.client.surface.node.cancel({ id: "ok" })).ok).toBe(false);
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
    const h = harness();
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
    expect((await h.client.surface.node.cancel({ id: "stubborn" })).ok).toBe(
      true,
    );
    // SIGTERM → bounded grace → SIGKILL: the tree dies even though it
    // ignores SIGTERM. Before the reaper this leaked forever (ppid 1).
    await until(() => !alive(pid));
  }, 15_000);

  it("reaps a stray the recipe left behind in its group when the node finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-reap-"));
    const strayFile = join(dir, "stray");
    const h = harness();
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

});
