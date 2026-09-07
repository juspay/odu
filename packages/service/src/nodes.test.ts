/**
 * `streams.nodes` — a snapshot, then only what moved, then a terminal.
 *
 * The two properties worth pinning are the ones a consumer would otherwise have
 * to discover: an unchanged run produces NO frame (so an idle detail view costs
 * nothing), and the terminal frame carries its content (so a view holding the
 * latest frame does not go blank at the exact moment the run finishes).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Stream } from "effect";
import type { NodesFrame } from "@odu/service-client/surface";
import {
  finalizeRun,
  makeWorld,
  registerFixtureRun,
  type World,
  writeNode,
  writeRoster,
} from "./fixture.testlib";
import { nodesSource } from "./nodes";
import { createRegistry } from "./registry";

let world: World | null = null;
const open = (): World => {
  world = makeWorld();
  return world;
};
afterEach(() => {
  world?.dispose();
  world = null;
});

/** Drain the stream to its terminal, with the poller under the test's control:
 *  `poll` re-reads the catalog, and `sleep` returns immediately, so the stream
 *  advances at the speed of the assertions rather than of a clock. */
async function drain(
  source: (input: { runId: string }) => Stream.Stream<NodesFrame>,
  runId: string,
  max = 20,
): Promise<NodesFrame[]> {
  return Effect.runPromise(
    Stream.runCollect(Stream.take(source({ runId }), max)),
  ).then((chunk) => [...chunk]);
}

describe("the nodes stream", () => {
  it("opens with a snapshot and ends when the run has settled", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: "a".repeat(40) });
    writeRoster(fixture.handle, fixture.token, ["unit@x86_64-linux"]);
    writeNode(w, fixture.handle, fixture.token, { id: "unit@x86_64-linux", status: "ok" });
    finalizeRun(fixture.handle, fixture.token, "passed");

    const registry = createRegistry({ root: w.catalogRoot });
    const source = nodesSource({
      registry,
      poll: () => registry.refresh(),
      sleep: async () => {},
    });
    const frames = await drain(source, fixture.runId);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.done).toBe(true);
    // The terminal frame CARRIES its content — a view holding the latest frame
    // does not go blank when the run finishes.
    expect(frames[0]?.nodes.map((n) => n.id)).toEqual(["unit@x86_64-linux"]);
    expect(frames[0]?.state).toBe("settled");
  });

  it("emits nothing while nothing moves", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: "b".repeat(40) });
    writeRoster(fixture.handle, fixture.token, ["unit@x86_64-linux", "e2e@x86_64-linux"]);
    writeNode(w, fixture.handle, fixture.token, { id: "unit@x86_64-linux", status: "ok" });

    const registry = createRegistry({ root: w.catalogRoot });
    const source = nodesSource({
      registry,
      poll: () => registry.refresh(),
      // A REAL delay, unlike the other tests here: this run never settles, so
      // the loop is only left by an interrupt — and an interrupt has to be
      // observable at a yield point. A zero-delay sleep would spin the
      // generator hot and the deadline below would never land.
      sleep: (ms, signal) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, Math.min(ms, 5));
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        }),
    });
    // Collect for a bounded window and assert the opening snapshot was the only
    // frame in it.
    const frames: NodesFrame[] = [];
    const collected = await Effect.runPromise(
      Effect.result(
        Effect.timeout(
          Stream.runForEach(source({ runId: fixture.runId }), (frame) =>
            Effect.sync(() => {
              frames.push(frame);
            }),
          ),
          150,
        ),
      ),
    );
    // The deadline is how this ends: a stream that had terminated on its own
    // would be a run that settled, which this one has not.
    expect(collected._tag).toBe("Failure");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.done).toBe(false);
  });

  it("emits again when a node actually moves", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: "c".repeat(40) });
    writeRoster(fixture.handle, fixture.token, ["unit@x86_64-linux"]);
    const registry = createRegistry({ root: w.catalogRoot });
    let polls = 0;
    const source = nodesSource({
      registry,
      poll: () => {
        polls += 1;
        // The node lands between the first frame and the second.
        if (polls === 2) {
          writeNode(w, fixture.handle, fixture.token, {
            id: "unit@x86_64-linux",
            status: "failed",
          });
          finalizeRun(fixture.handle, fixture.token, "failed", ["unit@x86_64-linux"]);
        }
        registry.refresh();
      },
      sleep: async () => {},
    });
    const frames = await drain(source, fixture.runId);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.nodes[0]?.status).toBe("pending");
    expect(frames[1]?.nodes[0]?.status).toBe("failed");
    expect(frames[1]?.done).toBe(true);
  });

  it("answers a run it has never heard of, rather than hanging", async () => {
    // "There is no such run here" is an answer. A subscription that waited for
    // one to appear would be indistinguishable from a run that is merely quiet.
    const w = open();
    const registry = createRegistry({ root: w.catalogRoot });
    const source = nodesSource({
      registry,
      poll: () => registry.refresh(),
      sleep: async () => {},
    });
    const frames = await drain(source, "0zzzzzzzz-zzzzzzzz");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.done).toBe(true);
    expect(frames[0]?.state).toBe("expired");
    expect(frames[0]?.nodes).toEqual([]);
  });
});
