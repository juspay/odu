/**
 * GREEN MEANS WARMED (PLAN 4.1) — the runner's half, over the real lane
 * surface.
 *
 * Four properties, and the second is the one worth the harness:
 *
 *   - a recipe that exits 0 under a push configuration pushes, and the node
 *     carries what it warmed;
 *   - a push that FAILS makes the node RED, with the client's own sentence in
 *     that node's log. A recipe that built the right thing and could not store
 *     it has not given the next run what this run promised, and reporting that
 *     as a pass would make the cache's contents a matter of luck;
 *   - a recipe that FAILED is not pushed at all — its `result` is the previous
 *     run's link, and storing it would publish bytes this run never produced;
 *   - a lane with no push configuration never calls the pusher, which is every
 *     run whose checkout names no odu cache.
 *
 * Driven through the lane's own stdio surface rather than against
 * `spawnNode`: the thing being asserted is what a COORDINATOR sees on the
 * `nodes` cell and the log stream, and those are the two wires it reads.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { stdioLink } from "@kolu/surface/links/stdio";
import { createLoopbackPair, greetLoopback } from "@kolu/surface/loopback";
import { serveOverStdio } from "@kolu/surface/peer-server";
import type { NodesSnapshot } from "@odu/run-client/surface";
import { firstFrame, runUnary, subscribe } from "../common/effectEdge";
import { type LaneClient, laneClientOver, laneSurface } from "../common/laneSurface";
import type { TaskSpec } from "../common/spec";
import { createLaneRunner } from "./runner";
import type { LanePusher, PushConfig, PushedFact } from "./pushResults";

const PUSH_ENV = {
  ODU_CACHE_ORIGIN: "https://odu.example.org",
  ODU_CACHE_BUCKET: "main",
  ODU_CACHE_TOKEN: "odu_run_token",
};

interface Lane {
  client: LaneClient;
  states: NodesSnapshot[];
  configure: (tasks: TaskSpec[]) => Promise<{ ok: boolean; error: string | null }>;
  logOf: (id: string) => Promise<string>;
  dispose: () => void;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function lane(pusher: LanePusher): Promise<Lane> {
  const runner = createLaneRunner({ pusher });
  const pair = createLoopbackPair();
  void serveOverStdio({
    group: runner.group,
    handlers: runner.handlers,
    transport: pair.server,
  });
  const readiness = await greetLoopback(pair);
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
    void link.dispose();
    pair.client.write.end();
    runner.dispose();
    pair.client.read.destroy();
  };
  cleanups.push(dispose);

  return {
    client,
    states,
    configure: (tasks) =>
      runUnary(
        client.surface.run.configure({
          name: "test",
          origin: null,
          sha: null,
          workspace: tmpdir(),
          tasks,
        }),
      ),
    logOf: async (id) => {
      const frame = await firstFrame(client.surface.nodeLog.get({ id }));
      return frame !== undefined && frame.kind !== "end" ? frame.text : "";
    },
    dispose,
  };
}

const last = (l: Lane): NodesSnapshot => {
  const state = l.states.at(-1);
  if (state === undefined) throw new Error("no state yet");
  return state;
};

/** Wait for a CONDITION, with a deadline — never for a duration. The subject
 *  here is a real child process on the platform clock (`spawn`, its stdio
 *  draining, the push that follows), so there is no timer to fake: what is
 *  awaited is the node's own state, and the deadline exists only so a wedge
 *  fails rather than hangs. */
async function until(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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

/** A pusher that records what it was asked and answers as the test states. */
function stubPusher(
  answer: (config: PushConfig) => Promise<PushedFact | null>,
): LanePusher & { calls: PushConfig[] } {
  const calls: PushConfig[] = [];
  return {
    calls,
    push: async (_workdir, config, say) => {
      calls.push(config);
      say("[odu] 3 paths in the closure: 1 to push");
      return answer(config);
    },
  };
}

describe("a lane node that pushes what it built", () => {
  it("carries the counts on the node, and the client's lines in its log", async () => {
    const pusher = stubPusher(async () => ({
      paths: 4,
      bytes: 2_097_152,
      durationMs: 1_500,
    }));
    const l = await lane(pusher);
    await l.configure([
      { id: "build", command: "echo built", needs: [], env: PUSH_ENV },
    ]);
    await until(() => last(l).nodes.build?.status === "ok");

    // THE CONFIGURATION CAME OFF THE TASK'S ENVIRONMENT — the seam a
    // coordinator fills, and the only place a lane learns a token.
    expect(pusher.calls).toEqual([
      {
        origin: PUSH_ENV.ODU_CACHE_ORIGIN,
        bucket: PUSH_ENV.ODU_CACHE_BUCKET,
        token: PUSH_ENV.ODU_CACHE_TOKEN,
      },
    ]);
    expect(last(l).nodes.build?.pushed).toEqual({
      paths: 4,
      bytes: 2_097_152,
      durationMs: 1_500,
    });
    // THE RECIPE'S OWN TIME, not the recipe's plus the push's: every existing
    // timing surface reads `durationMs` as how long the work took.
    expect(last(l).nodes.build?.durationMs).toBeLessThan(1_500);
    expect(await l.logOf("build")).toContain("3 paths in the closure");
  });

  it("goes RED when the push failed, with the push's own sentence", async () => {
    const pusher = stubPusher(async () => {
      throw new Error("odu: 1 path could not be pushed to main — 413 too large");
    });
    const l = await lane(pusher);
    await l.configure([
      { id: "build", command: "echo built", needs: [], env: PUSH_ENV },
    ]);
    await until(() => last(l).nodes.build?.status === "failed");

    const node = last(l).nodes.build;
    // The RECIPE exited 0 — the exit code says so — and the node is red
    // anyway, because green means warmed.
    expect(node?.exitCode).toBe(0);
    expect(node?.pushed).toBeUndefined();
    expect(await l.logOf("build")).toContain("413 too large");
  });

  it("does not push a recipe that FAILED", async () => {
    const pusher = stubPusher(async () => ({ paths: 1, bytes: 1, durationMs: 1 }));
    const l = await lane(pusher);
    await l.configure([
      { id: "build", command: "exit 3", needs: [], env: PUSH_ENV },
    ]);
    await until(() => last(l).nodes.build?.status === "failed");
    // ITS `result` IS LAST RUN'S LINK. Pushing it would store bytes this run
    // never produced.
    expect(pusher.calls).toEqual([]);
    expect(last(l).nodes.build?.exitCode).toBe(3);
  });

  it("never reaches the pusher for a lane with no push configuration", async () => {
    const pusher = stubPusher(async () => ({ paths: 1, bytes: 1, durationMs: 1 }));
    const l = await lane(pusher);
    await l.configure([{ id: "build", command: "echo built", needs: [] }]);
    await until(() => last(l).nodes.build?.status === "ok");
    expect(pusher.calls).toEqual([]);
    expect(last(l).nodes.build?.pushed).toBeUndefined();
  });

  it("delivers a task's environment to the recipe — and NOT the run's token", async () => {
    // TWO FACTS, ONE CASE, because they are the same `spawn`.
    //
    // The DELIVERY was uncovered: this change deleted the only exercised path
    // (`shards.ts` used to prepend `ODU_SHARD_INDEX=… ` to the displayed
    // command), so dropping the env spread in `spawnNode` would have left
    // every suite green while `ODU_SHARD_INDEX` vanished from every recipe.
    //
    // The ABSENCE is the security half: the runner IS the node's process, so
    // the pusher can hold the token without the repo's own shell inheriting
    // it — and a recipe that prints its environment must not write a live
    // credential into a log the catalog keeps.
    const pusher = stubPusher(async () => null);
    const l = await lane(pusher);
    await l.configure([
      {
        id: "build",
        command: "echo index=$ODU_SHARD_INDEX token=[${ODU_CACHE_TOKEN:-absent}]",
        needs: [],
        env: { ...PUSH_ENV, ODU_SHARD_INDEX: "2" },
      },
    ]);
    await until(() => last(l).nodes.build?.status === "ok");
    const log = await l.logOf("build");
    expect(log).toContain("index=2");
    expect(log).toContain("token=[absent]");
    expect(log).not.toContain(PUSH_ENV.ODU_CACHE_TOKEN);
    // And the PUSHER still got it: keeping it from the child is not keeping
    // it from the lane.
    expect(pusher.calls[0]?.token).toBe(PUSH_ENV.ODU_CACHE_TOKEN);
  });
});
