/**
 * juspay/odu#84 — a run that exists but has no lanes yet.
 *
 * The coordinator now serves `.ci/odu.sock` *before* it claims a machine, so
 * this suite asserts the thing that window is for: that every read face
 * describes a provisioning run as LIVE, rather than reporting the words it
 * reserves for a run that died or never started.
 *
 * The provisioning state is served through the real socket harness — an
 * all-pending pipeline plus a header whose lanes are still being claimed, which
 * is exactly what `orchestrate` publishes between `serveSocket` and the venue
 * claim. (A localhost lane never claims anything, so the e2e suite's fixtures
 * cannot reach this window; the socket is the seam where it is observable
 * without an ssh host.)
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  EMPTY_HEADER,
  pendingNode,
  type PipelineState,
  type RunHeader,
  runPhase,
} from "../common/surface";
import { toAgentNodes } from "../mcp/agentSurface";
import { agentReaderFromA } from "../mcp/agentSurface";
import { dialSocket } from "../coordinator/socket";
import { waitForSettle } from "../coordinator/waitForSettle";
import { serveTestSurface, type TestSurface } from "../mcp/serveForTest";
import { provisioningLines, runEnvJson, statusCommand } from "./introspect";

const SETUP = "_ci-setup@x86_64-linux";
const FMT = "ci::fmt@x86_64-linux";

/** What `run` publishes the instant its socket comes up: every node seeded,
 *  `_ci-setup` running because the claim has begun, nothing terminal. */
function provisioningState(): PipelineState {
  const seed = (id: string, command: string): PipelineState["nodes"][string] =>
    pendingNode({ id, name: id, command, needs: [] });
  return {
    name: "ci::default",
    sha7: "062c12d",
    dirty: false,
    seq: 1,
    order: [SETUP, FMT],
    nodes: {
      [SETUP]: {
        ...seed(SETUP, "(provision kolu-ci-5 | kolu-ci-6)"),
        status: "running",
        startedAt: 1_000,
      },
      [FMT]: seed(FMT, "just ci::fmt"),
    },
  };
}

function provisioningHeader(startedAt = 1_000): RunHeader {
  return {
    commitUrl: null,
    lanes: [
      {
        state: "claiming",
        platform: "x86_64-linux",
        pool: ["kolu-ci-5", "kolu-ci-6"],
      },
    ],
    hostsSource: "~/.config/odu/hosts.json",
    startedAt,
  };
}

function lanesHeader(): RunHeader {
  return {
    commitUrl: null,
    lanes: [{ state: "leased", platform: "x86_64-linux", host: "kolu-ci-5" }],
    hostsSource: "~/.config/odu/hosts.json",
    startedAt: 1_000,
  };
}

/** A partly-claimed multi-platform run — one lane leased, one still claiming,
 *  in the run's own platform order. */
function partlyClaimedHeader(): RunHeader {
  return {
    ...lanesHeader(),
    lanes: [
      { state: "leased", platform: "aarch64-darwin", host: "rasam" },
      {
        state: "claiming",
        platform: "x86_64-linux",
        pool: ["kolu-ci-5", "kolu-ci-6"],
      },
    ],
  };
}

/** What the failure path publishes: the roster resolved to nothing. */
function noLanesHeader(): RunHeader {
  return { ...provisioningHeader(), lanes: [] };
}

const open: TestSurface[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

async function capturingStdout<T>(
  fn: () => Promise<T>,
): Promise<{ out: string; result: T }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
    );
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { out: chunks.join(""), result };
  } finally {
    process.stdout.write = original;
  }
}

describe("runPhase", () => {
  it("is provisioning while any lane is still claiming", () => {
    expect(runPhase(provisioningHeader())).toBe("provisioning");
  });

  it("is lanes once every lane has a host", () => {
    expect(runPhase(lanesHeader())).toBe("lanes");
  });

  it("reads a partly-claimed multi-platform run as provisioning", () => {
    // One lane resolved, one still claiming: the run has not reached its
    // fanout, so it is not in the `lanes` phase yet.
    expect(runPhase(partlyClaimedHeader())).toBe("provisioning");
  });

  it("tells a run that never started apart from one that got nothing", () => {
    // These were ONE value (`no_lanes`) until the lens review, distinguishable
    // only by `elapsed_ms` on a sibling JSON field — a precondition-on-a-sibling
    // exactly like the one the phase enum exists to abolish. A pre-publish
    // header is `unstarted`; a run that tried and got no machine is `no_lanes`.
    expect(runPhase(EMPTY_HEADER)).toBe("unstarted");
    expect(runPhase(noLanesHeader())).toBe("no_lanes");
  });
});

describe("provisioningLines", () => {
  it("names the phase, the pool and how long it has been at it", () => {
    const lines = provisioningLines(provisioningHeader(), 1_000 + 252_000);
    expect(lines[0]).toBe("provisioning 4m12s");
    expect(lines.join("\n")).toContain(
      "claiming x86_64-linux from kolu-ci-5, kolu-ci-6",
    );
  });

  it("says nothing once the lanes resolve", () => {
    // A run that reached its lanes keeps the output `odu status` has always
    // had — the node rows ARE its state then.
    expect(provisioningLines(lanesHeader())).toEqual([]);
  });

  it("shows the lanes already claimed beside the ones still claiming", () => {
    const lines = provisioningLines(partlyClaimedHeader(), 1_000);
    expect(lines.join("\n")).toContain(
      "claiming x86_64-linux from kolu-ci-5, kolu-ci-6",
    );
    expect(lines.join("\n")).toContain("lanes aarch64-darwin=rasam");
  });
});

describe("runEnvJson", () => {
  it("carries the phase, elapsed and pool the issue asked for", () => {
    expect(runEnvJson(provisioningHeader(), 1_000 + 252_000)).toEqual({
      phase: "provisioning",
      elapsed_ms: 252_000,
      lanes: [
        {
          state: "claiming",
          platform: "x86_64-linux",
          pool: ["kolu-ci-5", "kolu-ci-6"],
        },
      ],
    });
  });

  it("emits one roster a reader traverses once, in platform order", () => {
    // Two arrays made every downstream agent zip them back together, and left
    // the two halves free to disagree about ordering. One array, each entry
    // carrying its own `state`.
    expect(runEnvJson(partlyClaimedHeader(), 1_000).lanes).toEqual([
      { state: "leased", platform: "aarch64-darwin", host: "rasam" },
      {
        state: "claiming",
        platform: "x86_64-linux",
        pool: ["kolu-ci-5", "kolu-ci-6"],
      },
    ]);
  });

  it("has a null elapsed for a header no run ever published", () => {
    // `startedAt: 0` is the pre-publish default; `Date.now() - 0` would be a
    // 56-year-old run.
    expect(runEnvJson(EMPTY_HEADER).elapsed_ms).toBeNull();
  });
});

describe("odu status during provisioning", () => {
  it("reports the phase and the pending nodes, not 'no run in progress'", async () => {
    const surface = await serveTestSurface(
      provisioningState(),
      provisioningHeader(),
    );
    open.push(surface);
    const { out, result } = await capturingStdout(() =>
      statusCommand(false, surface.socketPath),
    );
    // Not settled, not red — a provisioning run is a healthy 0.
    expect(result).toBe(0);
    expect(out).toContain("provisioning");
    expect(out).toContain("claiming x86_64-linux from kolu-ci-5, kolu-ci-6");
    expect(out).toContain(SETUP);
    expect(out).toContain(FMT);
  });

  it("carries the run environment on -o json", async () => {
    const surface = await serveTestSurface(
      provisioningState(),
      provisioningHeader(),
    );
    open.push(surface);
    const { out } = await capturingStdout(() =>
      statusCommand(true, surface.socketPath),
    );
    const parsed = JSON.parse(out) as {
      nodes: unknown[];
      posting: unknown;
      run: { phase: string; lanes: unknown[] };
    };
    expect(parsed.run.phase).toBe("provisioning");
    expect(parsed.run.lanes).toEqual([
      {
        state: "claiming",
        platform: "x86_64-linux",
        pool: ["kolu-ci-5", "kolu-ci-6"],
      },
    ]);
    // The keys older readers use are untouched.
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.posting).toBeDefined();
  });

  it("stops saying provisioning once a failed claim clears it", async () => {
    // What `orchestrate` publishes when the claim throws: a roster that
    // resolved to nothing, every node terminal. Reporting this as
    // `provisioning` — which it did until the failure path learned to
    // republish — leaves a dead run counting elapsed time at the operator.
    const state = provisioningState();
    const surface = await serveTestSurface(state, noLanesHeader());
    open.push(surface);
    surface.setState({
      ...state,
      nodes: {
        ...state.nodes,
        [SETUP]: { ...state.nodes[SETUP]!, status: "errored" },
        [FMT]: { ...state.nodes[FMT]!, status: "skipped" },
      },
    });
    const { out } = await capturingStdout(() =>
      statusCommand(true, surface.socketPath),
    );
    const parsed = JSON.parse(out) as { run: { phase: string } };
    expect(parsed.run.phase).toBe("no_lanes");
  });

  it("leaves a lane-phase run's output exactly as it was", async () => {
    const surface = await serveTestSurface(provisioningState(), lanesHeader());
    open.push(surface);
    const { out } = await capturingStdout(() =>
      statusCommand(false, surface.socketPath),
    );
    expect(out).not.toContain("provisioning");
    expect(out).not.toContain("claiming");
  });
});

describe("the agent face during provisioning", () => {
  it("reports a live run, so wait_for_settle blocks instead of refusing", () => {
    // The seeded (all-pending) pipeline is what makes this true: an empty
    // `order` maps to `{ run: false }`, which `waitForSettle` treats as no run
    // at all and refuses loudly.
    const snap = toAgentNodes(provisioningState());
    expect(snap.run).toBe(true);
    expect(snap.sha7).toBe("062c12d");
    expect(snap.seq).toBe(1);
    expect(snap.nodes.every((n) => !n.red)).toBe(true);
  });

  it("waits on a provisioning run rather than answering it", async () => {
    const surface = await serveTestSurface(
      provisioningState(),
      provisioningHeader(),
    );
    open.push(surface);
    const dialed = await dialSocket(surface.socketPath);
    try {
      const verdict = await waitForSettle({
        client: agentReaderFromA(dialed.client),
        timeoutMs: 150,
        socketPath: surface.socketPath,
      });
      // Timed out waiting — the run is live and unfinished. Before the socket
      // moved ahead of the claim this call raised `no run in progress`.
      expect(verdict.timed_out).toBe(true);
      expect(verdict.settled).toBe(false);
      expect(verdict.sha7).toBe("062c12d");
    } finally {
      await dialed.close();
    }
  });

  it("settles once provisioning fails the setup node", async () => {
    const state = provisioningState();
    const surface = await serveTestSurface(state, provisioningHeader());
    open.push(surface);
    const dialed = await dialSocket(surface.socketPath);
    try {
      const pending = waitForSettle({
        client: agentReaderFromA(dialed.client),
        timeoutMs: 5_000,
        failFast: false,
        socketPath: surface.socketPath,
      });
      // What `orchestrate` publishes when the claim throws: the setup bracket
      // goes red and everything downstream is skipped, so a failure to get a
      // machine reaches the agent as a verdict rather than as a vanished socket.
      surface.setState({
        ...state,
        nodes: {
          ...state.nodes,
          [SETUP]: { ...state.nodes[SETUP]!, status: "errored" },
          [FMT]: { ...state.nodes[FMT]!, status: "skipped" },
        },
      });
      const verdict = await pending;
      expect(verdict.settled).toBe(true);
      expect(verdict.passed).toBe(false);
      expect(verdict.errored).toEqual([SETUP]);
    } finally {
      await dialed.close();
    }
  });
});
