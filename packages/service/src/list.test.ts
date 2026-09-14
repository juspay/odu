/**
 * `run.list` through the real runtime, and the poller that keeps it fresh.
 *
 * `run.list` exists because the faces that needed ONE run by where it came
 * from read the whole board a row per round trip (juspay/odu#113). What these
 * pin is the part a registry test cannot: that the procedure is in the
 * DISPATCH, refuses what it must, and sees a run the caller has just started —
 * the ordinary agent loop of `run_start` then "which run is mine".
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { buildSurfaceFace } from "@kolu/surface/client";
import { directDispatch } from "@kolu/surface/links/direct";
import {
  type OduServiceClient,
  oduServiceSurface,
  ServiceRefused,
} from "@odu/service-client/surface";
import {
  makeWorld,
  recordingPorts,
  registerFixtureRun,
  type World,
} from "./fixture.testlib";
import { everyAfter, slowTickReporter, type Timers } from "./poller";
import { createOduService } from "./service";

let world: World | null = null;
afterEach(() => {
  world?.dispose();
  world = null;
});

const HEAD = "a".repeat(40);

function serve(w: World, ports = recordingPorts()) {
  const built = createOduService({
    ports,
    origin: "http://127.0.0.1:0",
    home: w.requestsRoot,
    build: { oduVersion: "0.1.0", buildId: "test", commit: "", self: null },
    catalog: { root: w.catalogRoot },
    requestsRoot: w.requestsRoot,
    onDrain: () => {},
  });
  const face = buildSurfaceFace(
    oduServiceSurface,
    directDispatch(built.runtime),
  ) as unknown as OduServiceClient;
  return { face, close: () => built.close() };
}

async function call<A>(
  effect: Effect.Effect<A, unknown>,
): Promise<{ ok: true; value: A } | { ok: false; code: string }> {
  const outcome = await Effect.runPromise(Effect.result(effect));
  if (outcome._tag === "Success") return { ok: true, value: outcome.success };
  return outcome.failure instanceof ServiceRefused
    ? { ok: false, code: outcome.failure.code }
    : { ok: false, code: `(not a refusal: ${String(outcome.failure)})` };
}

describe("run.list", () => {
  it("refuses a relative checkout, a non-commit sha, and a seq with no sha", async () => {
    world = makeWorld();
    const { face, close } = serve(world);
    try {
      const relative = await call(face.surface.run.list({ checkout: "." }));
      expect(relative).toEqual({ ok: false, code: "checkout_refused" });
      const short = await call(face.surface.run.list({ sha: "abc" }));
      expect(short).toEqual({ ok: false, code: "bad_input" });
      const notHex = await call(face.surface.run.list({ sha: "zzzzzzz" }));
      expect(notHex).toEqual({ ok: false, code: "bad_input" });
      const orphanSeq = await call(face.surface.run.list({ seq: 1 }));
      expect(orphanSeq).toEqual({ ok: false, code: "bad_input" });
    } finally {
      await close();
    }
  });

  it("answers the filtered board in one call", async () => {
    world = makeWorld();
    const w = world;
    const older = registerFixtureRun(w, { repoRoot: "/code/a", sha: HEAD, now: 1_000_000 });
    registerFixtureRun(w, { repoRoot: "/code/b", sha: HEAD, now: 2_000_000 });
    const newer = registerFixtureRun(w, { repoRoot: "/code/a", sha: HEAD, seq: 2, now: 3_000_000 });
    const { face, close } = serve(w);
    try {
      const mine = await call(face.surface.run.list({ checkout: "/code/a", limit: 1 }));
      expect(mine.ok).toBe(true);
      if (!mine.ok) return;
      expect(mine.value.rows.map((r) => r.runId)).toEqual([newer.runId]);
      expect(mine.value.total).toBe(2);

      const ref = await call(face.surface.run.list({ sha: HEAD.slice(0, 7), seq: 1 }));
      expect(ref.ok && ref.value.total).toBe(2);

      const scoped = await call(
        face.surface.run.list({ checkout: "/code/a", sha: HEAD.slice(0, 7), seq: 1 }),
      );
      expect(scoped.ok && scoped.value.rows.map((r) => r.runId)).toEqual([older.runId]);
    } finally {
      await close();
    }
  });

  it("sees a run the caller just started, without waiting for a tick", async () => {
    // `run.start` refreshes before it answers, so the very next `run.list` —
    // an agent's "which run is mine" — must find it. The stub launcher
    // registers the run the way a coordinator would.
    world = makeWorld();
    const w = world;
    const ports = recordingPorts({
      launch: (request) => {
        registerFixtureRun(w, {
          repoRoot: request.checkout,
          sha: request.expectedSha,
          runId: request.runId,
        });
        return { ok: true, runId: request.runId, endpoint: "/tmp/x.sock" };
      },
    });
    const { face, close } = serve(w, ports);
    try {
      const started = await call(
        face.surface.run.start({ checkout: "/code/app", expectedSha: HEAD, requestId: "req-1" }),
      );
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const listed = await call(face.surface.run.list({ checkout: "/code/app" }));
      expect(listed.ok && listed.value.rows.map((r) => r.runId)).toEqual([
        started.value.runId,
      ]);
    } finally {
      await close();
    }
  });
});

/** Timers a test drives by hand: `fire` runs whatever is armed. */
function manualTimers(): Timers & { armed: number; fire: () => void; log: string[] } {
  let pending: (() => void) | null = null;
  const self = {
    armed: 0,
    log: [] as string[],
    set: (fn: () => void) => {
      self.armed += 1;
      self.log.push("arm");
      pending = fn;
      return self.armed;
    },
    clear: () => {
      pending = null;
    },
    fire: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
  };
  return self;
}

describe("the poller", () => {
  it("arms the next tick only AFTER the current one returns", () => {
    // The whole fix for back-to-back ticks: `setInterval` fired on the clock
    // whatever the last tick was doing; this arms on completion, so the loop
    // always gets its idle gap and two ticks can never overlap.
    const timers = manualTimers();
    const stop = everyAfter(() => timers.log.push("tick"), 250, timers);
    expect(timers.log).toEqual(["arm"]);
    timers.fire();
    timers.fire();
    // Every arm follows the tick before it; none happens while one is running.
    expect(timers.log).toEqual(["arm", "tick", "arm", "tick", "arm"]);
    stop();
    timers.fire();
    expect(timers.log).toEqual(["arm", "tick", "arm", "tick", "arm"]);
  });

  it("does not re-arm when stopped from inside a tick", () => {
    const timers = manualTimers();
    let stop = (): void => {};
    stop = everyAfter(() => stop(), 250, timers);
    timers.fire();
    expect(timers.armed).toBe(1);
  });

  it("reports a slow tick at most once per window, and a fast one never", () => {
    const seen: { durationMs: number; runs: number }[] = [];
    const report = slowTickReporter(250, (facts) => seen.push(facts), 60_000);
    report(10, 700, 0);
    report(900, 700, 1_000);
    report(1_100, 700, 30_000);
    report(1_000, 710, 62_000);
    expect(seen).toEqual([
      { durationMs: 900, runs: 700 },
      { durationMs: 1_000, runs: 710 },
    ]);
  });
});
