import { afterEach, describe, expect, it } from "bun:test";
import { importedRunId } from "@odu/run-history/import";
import type { CheckoutFrame } from "@odu/service-client/surface";
import { Effect, Fiber, Stream } from "effect";
import { checkoutSource } from "./checkout";
import {
  finalizeRun,
  makeWorld,
  registerFixtureRun,
  type World,
  writeNode,
  writeRoster,
} from "./fixture.testlib";
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

function sourceOver(w: World): (input: {
  repoRoot: string;
}) => Stream.Stream<CheckoutFrame> {
  const registry = createRegistry({ root: w.catalogRoot });
  return checkoutSource({
    registry,
    poll: () => registry.refresh(),
    sleep: () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  });
}

async function take(
  source: (input: { repoRoot: string }) => Stream.Stream<CheckoutFrame>,
  repoRoot: string,
  count: number,
): Promise<CheckoutFrame[]> {
  return Effect.runPromise(
    Stream.runCollect(Stream.take(source({ repoRoot }), count)),
  ).then((chunk) => [...chunk]);
}

function pollGate(): {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  parked: () => Promise<void>;
  release: () => void;
} {
  let releaseSleep: (() => void) | null = null;
  let announceParked: (() => void) | null = null;
  let parkedAlready = false;
  return {
    sleep: (_ms, signal) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      releaseSleep = resolve;
      signal.addEventListener("abort", () => resolve(), { once: true });
      if (announceParked === null) parkedAlready = true;
      else {
        const announce = announceParked;
        announceParked = null;
        announce();
      }
      return promise;
    },
    parked: () => {
      if (parkedAlready) {
        parkedAlready = false;
        return Promise.resolve();
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      announceParked = resolve;
      return promise;
    },
    release: () => {
      const resume = releaseSleep;
      releaseSleep = null;
      resume?.();
    },
  };
}

describe("the checkout stream", () => {
  it("answers for a checkout with no runs at all", async () => {
    const w = open();
    const frames = await take(sourceOver(w), "/code/never-run", 1);
    expect(frames).toEqual([{ latest: null, recent: [], total: 0 }]);
  });

  it("opens with the newest run and that run's work, in one frame", async () => {
    const w = open();
    const t0 = Date.now();
    const old = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "a".repeat(40),
      now: t0,
    });
    writeRoster(old.handle, old.token, ["unit@x86_64-linux"]);
    writeNode(w, old.handle, old.token, {
      id: "unit@x86_64-linux",
      status: "failed",
      exitCode: 1,
    });
    finalizeRun(old.handle, old.token, "failed", ["unit@x86_64-linux"]);

    const latest = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "b".repeat(40),
      now: t0 + 1_000,
    });
    writeRoster(latest.handle, latest.token, ["fmt@x86_64-linux"]);
    writeNode(w, latest.handle, latest.token, {
      id: "fmt@x86_64-linux",
      status: "ok",
    });
    finalizeRun(latest.handle, latest.token, "passed");

    const elsewhere = registerFixtureRun(w, {
      repoRoot: "/code/other",
      sha: "c".repeat(40),
      now: t0 + 2_000,
    });
    finalizeRun(elsewhere.handle, elsewhere.token, "passed");

    const [frame] = await take(sourceOver(w), "/code/app", 1);
    expect(frame?.latest?.run.runId).toBe(latest.runId);
    expect(frame?.latest?.nodes.map((node) => node.id)).toEqual([
      "fmt@x86_64-linux",
    ]);
    expect(frame?.recent.map((run) => run.runId)).toEqual([
      latest.runId,
      old.runId,
    ]);
    expect(frame?.total).toBe(2);
  });

  it("stands for the newest run by its clock, beside an imported one", async () => {
    const w = open();
    const t0 = Date.now();
    const importedAt = t0 - 365 * 24 * 60 * 60 * 1_000;
    const imported = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "a".repeat(40),
      now: importedAt,
      runId: importedRunId({
        repo: "juspay/odu",
        sha: "a".repeat(40),
        seq: 1,
        startedAt: importedAt,
      }),
    });
    finalizeRun(imported.handle, imported.token, "passed");

    const today = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "b".repeat(40),
      now: t0,
    });
    finalizeRun(today.handle, today.token, "passed");

    expect(imported.runId > today.runId).toBe(true);

    const [frame] = await take(sourceOver(w), "/code/app", 1);
    expect(frame?.latest?.run.runId).toBe(today.runId);
    expect(frame?.recent.map((run) => run.runId)).toEqual([
      today.runId,
      imported.runId,
    ]);
  });

  it("swaps the latest run — and its work — inside one subscription", async () => {
    const w = open();
    const t0 = Date.now();
    const first = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "a".repeat(40),
      now: t0,
    });
    writeRoster(first.handle, first.token, ["unit@x86_64-linux"]);
    writeNode(w, first.handle, first.token, {
      id: "unit@x86_64-linux",
      status: "ok",
    });
    finalizeRun(first.handle, first.token, "passed");

    const source = sourceOver(w);
    const frames: CheckoutFrame[] = [];
    const subscription = Effect.runPromise(
      Stream.runForEach(
        Stream.take(source({ repoRoot: "/code/app" }), 2),
        (frame) =>
          Effect.sync(() => {
            frames.push(frame);
            if (frames.length === 1) {
              const second = registerFixtureRun(w, {
                repoRoot: "/code/app",
                sha: "d".repeat(40),
                now: t0 + 1_000,
              });
              writeRoster(second.handle, second.token, ["e2e@x86_64-linux"]);
              writeNode(w, second.handle, second.token, {
                id: "e2e@x86_64-linux",
                status: "ok",
              });
              finalizeRun(second.handle, second.token, "passed");
            }
          }),
      ),
    );
    await subscription;

    expect(frames[0]?.latest?.run.runId).toBe(first.runId);
    expect(frames[0]?.total).toBe(1);
    expect(frames[1]?.latest?.run.runId).not.toBe(first.runId);
    expect(frames[1]?.latest?.nodes.map((node) => node.id)).toEqual([
      "e2e@x86_64-linux",
    ]);
    expect(frames[1]?.total).toBe(2);
  });

  it("says nothing while the checkout is quiet, and speaks when it moves", async () => {
    const w = open();
    const quietT0 = Date.now();
    const first = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "a".repeat(40),
      now: quietT0,
    });
    writeRoster(first.handle, first.token, ["unit@x86_64-linux"]);
    writeNode(w, first.handle, first.token, {
      id: "unit@x86_64-linux",
      status: "ok",
    });
    finalizeRun(first.handle, first.token, "passed");

    const registry = createRegistry({ root: w.catalogRoot });
    const gate = pollGate();
    const source = checkoutSource({
      registry,
      poll: () => registry.refresh(),
      sleep: gate.sleep,
    });
    const frames: CheckoutFrame[] = [];
    let delivered: (() => void) | null = null;
    const fiber = Effect.runFork(
      Stream.runForEach(source({ repoRoot: "/code/app" }), (frame) =>
        Effect.sync(() => {
          frames.push(frame);
          const announce = delivered;
          delivered = null;
          announce?.();
        }),
      ),
    );
    const firstFrame = new Promise<void>((resolve) => {
      delivered = resolve;
    });

    await firstFrame;
    expect(frames).toHaveLength(1);
    for (let i = 0; i < 3; i += 1) {
      gate.release();
      await gate.parked();
      expect(frames).toHaveLength(1);
    }

    const second = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: "d".repeat(40),
      now: quietT0 + 1_000,
    });
    finalizeRun(second.handle, second.token, "passed");
    const nextFrame = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    gate.release();
    await nextFrame;
    expect(frames).toHaveLength(2);
    expect(frames[1]?.latest?.run.runId).toBe(second.runId);

    await Effect.runPromise(Fiber.interrupt(fiber));
  });
});
