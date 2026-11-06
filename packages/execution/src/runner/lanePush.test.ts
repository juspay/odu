/**
 * THE PUSH IS ITS OWN STEP (PLAN 4.1) — the runner's half, over the real lane
 * surface.
 *
 * What a node does is two things: it runs a recipe, and then it puts what the
 * recipe built in the cache. This file pins that the second one is visible AS
 * a step — its own state on the node, its own log, its own beginning and
 * ending — and that neither half contaminates the other:
 *
 *   - the push's output goes to the node's PUSH stream, and NOTHING of it
 *     reaches the recipe's log. A recipe's log is worth exactly its promise to
 *     hold the recipe's output; `[odu] pushing 4 result paths…` in the middle
 *     of it breaks that promise for every reader that greps one;
 *   - the step's states are observable in order: a recipe that exits 0 opens
 *     `pushing`, and the node stays `running` until the push lands, because a
 *     green node that had warmed nothing is the lie 4.1 exists to prevent —
 *     and the RECIPE's own duration is published with that `pushing`, because
 *     a reader whose recipe has no end cannot place the push beside it;
 *   - a push that FAILS makes the node RED, with the client's own sentence in
 *     the PUSH log, and a `failed` push step beside the recipe that passed;
 *   - a rerun RETRACTS the step and re-opens both logs — a node about to run
 *     again has pushed nothing yet, and a push stream left sealed would turn
 *     the next attempt's first line into a throw;
 *   - a node with nothing fresh to send has NO step at all: no `push` on the
 *     wire, and an empty push log rather than a fabricated zero;
 *   - a recipe that FAILED is not pushed — its `result` is the previous run's
 *     link, and storing it would publish bytes this run never produced;
 *   - a lane with no push configuration never calls the pusher, which is every
 *     run whose checkout names no odu cache.
 *
 * Driven through the lane's own stdio surface rather than against
 * `spawnNode`: the thing being asserted is what a COORDINATOR sees on the
 * `nodes` cell and the two log streams, and those are the wires it reads.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { stdioLink } from "@kolu/surface/links/stdio";
import { createLoopbackPair, greetLoopback } from "@kolu/surface/loopback";
import { serveOverStdio } from "@kolu/surface/peer-server";
import type { LogStream } from "@odu/run-client/nodeId";
import type { NodesSnapshot } from "@odu/run-client/surface";
import { firstFrame, runUnary, subscribe } from "../common/effectEdge";
import { type LaneClient, laneClientOver, laneSurface } from "../common/laneSurface";
import type { TaskSpec } from "../common/spec";
import { createLaneRunner } from "./runner";
import {
  type LanePusher,
  type PushConfig,
  type PushedFact,
  pushFailureSentenceIn,
} from "./pushResults";

const PUSH_ENV = {
  ODU_CACHE_ORIGIN: "https://odu.example.org",
  ODU_CACHE_BUCKET: "main",
  ODU_CACHE_TOKEN: "odu_run_token",
};

/** The one line every announcing stub puts on the push stream, so a test can
 *  ask which log it landed in by looking for it. */
const PUSH_LINE = "[odu] 3 paths in the closure: 1 to push";

interface Lane {
  client: LaneClient;
  states: NodesSnapshot[];
  configure: (tasks: TaskSpec[]) => Promise<{ ok: boolean; error: string | null }>;
  /** This node's log, by stream — the same `{ id, stream }` subscription the
   *  coordinator opens. Absent `stream` is the recipe's, which is what every
   *  reader that does not say otherwise means. */
  logOf: (id: string, stream?: LogStream) => Promise<string>;
  rerun: (id: string) => Promise<{ ok: boolean }>;
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
    logOf: async (id, stream = "recipe") => {
      const frame = await firstFrame(client.surface.nodeLog.get({ id, stream }));
      return frame !== undefined && frame.kind !== "end" ? frame.text : "";
    },
    rerun: (id) => runUnary(client.surface.node.rerun({ id })),
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

/** The three sinks the runner hands a push. Named so a stub can take them. */
type PushHooks = Parameters<LanePusher["push"]>[2];

/**
 * A pusher the test scripts call by call: it records what it was asked (so a
 * test can pin the configuration that reached it) and answers as the test
 * says. `call` is 0-based, which is how a rerun states "and the second time,
 * this".
 */
function stubPusher(
  answer: (hooks: PushHooks, call: number) => Promise<PushedFact | null>,
): LanePusher & { calls: PushConfig[] } {
  const calls: PushConfig[] = [];
  return {
    calls,
    push: async (_workdir, config, hooks) => {
      calls.push(config);
      return answer(hooks, calls.length - 1);
    },
  };
}

/** What an announcing push does before it answers — the real one's order,
 *  which the runner relies on: the step OPENS (`begin`), and only then does
 *  anything land on the push stream. A pusher with nothing fresh to send
 *  calls neither, which is `stubPusher(async () => null)`. */
const announce = (hooks: PushHooks): void => {
  hooks.begin();
  hooks.say(PUSH_LINE);
};

/** How many times `needle` occurs in `haystack` — a rerun's logs are asserted
 *  by COUNT, because "the line is there" cannot tell a re-opened log from one
 *  that kept the previous attempt's bytes and appended to them. */
const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe("a lane node that pushes what it built", () => {
  it("carries the push step on the node, and the client's lines in the PUSH log", async () => {
    const pusher = stubPusher(async (hooks) => {
      announce(hooks);
      return { paths: 4, bytes: 2_097_152 };
    });
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
    const push = last(l).nodes.build?.push;
    expect(push?.state).toBe("pushed");
    expect(push).toMatchObject({ paths: 4, bytes: 2_097_152 });
    // THE RUNNER TIMED IT. The pusher reports no duration at all any more, so
    // a number here can only have come from the lane's own clock — the same
    // one the failure path reads.
    expect(push?.state === "pushed" && push.durationMs).toBeGreaterThanOrEqual(0);

    // AND THE TWO LOGS STAYED APART. The recipe's holds the recipe's output
    // and nothing else; the push's holds the push's.
    const recipeLog = await l.logOf("build");
    expect(recipeLog).toContain("built");
    expect(recipeLog).not.toContain("[odu]");
    expect(await l.logOf("build", "push")).toContain(PUSH_LINE);
  });

  it("opens `pushing` while it uploads, and the node is not green until it lands", async () => {
    // THE STEP HAS A BEGINNING, and a minute-long upload must look like one.
    // A push that appeared only in its finished form would paint a node that
    // sat idle and then claimed some bytes out of nothing.
    // A GATE, not a sleep: the upload is held open until this test says so,
    // which is what makes `pushing` observable without racing a duration.
    const landed = Promise.withResolvers<void>();
    const pusher = stubPusher(async (hooks) => {
      announce(hooks);
      await landed.promise;
      return { paths: 1, bytes: 10 };
    });
    const l = await lane(pusher);
    await l.configure([
      { id: "build", command: "echo built", needs: [], env: PUSH_ENV },
    ]);

    await until(() => last(l).nodes.build?.push?.state === "pushing");
    // GREEN MEANS WARMED: the recipe is over (its log already has its output)
    // and the node is still `running`, because what it built is not on the
    // bucket yet.
    expect(last(l).nodes.build?.status).toBe("running");
    // A step that is only starting has no counts to give, and the wire says
    // so by carrying none.
    expect(last(l).nodes.build?.push).toEqual({ state: "pushing" });
    // AND THE RECIPE'S OWN DURATION IS ALREADY PUBLISHED. It is a fact the
    // moment the child exits 0, and withholding it until the push ends left
    // every reader with a recipe that reads as STILL RUNNING for the whole
    // minute an upload takes — a bar with no end, and so a push step with no
    // room on the timeline to draw into (the `pushing` segment never
    // rendered at all). The number is the RECIPE's: this test's recipe is
    // `echo built`, which can finish inside a millisecond, so what is
    // asserted is that there IS one.
    const recipeMs = last(l).nodes.build?.durationMs;
    expect(recipeMs).not.toBeNull();
    expect(recipeMs).toBeGreaterThanOrEqual(0);

    landed.resolve();
    await until(() => last(l).nodes.build?.status === "ok");
    expect(last(l).nodes.build?.push).toMatchObject({
      state: "pushed",
      paths: 1,
      bytes: 10,
    });
    // AND IT DID NOT MOVE. The gate above held the upload open for however
    // long this test took; a `durationMs` that absorbed it would silently
    // change what every timing surface in the tree reports. The push's own
    // time lives on the push.
    expect(last(l).nodes.build?.durationMs).toBe(recipeMs ?? -1);
  });

  it("goes RED when the push failed, with the push's own sentence in the PUSH log", async () => {
    const pusher = stubPusher(async (hooks) => {
      announce(hooks);
      throw new Error("odu: 1 path could not be pushed to main — 413 too large");
    });
    const l = await lane(pusher);
    await l.configure([
      { id: "build", command: "echo built", needs: [], env: PUSH_ENV },
    ]);
    await until(() => last(l).nodes.build?.status === "failed");

    const node = last(l).nodes.build;
    // The RECIPE exited 0 — the exit code says so — and the node is red
    // anyway, because green means warmed. The step that failed says which
    // half failed, which a bare red status cannot.
    expect(node?.exitCode).toBe(0);
    expect(node?.push?.state).toBe("failed");
    expect(
      node?.push?.state === "failed" && node.push.durationMs,
    ).toBeGreaterThanOrEqual(0);
    // THE SENTENCE IS IN THE PUSH LOG. The recipe passed, and its log keeps
    // saying exactly that.
    expect(await l.logOf("build", "push")).toContain("413 too large");
    expect(await l.logOf("build")).not.toContain("413 too large");
    // AND IT IS THE SENTENCE A READER GETS BACK. The coordinator does not
    // keep this log — it reads the client's words off the frames crossing
    // its tap and puts them in the journal's `push_failed`, so what reaches
    // a catalog a week later is the reason and not a pointer at a log that
    // reader may not have. This is the wire between the two ends, over the
    // real lane: the marker the runner writes and the reader that owns it.
    expect(pushFailureSentenceIn(await l.logOf("build", "push"))).toBe(
      "odu: 1 path could not be pushed to main — 413 too large",
    );
  });

  it("RETRACTS the push on a rerun that finds nothing fresh", async () => {
    // THE CASE THE RETRACTION EXISTS FOR. A rerun's push usually finds
    // nothing new — every path the recipe builds is already on the bucket
    // from the attempt before — so without a retraction the previous
    // attempt's counts would stand for good over an attempt that pushed
    // nothing, on the board and in `run_read`.
    const pusher = stubPusher(async (hooks, call) => {
      if (call > 0) return null;
      announce(hooks);
      return { paths: 2, bytes: 20 };
    });
    const l = await lane(pusher);
    await l.configure([
      { id: "build", command: "echo built", needs: [], env: PUSH_ENV },
    ]);
    await until(() => last(l).nodes.build?.push?.state === "pushed");

    expect(await l.rerun("build")).toEqual({ ok: true });
    await until(
      () => pusher.calls.length === 2 && last(l).nodes.build?.status === "ok",
    );
    // The key is DROPPED, not zeroed: `{ push: undefined }` would read as
    // present to anything that asks.
    expect(last(l).nodes.build?.push).toBeUndefined();
    // And the push log is EMPTY again — the rerun reset it, so the previous
    // attempt's narration is not left standing under a node that pushed
    // nothing this time.
    expect(await l.logOf("build", "push")).toBe("");
  });

  it("RE-OPENS both logs for a rerun that pushes again", async () => {
    // A log's terminal is a promise that nothing more is coming, and
    // appending past one THROWS by design — so a push stream the rerun left
    // sealed would turn the next attempt's first `[odu]` line into a failed
    // node. That the node is green here is half the assertion.
    const pusher = stubPusher(async (hooks) => {
      announce(hooks);
      return { paths: 2, bytes: 20 };
    });
    const l = await lane(pusher);
    await l.configure([
      { id: "build", command: "echo built", needs: [], env: PUSH_ENV },
    ]);
    await until(() => last(l).nodes.build?.push?.state === "pushed");

    expect(await l.rerun("build")).toEqual({ ok: true });
    await until(
      () => pusher.calls.length === 2 && last(l).nodes.build?.push?.state === "pushed",
    );
    expect(last(l).nodes.build?.status).toBe("ok");
    // THE COUNT is what distinguishes a re-opened log from one that kept the
    // previous attempt's bytes and appended to them.
    expect(occurrences(await l.logOf("build", "push"), PUSH_LINE)).toBe(1);
    expect(occurrences(await l.logOf("build"), "built")).toBe(1);
  });

  it("has NO push step when there was nothing fresh to send", async () => {
    // Every recipe in a DAG typically leaves the same `./result`, so the
    // second node to look at it has nothing new — which is not the same as
    // pushing zero, and the wire says the difference by carrying no step at
    // all. The push log is EMPTY rather than absent: a reader can still open
    // it and be told, at once, that there is nothing there.
    const pusher = stubPusher(async () => null);
    const l = await lane(pusher);
    await l.configure([
      { id: "build", command: "echo built", needs: [], env: PUSH_ENV },
    ]);
    await until(() => last(l).nodes.build?.status === "ok");

    expect(pusher.calls).toHaveLength(1);
    expect(last(l).nodes.build?.push).toBeUndefined();
    expect(await l.logOf("build", "push")).toBe("");
  });

  it("does not push a recipe that FAILED", async () => {
    const pusher = stubPusher(async () => ({ paths: 1, bytes: 1 }));
    const l = await lane(pusher);
    await l.configure([
      { id: "build", command: "exit 3", needs: [], env: PUSH_ENV },
    ]);
    await until(() => last(l).nodes.build?.status === "failed");
    // ITS `result` IS LAST RUN'S LINK. Pushing it would store bytes this run
    // never produced.
    expect(pusher.calls).toEqual([]);
    expect(last(l).nodes.build?.exitCode).toBe(3);
    expect(last(l).nodes.build?.push).toBeUndefined();
  });

  it("never reaches the pusher for a lane with no push configuration", async () => {
    const pusher = stubPusher(async () => ({ paths: 1, bytes: 1 }));
    const l = await lane(pusher);
    await l.configure([{ id: "build", command: "echo built", needs: [] }]);
    await until(() => last(l).nodes.build?.status === "ok");
    expect(pusher.calls).toEqual([]);
    expect(last(l).nodes.build?.push).toBeUndefined();
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
