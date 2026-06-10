import { afterEach, describe, expect, it } from "vitest";
import { pendingNode, type PipelineState } from "../common/surface";
import { serveTestSurface, type TestSurface } from "./serveForTest";
import {
  getNodes,
  rerunNode,
  startRun,
  tailLog,
  waitForSettle,
} from "./tools";

type Row = [id: string, status: PipelineState["nodes"][string]["status"]];

function state(rows: Row[]): PipelineState {
  const order = rows.map(([id]) => id);
  const nodes: Record<string, PipelineState["nodes"][string]> = {};
  for (const [id, status] of rows) {
    nodes[id] = {
      ...pendingNode({ id, name: id, command: "echo", needs: [] }),
      status,
    };
  }
  return { name: "test", order, nodes };
}

const open: TestSurface[] = [];
async function serve(rows: Row[]): Promise<TestSurface> {
  const s = await serveTestSurface(state(rows));
  open.push(s);
  return s;
}
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

const NO_SOCKET = "/nonexistent/odu.sock";

describe("get_nodes", () => {
  it("reports no run when nothing is live", async () => {
    const result = await getNodes(NO_SOCKET);
    expect(result.run).toBe(false);
    expect(result.nodes).toEqual([]);
  });

  it("snapshots the live pipeline", async () => {
    const s = await serve([
      ["ci::unit@x86_64-linux", "ok"],
      ["ci::e2e@x86_64-linux", "running"],
    ]);
    const result = await getNodes(s.socketPath);
    expect(result.run).toBe(true);
    expect(result.nodes.map((n) => [n.id, n.status, n.red])).toEqual([
      ["ci::unit@x86_64-linux", "ok", false],
      ["ci::e2e@x86_64-linux", "running", false],
    ]);
  });
});

describe("rerun_node", () => {
  it("resolves and reruns a node", async () => {
    const s = await serve([["ci::e2e@x86_64-linux", "failed"]]);
    const result = await rerunNode("e2e@x86_64-linux", s.socketPath);
    expect(result).toEqual({ ok: true, node: "ci::e2e@x86_64-linux" });
    expect(s.reruns).toEqual(["ci::e2e@x86_64-linux"]);
  });

  it("fails cleanly with no run", async () => {
    expect(await rerunNode("e2e", NO_SOCKET)).toEqual({
      ok: false,
      error: "no run in progress",
    });
  });
});

describe("tail_log", () => {
  it("returns the live buffered snapshot", async () => {
    const s = await serve([["ci::e2e@x86_64-linux", "running"]]);
    s.appendLog("ci::e2e@x86_64-linux", "cucumber: 14 scenarios\n");
    const result = await tailLog("e2e@x86_64-linux", s.socketPath);
    expect(result.source).toBe("live");
    expect(result.text).toContain("cucumber: 14 scenarios");
  });

  it("reports missing when no run and no durable file", async () => {
    const result = await tailLog("ci::nope@aarch64-darwin", NO_SOCKET);
    expect(result.source).toBe("missing");
  });
});

describe("wait_for_settle", () => {
  it("returns the verdict the instant a node goes red (fail-fast)", async () => {
    const s = await serve([
      ["ci::nix@x86_64-linux", "running"],
      ["ci::e2e@x86_64-linux", "running"],
    ]);
    setTimeout(() => {
      s.setState(
        state([
          ["ci::nix@x86_64-linux", "running"],
          ["ci::e2e@x86_64-linux", "failed"],
        ]),
      );
    }, 30);
    const v = await waitForSettle({
      socketPath: s.socketPath,
      failFast: true,
      timeoutMs: 2000,
    });
    expect(v.passed).toBe(false);
    expect(v.failed).toContain("ci::e2e@x86_64-linux");
    expect(v.settled).toBe(false);
    expect(v.fail_fast_tripped).toBe(true);
  });

  it("returns passed when the whole run settles green", async () => {
    const s = await serve([
      ["ci::unit@x86_64-linux", "ok"],
      ["ci::nix@x86_64-linux", "ok"],
    ]);
    const v = await waitForSettle({
      socketPath: s.socketPath,
      failFast: false,
      timeoutMs: 2000,
    });
    expect(v).toMatchObject({ settled: true, passed: true, timed_out: false });
  });

  it("times out on a run that never settles", async () => {
    const s = await serve([["ci::nix@x86_64-linux", "running"]]);
    const v = await waitForSettle({
      socketPath: s.socketPath,
      failFast: false,
      timeoutMs: 80,
    });
    expect(v.timed_out).toBe(true);
    expect(v.settled).toBe(false);
  });

  it("returns no-run when nothing is live", async () => {
    const v = await waitForSettle({ socketPath: NO_SOCKET, timeoutMs: 50 });
    expect(v).toMatchObject({ settled: false, passed: false });
  });
});

describe("run", () => {
  it("refuses when a run is already in progress", async () => {
    const s = await serve([["ci::unit@x86_64-linux", "running"]]);
    const result = await startRun({}, { socketPath: s.socketPath });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already in progress");
  });

  it("spawns and reports started once the socket is live", async () => {
    let captured: string[] = [];
    const result = await startRun(
      { selectors: ["biome"], no_strict: true },
      {
        socketPath: NO_SOCKET,
        spawnRun: (args) => {
          captured = args;
          return { stderr: "", onExit: Promise.resolve(0) };
        },
        waitForSocket: async () => true,
      },
    );
    expect(result).toEqual({ ok: true, started: true });
    expect(captured).toEqual(["run", "biome", "--no-strict"]);
  });

  it("surfaces the run's stderr when it dies before serving", async () => {
    const result = await startRun(
      {},
      {
        socketPath: NO_SOCKET,
        spawnRun: () => ({
          stderr: "odu: working tree is dirty",
          onExit: Promise.resolve(1),
        }),
        waitForSocket: async () => false,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("dirty");
  });
});
