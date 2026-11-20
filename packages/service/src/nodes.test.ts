import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Stream } from "effect";
import { type NodesFrame, UNKNOWN_ENV } from "@odu/service-client/surface";
import {
  finalizeRun,
  makeWorld,
  registerFixtureRun,
  type World,
  writeLane,
  writeNode,
  writePhase,
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
      exists: () => true,
      poll: () => registry.refresh(),
      sleep: async () => {},
    });
    const frames = await drain(source, fixture.runId);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.done).toBe(true);
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
      exists: () => true,
      poll: () => registry.refresh(),
      sleep: (ms, signal) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, Math.min(ms, 5));
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        }),
    });
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
      exists: () => true,
      poll: () => {
        polls += 1;
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
    const w = open();
    const registry = createRegistry({ root: w.catalogRoot });
    const source = nodesSource({
      registry,
      exists: () => false,
      poll: () => registry.refresh(),
      sleep: async () => {},
    });
    const frames = await drain(source, "0zzzzzzzz-zzzzzzzz");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.done).toBe(true);
    expect(frames[0]?.state).toBe("expired");
    expect(frames[0]?.nodes).toEqual([]);
    expect(frames[0]?.env).toEqual(UNKNOWN_ENV);
  });

  it("carries the run's environment on every frame", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "d".repeat(40),
      repo: "juspay/odu",
    });
    writePhase(fixture.handle, fixture.token, "lanes");
    writeLane(fixture.handle, fixture.token, {
      platform: "x86_64-linux",
      state: "leased",
      host: "builder-1",
      hostsSource: "/code/app/.ci/hosts.toml",
    });
    writeRoster(fixture.handle, fixture.token, ["unit@x86_64-linux"]);
    writeNode(w, fixture.handle, fixture.token, { id: "unit@x86_64-linux", status: "ok" });
    finalizeRun(fixture.handle, fixture.token, "passed");

    const registry = createRegistry({ root: w.catalogRoot });
    const source = nodesSource({
      registry,
      exists: () => true,
      poll: () => registry.refresh(),
      sleep: async () => {},
    });
    const frames = await drain(source, fixture.runId);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.env.phase).toBe("lanes");
    expect(frames[0]?.env.lanes).toEqual([
      { state: "leased", platform: "x86_64-linux", host: "builder-1" },
    ]);
    expect(frames[0]?.env.hostsSource).toBe("/code/app/.ci/hosts.toml");
  });

  it("emits again when a LANE moves, even though no node did", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: "e".repeat(40) });
    writeRoster(fixture.handle, fixture.token, ["unit@x86_64-linux"]);
    writeLane(fixture.handle, fixture.token, {
      platform: "x86_64-linux",
      state: "claiming",
      host: null,
      pool: ["builder-1", "builder-2"],
    });
    const registry = createRegistry({ root: w.catalogRoot });
    let polls = 0;
    const source = nodesSource({
      registry,
      exists: () => true,
      poll: () => {
        polls += 1;
        if (polls === 2) {
          writeLane(fixture.handle, fixture.token, {
            platform: "x86_64-linux",
            state: "leased",
            host: "builder-2",
          });
        }
        if (polls === 3) {
          finalizeRun(fixture.handle, fixture.token, "incomplete");
        }
        registry.refresh();
      },
      sleep: async () => {},
    });
    const frames = await drain(source, fixture.runId);
    expect(frames).toHaveLength(3);
    expect(frames[0]?.env.lanes).toEqual([
      { state: "claiming", platform: "x86_64-linux", pool: ["builder-1", "builder-2"] },
    ]);
    expect(frames[1]?.env.lanes).toEqual([
      { state: "leased", platform: "x86_64-linux", host: "builder-2" },
    ]);
    expect(frames[1]?.nodes).toEqual(frames[0]?.nodes ?? []);
    expect(frames[2]?.done).toBe(true);
  });

  it("emits again when the PHASE moves", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: "f".repeat(40) });
    writeRoster(fixture.handle, fixture.token, ["unit@x86_64-linux"]);
    const registry = createRegistry({ root: w.catalogRoot });
    let polls = 0;
    const source = nodesSource({
      registry,
      exists: () => true,
      poll: () => {
        polls += 1;
        if (polls === 2) writePhase(fixture.handle, fixture.token, "no_lanes");
        if (polls === 3) finalizeRun(fixture.handle, fixture.token, "incomplete");
        registry.refresh();
      },
      sleep: async () => {},
    });
    const frames = await drain(source, fixture.runId);
    expect(frames).toHaveLength(3);
    expect(frames[0]?.env.phase).toBe("provisioning");
    expect(frames[1]?.env.phase).toBe("no_lanes");
  });
});
