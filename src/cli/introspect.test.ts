/**
 * `odu attach`'s non-interactive stream, exercised over a real unix socket
 * (the same harness the MCP face uses). The point of juspay/odu#4: a piped
 * `attach` must emit the *same* json/plain contract as a piped `run`, not a
 * drifted re-implementation. These dial a served surface, run the stream, and
 * assert the json carries `recipe`/`platform`/`log` and the plain lines use
 * `run`'s glyph + ProgressStatus wording.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Stream } from "effect";
import { pendingNode, type PipelineState } from "@odu/run-client/surface";
import { firstFrame } from "../common/effectEdge";
import { capturingStderr, capturingStdout } from "../common/scaffoldForTest";
import { dialRunOrExit } from "../coordinator/socket";
import type { SettleVerdict } from "../coordinator/waitForSettle";
import { agentReaderForSocket } from "../mcp/agentSurface";
import { serveTestSurface, type TestSurface } from "../mcp/serveForTest";
import { makeWaitTool } from "../mcp/waitTool";
import {
  attachStream,
  logStream,
  headerSnapshot,
  minimalRerunRoots,
  rerunCommand,
  resolveRerunTargets,
  statusCommand,
  waitCommand,
} from "./introspect";

type Row = [
  id: string,
  status: PipelineState["nodes"][string]["status"],
  exitCode?: number,
];

// A settled pipeline: attachStream's first snapshot is already done, so it
// emits one transition per terminal node and returns.
function doneState(rows: Row[]): PipelineState {
  const order = rows.map(([id]) => id);
  const nodes: Record<string, PipelineState["nodes"][string]> = {};
  for (const [id, status, exitCode] of rows) {
    nodes[id] = {
      ...pendingNode({ id, name: id, command: "echo", needs: [] }),
      status,
      exitCode: exitCode ?? null,
      durationMs: 1_000,
    };
  }
  return { name: "ci::default", sha7: "3cbac86", dirty: false, order, nodes };
}

/** Wire dependency edges onto a `doneState` — `{ nodeId: needs }`, rebuilt
 *  rather than mutated in place. Every surface struct is `readonly` under
 *  Effect Schema, so a test wires an edge the same way the coordinator does:
 *  by publishing a new state value. Throws on an unknown id so a renamed node
 *  fails the test loudly instead of silently wiring nothing. */
function withNeeds(
  state: PipelineState,
  edges: Record<string, string[]>,
): PipelineState {
  const nodes: Record<string, PipelineState["nodes"][string]> = {
    ...state.nodes,
  };
  for (const [id, needs] of Object.entries(edges)) {
    const node = nodes[id];
    if (node === undefined) throw new Error(`withNeeds: no such node ${id}`);
    nodes[id] = { ...node, needs };
  }
  return { ...state, nodes };
}

const open: TestSurface[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

async function served(state: PipelineState): Promise<TestSurface> {
  const surface = await serveTestSurface(state);
  open.push(surface);
  return surface;
}

/** Serve `state`, run the stream against it, capture stdout. */
async function streamOf(
  state: PipelineState,
  json: boolean,
): Promise<{ out: string; code: number }> {
  const surface = await served(state);
  const { client, close } = await dialRunOrExit(surface.socketPath);
  const { out, result } = await capturingStdout(() =>
    attachStream(client, close, json),
  );
  return { out, code: result };
}

describe("attachStream — json", () => {
  it("emits the full ProgressEvent contract, not a node-status-only shape", async () => {
    const { out, code } = await streamOf(
      doneState([
        ["ci::install@x86_64-linux", "ok", 0],
        ["ci::e2e@x86_64-linux", "failed", 2],
      ]),
      true,
    );
    const events = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(events).toContainEqual({
      node: "ci::install@x86_64-linux",
      recipe: "ci::install",
      platform: "x86_64-linux",
      status: "success",
      exit_code: 0,
      log: ".ci/3cbac86/x86_64-linux/ci::install.log",
    });
    expect(events).toContainEqual({
      node: "ci::e2e@x86_64-linux",
      recipe: "ci::e2e",
      platform: "x86_64-linux",
      status: "failed",
      exit_code: 2,
      log: ".ci/3cbac86/x86_64-linux/ci::e2e.log",
    });
    // The fan-in red verdict propagates to the exit code, as `run` does.
    expect(code).toBe(1);
  });
});

describe("attachStream — plain", () => {
  it("uses run's glyph + ProgressStatus wording and a log ref on failure", async () => {
    const { out } = await streamOf(
      doneState([["ci::e2e@x86_64-linux", "failed", 2]]),
      false,
    );
    // Banner collapses to pipeline @ sha for an observer (no lanes / hosts).
    expect(out).toContain("odu · ci::default @ 3cbac86");
    expect(out).not.toContain("(hosts:");
    // `✗ failed  …` (ProgressStatus wording) — not the old `failed   <id>`
    // NodeStatus line, and never the raw `ok` wording for green nodes.
    expect(out).toMatch(/✗ failed\s+ci::e2e@x86_64-linux/);
    expect(out).toContain("→ .ci/3cbac86/x86_64-linux/ci::e2e.log");
  });

  it("renders green nodes as success, the wording the node-status-only stream got wrong", async () => {
    const { out } = await streamOf(
      doneState([["ci::install@x86_64-linux", "ok", 0]]),
      false,
    );
    expect(out).toMatch(/✔ success\s+ci::install@x86_64-linux/);
  });
});

// A subscription ENDING and the thing it was waiting for ARRIVING are two
// different events that reach a `for await` as the same `done: true`. Every
// face here reads end-of-stream, and each has its own terminal frame; running
// off the end of the loop instead means the feed died under it. These pin that
// none of them reports that as success — the `wait --settle` defect, in the
// faces next door.
describe("a feed that drops before the face's own terminal frame", () => {
  /** A client whose `nodes` stream hands over `frames` and then ENDS — a feed
   *  that stops without the run settling. (A link that dies raises the tagged
   *  transport error and is loud already; a clean end is the silent one, and
   *  the one an interrupt from below now produces.) */
  function endingAfter(frames: PipelineState[]): Parameters<typeof attachStream>[0] {
    return {
      surface: { nodes: { get: () => Stream.fromIterable(frames) } },
    } as unknown as Parameters<typeof attachStream>[0];
  }

  const running = doneState([
    ["ci::unit@x86_64-linux", "ok", 0],
    ["ci::e2e@x86_64-linux", "running"],
  ]);

  it("attach does not exit 0 on a run that never settled", async () => {
    // `exitCode(state)` is 0 for a run that has not settled, so falling into
    // the success path handed a piped `attach` — whose contract is `run`'s —
    // a green exit for a run still going.
    const { err, result } = await capturingStderr(() =>
      capturingStdout(() => attachStream(endingAfter([running]), async () => {}, true)),
    );
    expect(result.result).toBe(1);
    expect(err).toMatch(/lost the connection to the run before the run settled/);
  });

  it("attach still reports the run's own verdict when it did settle", async () => {
    const settled = doneState([["ci::e2e@x86_64-linux", "failed", 1]]);
    const { out, result } = await capturingStdout(() =>
      attachStream(endingAfter([settled]), async () => {}, true),
    );
    // The red verdict, from the run — not the dropped-feed 1.
    expect(result).toBe(1);
    expect(out).toContain("ci::e2e@x86_64-linux");
  });

  it("logs -f does not report an incomplete log as complete", async () => {
    // #88/#89's invariant: either the log is complete, or it says it isn't.
    const client = {
      surface: {
        nodeLog: {
          get: () =>
            Stream.fromIterable([
              { kind: "snapshot" as const, text: "half a line" },
            ]),
        },
      },
    } as unknown as Parameters<typeof logStream>[0];
    const { err, result } = await capturingStderr(() =>
      capturingStdout(() => logStream(client, "ci::e2e@x86_64-linux", true)),
    );
    expect(result.result).toBe(1);
    expect(err).toMatch(/lost the connection to the run before .*log ended/);
    // The bytes it DID get are still delivered — a dropped feed is not a
    // reason to withhold what arrived.
    expect(result.out).toBe("half a line");
  });

  it("logs without -f is complete at the snapshot, as it always was", async () => {
    const client = {
      surface: {
        nodeLog: {
          get: () =>
            Stream.fromIterable([
              { kind: "snapshot" as const, text: "the whole buffered tail" },
            ]),
        },
      },
    } as unknown as Parameters<typeof logStream>[0];
    const { out, result } = await capturingStdout(() =>
      logStream(client, "ci::e2e@x86_64-linux", false),
    );
    expect(result).toBe(0);
    expect(out).toBe("the whole buffered tail");
  });
});

// `odu status` is the third plain face onto the same fan-in state; it must use
// the same ProgressStatus wording as run/attach (lens hickey-2), not the raw
// NodeStatus (`ok`).
describe("statusCommand — plain", () => {
  it("renders the snapshot with run/attach's wording (success, not ok)", async () => {
    const surface = await served(
      doneState([
        ["ci::install@x86_64-linux", "ok", 0],
        ["ci::e2e@x86_64-linux", "failed", 2],
      ]),
    );
    const { out, result } = await capturingStdout(() =>
      statusCommand(false, surface.socketPath),
    );
    expect(out).toMatch(/✔ success\s+ci::install@x86_64-linux/);
    expect(out).toMatch(/✗ failed\s+ci::e2e@x86_64-linux/);
    expect(out).not.toMatch(/\bok\b/); // the old NodeStatus wording is gone
    expect(result).toBe(1);
  });
});

// The data gap #6 closes: an attached face reads the run's lane→host map off the
// surface `header` cell, so its matrix banner matches run's instead of an
// observer stub.
describe("headerSnapshot", () => {
  it("reads the run header (lane→host map) off the surface", async () => {
    const surface = await serveTestSurface(
      doneState([["ci::e2e@x86_64-linux", "ok", 0]]),
      {
        commitUrl: null,
        lanes: [
          { state: "leased", platform: "x86_64-linux", host: "kolu-ci-1" },
        ],
        hostsSource: "~/.config/odu/hosts.json",
        startedAt: 0,
      },
    );
    open.push(surface);
    const { client, close } = await dialRunOrExit(surface.socketPath);
    try {
      const header = await headerSnapshot(client);
      expect(header.lanes).toEqual([
        { state: "leased", platform: "x86_64-linux", host: "kolu-ci-1" },
      ]);
      expect(header.hostsSource).toBe("~/.config/odu/hosts.json");
    } finally {
      close();
    }
  });
});

// `odu wait` is the plain-CLI face of MCP `wait_for_settle` — same verdict
// semantics, JSON on stdout, exit 0 only on fully-settled all-green.
describe("waitCommand", () => {
  it("fails loud with no live socket (never hang, never exit 0)", async () => {
    const { err, result } = await capturingStderr(() =>
      waitCommand({ settle: false, socketPath: "/no/such/odu.sock" }),
    );
    expect(result).toBe(1);
    expect(err).toMatch(/no run in progress/);
    expect(err).toMatch(/no live socket/);
  });

  it("returns a green JSON verdict and exit 0 on a settled all-green run", async () => {
    const surface = await served(
      doneState([
        ["ci::unit@x86_64-linux", "ok", 0],
        ["ci::nix@x86_64-linux", "ok", 0],
      ]),
    );
    const { out, result } = await capturingStdout(() =>
      waitCommand({ settle: true, socketPath: surface.socketPath }),
    );
    const verdict = JSON.parse(out.trim());
    expect(verdict).toMatchObject({
      settled: true,
      passed: true,
      fail_fast_tripped: false,
      failed: [],
      errored: [],
      sha7: "3cbac86",
    });
    expect(result).toBe(0);
  });

  it("fail-fast trips on the first red node (exit non-zero)", async () => {
    const surface = await served(
      doneState([
        ["ci::unit@x86_64-linux", "running"],
        ["ci::e2e@x86_64-linux", "failed", 1],
      ]),
    );
    // Default is fail-fast; state is already red so the first frame trips.
    const { out, result } = await capturingStdout(() =>
      waitCommand({ settle: false, socketPath: surface.socketPath }),
    );
    const verdict = JSON.parse(out.trim());
    expect(verdict.passed).toBe(false);
    expect(verdict.failed).toContain("ci::e2e@x86_64-linux");
    expect(verdict.fail_fast_tripped).toBe(true);
    expect(verdict.settled).toBe(false);
    expect(result).toBe(1);
  });

  it("--settle waits for the full run even when a node is red", async () => {
    const surface = await served(
      doneState([
        ["ci::unit@x86_64-linux", "ok", 0],
        ["ci::e2e@x86_64-linux", "failed", 1],
      ]),
    );
    const { out, result } = await capturingStdout(() =>
      waitCommand({ settle: true, socketPath: surface.socketPath }),
    );
    const verdict = JSON.parse(out.trim());
    expect(verdict).toMatchObject({
      settled: true,
      passed: false,
      fail_fast_tripped: false,
      failed: ["ci::e2e@x86_64-linux"],
    });
    expect(result).toBe(1);
  });

  it("blocks until the run actually settles, then exits 0", async () => {
    // The plain `--settle` contract, and it had no test: every case here served
    // a pipeline that was ALREADY terminal, so nothing pinned that the command
    // waits at all.
    const surface = await served(
      doneState([
        ["ci::unit@x86_64-linux", "running"],
        ["ci::nix@x86_64-linux", "running"],
      ]),
    );
    setTimeout(() => {
      surface.setState(
        doneState([
          ["ci::unit@x86_64-linux", "ok", 0],
          ["ci::nix@x86_64-linux", "ok", 0],
        ]),
      );
    }, 60);
    const { out, result } = await capturingStdout(() =>
      waitCommand({ settle: true, socketPath: surface.socketPath, timeoutMs: 5_000 }),
    );
    expect(JSON.parse(out.trim())).toMatchObject({
      settled: true,
      passed: true,
      timed_out: false,
    });
    expect(result).toBe(0);
  });

  it("reaches a run through a reader that DIALS, not one link it captured", async () => {
    // The shape of the bug, pinned where it lived. `odu wait` used to dial once
    // at command entry and hand the settle core that one link; when the link
    // died — the wire's keep-alive makes 5–10s of coordinator silence fatal —
    // the wait had nothing left to wait on and answered `{settled:false}` about
    // a run that was still going.
    //
    // A reader that DIALS has a property a captured link cannot fake: it can be
    // built when there is no socket at all, and each subscription reaches
    // whatever is serving THEN. Two runs in turn at one path prove both halves —
    // and `waitCommand` gets its reader from exactly this call.
    const dir = mkdtempSync(join(tmpdir(), "odu-wait-reader-"));
    const socketPath = join(dir, "odu.sock");
    try {
      // Built against a checkout with no run in it: nothing is dialed here.
      const reader = agentReaderForSocket(socketPath);

      const first = await serveTestSurface(
        doneState([["ci::unit@x86_64-linux", "running"]]),
        undefined,
        socketPath,
      );
      const before = await firstFrame(reader.surface.nodes.get(undefined));
      expect(before).toMatchObject({ run: true, pipeline: "ci::default" });
      first.close();

      // A second run binds the same `.ci/odu.sock`. The SAME reader value must
      // see it — a captured link would still be pointed at the first one's
      // corpse.
      const second = await serveTestSurface(
        { ...doneState([["ci::e2e@aarch64-darwin", "running"]]), name: "ci::two" },
        undefined,
        socketPath,
      );
      const after = await firstFrame(reader.surface.nodes.get(undefined));
      expect(after).toMatchObject({ run: true, pipeline: "ci::two" });
      second.close();

      // And with nobody serving it answers the no-run frame rather than failing
      // — which is what turns into `odu wait`'s loud refusal.
      expect(await firstFrame(reader.surface.nodes.get(undefined))).toMatchObject(
        { run: false },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agrees with the MCP `wait_for_settle` verdict on one run", async () => {
    // The two faces, the same live run, one verdict. They share the settle core
    // AND (since the reader moved) the way they reach the coordinator, so this
    // is a pin on that sharing rather than a coincidence of two code paths.
    const surface = await served(
      doneState([
        ["ci::unit@x86_64-linux", "running"],
        ["ci::e2e@x86_64-linux", "running"],
      ]),
    );
    const cli = capturingStdout(() =>
      waitCommand({ settle: true, socketPath: surface.socketPath, timeoutMs: 5_000 }),
    );
    const mcp = Effect.runPromise(
      makeWaitTool(() => null).handler(
        { fail_fast: false, timeout_ms: 5_000 },
        agentReaderForSocket(surface.socketPath) as never,
        undefined,
      ),
    ) as Promise<SettleVerdict>;
    setTimeout(() => {
      surface.setState(
        doneState([
          ["ci::unit@x86_64-linux", "ok", 0],
          ["ci::e2e@x86_64-linux", "failed", 1],
        ]),
      );
    }, 60);
    const [{ out, result }, tool] = await Promise.all([cli, mcp]);
    const verdict = JSON.parse(out.trim()) as SettleVerdict;
    // `duration_ms` is the one field that legitimately differs (two clocks).
    const { duration_ms: _cliMs, ...cliRest } = verdict;
    const { duration_ms: _mcpMs, ...mcpRest } = tool;
    expect(cliRest).toEqual(mcpRest);
    expect(verdict).toMatchObject({
      settled: true,
      passed: false,
      failed: ["ci::e2e@x86_64-linux"],
    });
    expect(result).toBe(1);
  });

  it("refuses when --expected-sha does not match the live run", async () => {
    const surface = await served(
      doneState([["ci::unit@x86_64-linux", "ok", 0]]),
    );
    const { err, result } = await capturingStderr(() =>
      waitCommand({
        settle: true,
        socketPath: surface.socketPath,
        expectedSha: "deadbeef",
      }),
    );
    expect(result).toBe(1);
    expect(err).toMatch(/no live run matching deadbeef/);
  });
});

describe("resolveRerunTargets", () => {
  const multi = doneState([
    ["ci::unit@x86_64-linux", "ok", 0],
    ["ci::unit@aarch64-darwin", "ok", 0],
    ["ci::e2e@x86_64-linux", "failed", 1],
    ["ci::e2e@aarch64-darwin", "ok", 0],
  ]);

  it("resolves one exact fan-in node id", () => {
    expect(resolveRerunTargets(multi, "ci::e2e@x86_64-linux")).toEqual([
      "ci::e2e@x86_64-linux",
    ]);
  });

  it("expands @platform to every node on that lane", () => {
    expect(resolveRerunTargets(multi, "@x86_64-linux")).toEqual([
      "ci::unit@x86_64-linux",
      "ci::e2e@x86_64-linux",
    ]);
  });

  it("expands a bare recipe to every platform of that recipe", () => {
    expect(resolveRerunTargets(multi, "unit")).toEqual([
      "ci::unit@x86_64-linux",
      "ci::unit@aarch64-darwin",
    ]);
  });

  it("rejects an unknown selector", () => {
    expect(() => resolveRerunTargets(multi, "nope")).toThrow(/no node matches/);
  });
});

describe("minimalRerunRoots", () => {
  it("drops dependents already covered by another selected root's needs", () => {
    // unit → e2e on the same lane; @plat would expand to both, but only unit
    // needs its own node.rerun (which resets e2e transitively).
    const state = doneState([
      ["ci::unit@x86_64-linux", "ok", 0],
      ["ci::e2e@x86_64-linux", "failed", 1],
    ]);
    // Wire needs: e2e depends on unit.
    const wired = withNeeds(state, {
      "ci::e2e@x86_64-linux": ["ci::unit@x86_64-linux"],
    });
    expect(
      minimalRerunRoots(wired, [
        "ci::unit@x86_64-linux",
        "ci::e2e@x86_64-linux",
      ]),
    ).toEqual(["ci::unit@x86_64-linux"]);
  });
});

// `odu rerun` is the headless face of surface `node.rerun` — dial, expand
// selector, call, print what was rerun.
describe("rerunCommand", () => {
  it("fails loud with no live socket", async () => {
    const { err, result } = await capturingStderr(() =>
      rerunCommand("ci::unit@x86_64-linux", "/no/such/odu.sock"),
    );
    expect(result).toBe(1);
    expect(err).toMatch(/no run in progress/);
  });

  it("reruns one node by fan-in id", async () => {
    const surface = await served(
      doneState([["ci::e2e@x86_64-linux", "failed", 1]]),
    );
    const { out, result } = await capturingStdout(() =>
      rerunCommand("ci::e2e@x86_64-linux", surface.socketPath),
    );
    expect(result).toBe(0);
    expect(out).toBe("odu: reran ci::e2e@x86_64-linux\n");
    expect(surface.reruns).toEqual(["ci::e2e@x86_64-linux"]);
  });

  it("reruns every node on a @platform lane (excluding _ci-setup)", async () => {
    // Production lanes always have `_ci-setup@plat` and every task needs it;
    // @platform must expand to recipe nodes only, then collapse to roots.
    const state = doneState([
      ["_ci-setup@x86_64-linux", "ok", 0],
      ["ci::unit@x86_64-linux", "ok", 0],
      ["ci::e2e@x86_64-linux", "failed", 1],
      ["ci::unit@aarch64-darwin", "ok", 0],
    ]);
    const setupId = "_ci-setup@x86_64-linux";
    const surface = await served(
      withNeeds(state, {
        "ci::unit@x86_64-linux": [setupId],
        "ci::e2e@x86_64-linux": [setupId, "ci::unit@x86_64-linux"],
      }),
    );
    const { out, result } = await capturingStdout(() =>
      rerunCommand("@x86_64-linux", surface.socketPath),
    );
    expect(result).toBe(0);
    // Setup excluded; e2e covered by unit's transitive reset → only unit,
    // but the report names dependents the runner will also reset.
    expect(out).toBe(
      "odu: reran ci::unit@x86_64-linux (resets ci::e2e@x86_64-linux)\n",
    );
    expect(surface.reruns).toEqual(["ci::unit@x86_64-linux"]);
  });

  it("reruns a bare recipe on every lane", async () => {
    const surface = await served(
      doneState([
        ["ci::unit@x86_64-linux", "failed", 1],
        ["ci::unit@aarch64-darwin", "failed", 1],
        ["ci::e2e@x86_64-linux", "ok", 0],
      ]),
    );
    const { out, result } = await capturingStdout(() =>
      rerunCommand("unit", surface.socketPath),
    );
    expect(result).toBe(0);
    expect(out).toBe(
      "odu: reran ci::unit@x86_64-linux; ci::unit@aarch64-darwin\n",
    );
    expect(surface.reruns).toEqual([
      "ci::unit@x86_64-linux",
      "ci::unit@aarch64-darwin",
    ]);
  });
});
