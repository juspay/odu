/**
 * A RUN NOBODY IS SERVING ANY MORE GIVES ITS WRITE TOKEN BACK (PLAN 4.1).
 *
 * The revoke is driven off the PROJECTION rather than off the coordinator, and
 * that is the design: the coordinator writes `finalized` and then dies, and it
 * holds no authority over a cache in any case. Four things follow, and all
 * four are here:
 *
 *   - a RUNNING run keeps its token, because its lane is still pushing;
 *   - a LINGERING one keeps it too. `--linger` exists so a node can be rerun
 *     after the run drains, and revoking at first settle met that rerun with a
 *     dead credential — reddening a node for a credential reason, on the one
 *     path linger was added for;
 *   - a run that RELEASED its endpoint gives it back, whatever the outcome;
 *   - a run whose OWNER IS LOST gives it back too — nobody wrote `finalized`
 *     there, and keying on that line alone would leave the credential of every
 *     crashed coordinator live until it expired.
 *
 * And the first projection after a restart upserts every run in the catalog,
 * which is what makes this crash-safe without a second record to keep.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { CI_CONTRACT_VERSION } from "@odu/service-client/surface";
import { CI_ROW } from "@odu/service-client/surface";
import { appendEvent, writeVerdict } from "@odu/run-history/store";
import { releaseOwnership } from "@odu/run-history/owner";
import {
  crashOwner,
  makeWorld,
  recordingPorts,
  registerFixtureRun,
  type RecordingPorts,
  type World,
} from "./fixture.testlib";
import { createOduService } from "./service";

let world: World | null = null;
afterEach(() => {
  world?.dispose();
  world = null;
});

const SHA = "a".repeat(40);
const PUSH = {
  target: {
    substituter: "https://cache.kolu.dev/kolu-r2",
    bucket: "kolu-r2",
    tokenId: "tok-live",
  },
  note: null,
};

/** A service over this world, refreshed once so every run is projected. */
function project(w: World, ports: RecordingPorts): { close: () => Promise<void> } {
  const built = createOduService({
    ports,
    origin: "http://127.0.0.1:0",
    home: w.requestsRoot,
    build: { oduVersion: "0.1.0", buildId: "test", commit: "", self: null },
    rows: { [CI_ROW]: CI_CONTRACT_VERSION },
    catalog: { root: w.catalogRoot },
    requestsRoot: w.requestsRoot,
    onDrain: () => {},
  });
  built.refresh();
  return { close: () => built.close() };
}

describe("a run's write token at the end of the run", () => {
  it("is kept while the run is still going", async () => {
    world = makeWorld();
    registerFixtureRun(world, { repoRoot: "/code/app", sha: SHA, push: PUSH });
    const ports = recordingPorts();
    const { close } = project(world, ports);
    try {
      // THE LANE MAY STILL BE PUSHING. Revoking here would turn a green run
      // red on its last recipe.
      expect(ports.pushRevokes).toEqual([]);
    } finally {
      await close();
    }
  });

  it("is KEPT by a lingering coordinator, whose reruns still push", async () => {
    world = makeWorld();
    const run = registerFixtureRun(world, {
      repoRoot: "/code/app",
      sha: SHA,
      push: PUSH,
    });
    appendEvent(run.handle, run.token, { kind: "finalized", outcome: "passed" });
    writeVerdict(run.handle, run.token, {
      runId: run.runId,
      outcome: "passed",
      startedAt: 1_000,
      finishedAt: 2_000,
      failed: [],
      errored: [],
      cancelled: [],
      unposted: [],
    });
    // SETTLED, and still SERVED: the owner is alive and its endpoint stands,
    // which is exactly what `--linger` leaves behind.
    const ports = recordingPorts();
    const { close } = project(world, ports);
    try {
      expect(ports.pushRevokes).toEqual([]);
    } finally {
      await close();
    }
  });

  it("is revoked once the coordinator has let its endpoint go, whatever the outcome", async () => {
    world = makeWorld();
    const run = registerFixtureRun(world, {
      repoRoot: "/code/app",
      sha: SHA,
      push: PUSH,
    });
    appendEvent(run.handle, run.token, { kind: "roster", order: [] });
    appendEvent(run.handle, run.token, { kind: "finalized", outcome: "failed" });
    writeVerdict(run.handle, run.token, {
      runId: run.runId,
      outcome: "failed",
      startedAt: 1_000,
      finishedAt: 2_000,
      failed: [],
      errored: [],
      cancelled: [],
      unposted: [],
    });

    // THE CLEAN EXIT: `releaseOwnership` keeps the epoch and drops the
    // endpoint, which is what says the live surface is gone.
    releaseOwnership(run.token);

    const ports = recordingPorts();
    const { close } = project(world, ports);
    try {
      // FAILED, and the token still goes back: the grant was for the RUN, not
      // for a green one.
      expect(ports.pushRevokes).toEqual(["tok-live"]);
    } finally {
      await close();
    }
  });

  it("is revoked when the coordinator died without finalizing", async () => {
    world = makeWorld();
    const run = registerFixtureRun(world, {
      repoRoot: "/code/app",
      sha: SHA,
      push: PUSH,
      now: Date.now() - 600_000,
    });
    // A DEAD PID ON THIS HOST with a stale heartbeat — the one state a
    // projection cannot see by watching files, and the one `finalized` never
    // covers.
    crashOwner(run.handle, { heartbeatAt: Date.now() - 600_000 });

    const ports = recordingPorts();
    const { close } = project(world, ports);
    try {
      expect(ports.pushRevokes).toEqual(["tok-live"]);
    } finally {
      await close();
    }
  });

  it("is revoked when a LINGERING coordinator was killed after finalizing", async () => {
    // THE COMBINATION THE LINGER FIX OPENED, and the reason the skip asks for
    // liveness rather than for an address: a `--linger` coordinator that
    // wrote `finalized` and then died hard never runs `releaseOwnership`, so
    // its endpoint stands in the owner file for good. A terminal line also
    // beats liveness in the state machine, so the row is `settled` — not
    // `owner_lost` — and a skip keyed on `endpoint !== null && settled` would
    // leave that run's write token live until its 24 h expiry, on a daemon
    // one call away from knowing the process is gone.
    world = makeWorld();
    const run = registerFixtureRun(world, {
      repoRoot: "/code/app",
      sha: SHA,
      push: PUSH,
      now: Date.now() - 600_000,
    });
    appendEvent(run.handle, run.token, { kind: "finalized", outcome: "passed" });
    writeVerdict(run.handle, run.token, {
      runId: run.runId,
      outcome: "passed",
      startedAt: 1_000,
      finishedAt: 2_000,
      failed: [],
      errored: [],
      cancelled: [],
      unposted: [],
    });
    crashOwner(run.handle, { heartbeatAt: Date.now() - 600_000 });

    const ports = recordingPorts();
    const { close } = project(world, ports);
    try {
      expect(ports.pushRevokes).toEqual(["tok-live"]);
    } finally {
      await close();
    }
  });

  it("revokes a token once, however many times the run is re-projected", async () => {
    world = makeWorld();
    const run = registerFixtureRun(world, {
      repoRoot: "/code/app",
      sha: SHA,
      push: PUSH,
    });
    appendEvent(run.handle, run.token, { kind: "finalized", outcome: "passed" });
    writeVerdict(run.handle, run.token, {
      runId: run.runId,
      outcome: "passed",
      startedAt: 1_000,
      finishedAt: 2_000,
      failed: [],
      errored: [],
      cancelled: [],
      unposted: [],
    });
    releaseOwnership(run.token);
    const ports = recordingPorts();
    const built = createOduService({
      ports,
      origin: "http://127.0.0.1:0",
      home: world.requestsRoot,
      build: { oduVersion: "0.1.0", buildId: "test", commit: "", self: null },
      rows: { [CI_ROW]: CI_CONTRACT_VERSION },
      catalog: { root: world.catalogRoot },
      requestsRoot: world.requestsRoot,
      onDrain: () => {},
    });
    try {
      built.refresh();
      built.refresh();
      built.refresh();
      // The revoke is idempotent at the cache, so this is not correctness —
      // it is a board holding a thousand settled runs not issuing a thousand
      // SQLite updates per tick.
      expect(ports.pushRevokes).toEqual(["tok-live"]);
    } finally {
      await built.close();
    }
  });

  it("has nothing to revoke for a run that pushed nowhere", async () => {
    world = makeWorld();
    const run = registerFixtureRun(world, {
      repoRoot: "/code/app",
      sha: SHA,
      push: { target: null, note: "no flake.nix" },
    });
    appendEvent(run.handle, run.token, { kind: "finalized", outcome: "passed" });
    releaseOwnership(run.token);
    const ports = recordingPorts();
    const { close } = project(world, ports);
    try {
      expect(ports.pushRevokes).toEqual([]);
    } finally {
      await close();
    }
  });
});
