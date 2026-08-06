/**
 * `odu attach`'s non-interactive stream, exercised over a real unix socket
 * (the same harness the MCP face uses). The point of juspay/odu#4: a piped
 * `attach` must emit the *same* json/plain contract as a piped `run`, not a
 * drifted re-implementation. These dial a served surface, run the stream, and
 * assert the json carries `recipe`/`platform`/`log` and the plain lines use
 * `run`'s glyph + ProgressStatus wording.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { pendingNode, type PipelineState } from "../common/surface";
import { dialSocket } from "../coordinator/socket";
import { serveTestSurface, type TestSurface } from "../mcp/serveForTest";
import {
  attachStream,
  firstHeader,
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

const open: TestSurface[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

/** Run `fn` with process.stdout captured; returns what it wrote + fn's result. */
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

/** Same as capturingStdout but for stderr. */
async function capturingStderr<T>(
  fn: () => Promise<T>,
): Promise<{ err: string; result: T }> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
    );
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { err: chunks.join(""), result };
  } finally {
    process.stderr.write = original;
  }
}

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
  const { client, close } = await dialSocket(surface.socketPath);
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
describe("firstHeader", () => {
  it("reads the run header (lane→host map) off the surface", async () => {
    const surface = await serveTestSurface(
      doneState([["ci::e2e@x86_64-linux", "ok", 0]]),
      {
        commitUrl: null,
        lanes: [{ platform: "x86_64-linux", host: "kolu-ci-1" }],
        hostsSource: "~/.config/odu/hosts.json",
        startedAt: 0,
      },
    );
    open.push(surface);
    const { client, close } = await dialSocket(surface.socketPath);
    try {
      const header = await firstHeader(client);
      expect(header.lanes).toEqual([
        { platform: "x86_64-linux", host: "kolu-ci-1" },
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
    const e2e = state.nodes["ci::e2e@x86_64-linux"];
    if (e2e !== undefined) e2e.needs = ["ci::unit@x86_64-linux"];
    expect(
      minimalRerunRoots(state, [
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
    for (const id of ["ci::unit@x86_64-linux", "ci::e2e@x86_64-linux"]) {
      const n = state.nodes[id];
      if (n !== undefined) n.needs = [setupId, ...(n.needs ?? [])];
    }
    const e2e = state.nodes["ci::e2e@x86_64-linux"];
    if (e2e !== undefined) {
      e2e.needs = [setupId, "ci::unit@x86_64-linux"];
    }
    const surface = await served(state);
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
