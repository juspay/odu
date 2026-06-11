/**
 * End-to-end: odu's coordinator surface (`oduSurface`) projected onto the
 * agent surface (`oduAgentSurface`) and re-exposed as MCP via
 * `@kolu/surface-mcp`, driven by a real MCP `Client` over the SDK's in-memory
 * transport pair. The load-bearing test — it proves the projection + the
 * curation gate wire correctly and, crucially, that the gate is default-deny:
 * the coordinator's `header` cell and the lane-only `run.configure` never reach
 * the host.
 *
 * Plus the ported guard/verdict units: the durable-log path-traversal + 64KB
 * clamp (now on `durableLog`), and `wait_for_settle`'s fail-fast / settle /
 * timeout / cancel behaviour (now over the projected `nodes` cell).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { directLink } from "@kolu/surface/links/direct";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { serveSurfaceAsMcp } from "@kolu/surface-mcp";
import { afterEach, describe, expect, it } from "vitest";
import { gitTopLevel, headSha7 } from "../common/git";
import { tryDialSocket } from "../coordinator/socket";
import { oduSurface, pendingNode, type PipelineState } from "../common/surface";
import {
  type AgentNodesReader,
  buildAgentProjection,
  durableLog,
  redialingAClient,
} from "./agentSurface";
import { serveTestSurface, type TestSurface } from "./serveForTest";
import { waitForSettle } from "./waitTool";

/** The git-backed run-context resolver, mirroring `mcp.ts`'s default: the
 *  durable-log identity (repo root + SHA) the projection now takes through the
 *  injection seam. The MCP-wiring tests don't exercise the durable read, so any
 *  resolver works; this matches production so the durable-file tests below
 *  (which write real `.ci/<sha7>/…` files) resolve to the same paths. */
function gitRunContext(): { repoRoot: string; sha7: string } | null {
  const repoRoot = gitTopLevel();
  const sha7 = headSha7(repoRoot);
  if (repoRoot === null || sha7 === null) return null;
  return { repoRoot, sha7 };
}

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
  return { name: "test", sha7: "abc1234", dirty: false, order, nodes };
}

const open: TestSurface[] = [];
const closers: Array<() => Promise<void> | void> = [];
async function serve(rows: Row[]): Promise<TestSurface> {
  const s = await serveTestSurface(state(rows));
  open.push(s);
  return s;
}
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const s of open.splice(0)) s.close();
});

/** Stand up the MCP server + a connected MCP client over an in-memory pair,
 *  wired exactly as `mcpCommand`: one stable B-client over a re-dialing
 *  A-client that dials `socketPath` fresh per call (so a coordinator restart at
 *  the same path is observed). `socketPath` defaults to the served surface's. */
async function connect(s: TestSurface, socketPath: string = s.socketPath) {
  const projection = buildAgentProjection(oduSurface, gitRunContext);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const aClient = redialingAClient(async () => {
    const dialed = await tryDialSocket(socketPath);
    return dialed === null
      ? null
      : { client: dialed.client, close: dialed.close };
  });
  const { router } = projection.implement(aClient);
  const bClient = directLink<typeof projection.surface.contract>(router);

  const served = await serveSurfaceAsMcp({
    surface: projection.surface,
    client: () => bClient,
    expose: {
      nodes: "resource",
      logs: "resource",
      "node.rerun": { tool: { mutates: true } },
    },
    tools: {
      run: {
        description: "stub",
        // No real spawn in the smoke test — assert tools/list only.
        handler: () => ({ ok: false, started: false }),
        mutates: true,
      },
      wait_for_settle: {
        description: "stub",
        handler: () => ({ settled: false }),
      },
    },
    serverInfo: { name: "odu", version: "0.0.0" },
    transport: serverTransport,
  });

  const mcp = new Client({ name: "test-client", version: "0.0.0" });
  await mcp.connect(clientTransport);
  closers.push(
    () => mcp.close(),
    () => served.close(),
  );
  return { mcp, served };
}

describe("odu agent MCP — end to end over the in-memory transport", () => {
  it("tools/list is exactly [node_rerun, run, wait_for_settle] (default-deny)", async () => {
    const s = await serve([["ci::e2e@x86_64-linux", "running"]]);
    const { mcp } = await connect(s);

    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["node_rerun", "run", "wait_for_settle"]);
  });

  it("resources/list contains the nodes cell; templates contain the logs item", async () => {
    const s = await serve([["ci::e2e@x86_64-linux", "running"]]);
    const { mcp } = await connect(s);

    const { resources } = await mcp.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("surface://streams/nodes");

    const { resourceTemplates } = await mcp.listResourceTemplates();
    const templates = resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toContain("surface://collections/logs/{id}");
  });

  it("header cell + run.configure are absent (default-deny by construction)", async () => {
    const s = await serve([["ci::e2e@x86_64-linux", "running"]]);
    const { mcp } = await connect(s);

    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name);
    // run.configure lives on laneSurface, never on the projected surface.
    expect(names).not.toContain("run_configure");

    const { resources } = await mcp.listResources();
    const uris = resources.map((r) => r.uri);
    // The coordinator's `header` cell is not mapped onto the agent surface.
    expect(uris).not.toContain("surface://cells/header");
  });

  it("a single read of the nodes stream returns the live snapshot (no poll)", async () => {
    const s = await serve([
      ["ci::unit@x86_64-linux", "ok"],
      ["ci::e2e@x86_64-linux", "running"],
    ]);
    const { mcp } = await connect(s);

    // `nodes` is a derived *stream*, so a one-shot `resources/read` awaits A's
    // real first frame — no polling around an async pre-snapshot gap (the
    // regression a derived cell had). A single read returns the live pipeline.
    const read = await mcp.readResource({ uri: "surface://streams/nodes" });
    const body: {
      run: boolean;
      pipeline: string | null;
      nodes: unknown[];
    } = JSON.parse((read.contents[0] as { text: string }).text);
    expect(body.run).toBe(true);
    expect(body.pipeline).toBe("test");
    expect(
      (body.nodes as Array<{ id: string; red: boolean }>).map((n) => [
        n.id,
        n.red,
      ]),
    ).toEqual([
      ["ci::unit@x86_64-linux", false],
      ["ci::e2e@x86_64-linux", false],
    ]);
  });

  it("observes a coordinator restart on the same socket path (no stale read)", async () => {
    // The re-dialing A-client dials fresh per call, so a run that closed and a
    // *new* run that re-bound `.ci/odu.sock` is seen by the next read — the
    // adapter's memoized connection would otherwise keep serving the first run.
    const dir = mkdtempSync(join(tmpdir(), "odu-restart-"));
    const socketPath = join(dir, "odu.sock");
    try {
      const a = await serveTestSurface(
        { ...state([["ci::x@x86_64-linux", "running"]]), name: "run-A" },
        undefined,
        socketPath,
      );
      const { mcp } = await connect(a, socketPath);

      let read = await mcp.readResource({ uri: "surface://streams/nodes" });
      expect(JSON.parse((read.contents[0] as { text: string }).text).pipeline).toBe("run-A");

      // First coordinator gone; a second run binds the same path.
      a.close();
      const b = await serveTestSurface(
        { ...state([["ci::y@x86_64-linux", "running"]]), name: "run-B" },
        undefined,
        socketPath,
      );
      let seen = "";
      for (let i = 0; i < 50 && seen !== "run-B"; i += 1) {
        read = await mcp.readResource({ uri: "surface://streams/nodes" });
        seen = JSON.parse((read.contents[0] as { text: string }).text).pipeline;
        if (seen !== "run-B") await new Promise((r) => setTimeout(r, 20));
      }
      expect(seen).toBe("run-B");

      // And after the second run ends, reads fall back to the no-run value.
      b.close();
      read = await mcp.readResource({ uri: "surface://streams/nodes" });
      expect(JSON.parse((read.contents[0] as { text: string }).text)).toEqual({
        run: false,
        pipeline: null,
        nodes: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("node_rerun proxies the mutation to the coordinator surface", async () => {
    const s = await serve([["ci::e2e@x86_64-linux", "failed"]]);
    const { mcp } = await connect(s);

    const res = await mcp.callTool({
      name: "node_rerun",
      arguments: { id: "ci::e2e@x86_64-linux" },
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(
      (res.content as Array<{ text: string }>)[0]?.text ?? "null",
    );
    expect(body).toEqual({ ok: true });
    expect(s.reruns).toEqual(["ci::e2e@x86_64-linux"]);
  });

  it("reads a node's live log via the logs collection item", async () => {
    const s = await serve([["ci::e2e@x86_64-linux", "running"]]);
    s.appendLog("ci::e2e@x86_64-linux", "cucumber: 14 scenarios\n");
    const { mcp } = await connect(s);

    // First read primes the live follow (returns the durable/empty fallback);
    // poll the item until the live frame lands.
    const uri = `surface://collections/logs/${encodeURIComponent("ci::e2e@x86_64-linux")}`;
    let text = "";
    for (let i = 0; i < 50 && !text.includes("cucumber"); i += 1) {
      const read = await mcp.readResource({ uri });
      text = JSON.parse((read.contents[0] as { text: string }).text).text;
      if (!text.includes("cucumber")) await new Promise((r) => setTimeout(r, 20));
    }
    expect(text).toContain("cucumber: 14 scenarios");
  });

  it("subscribing to a log item is notified for the snapshot and each append", async () => {
    const s = await serve([["ci::e2e@x86_64-linux", "running"]]);
    s.appendLog("ci::e2e@x86_64-linux", "scenario 1\n");
    const { mcp } = await connect(s);

    const uri = `surface://collections/logs/${encodeURIComponent("ci::e2e@x86_64-linux")}`;
    const updates: string[] = [];
    mcp.setNotificationHandler(
      ResourceUpdatedNotificationSchema,
      (n) => {
        if (n.params.uri === uri) updates.push(uri);
      },
    );

    await mcp.subscribeResource({ uri });
    // The live follow publishes the buffered snapshot through the collection's
    // per-key bus → a `notifications/resources/updated`. A later append must
    // notify again (the follow stays open — not a one-shot snapshot).
    for (let i = 0; i < 50 && updates.length < 1; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(updates.length).toBeGreaterThanOrEqual(1);

    const before = updates.length;
    s.appendLog("ci::e2e@x86_64-linux", "scenario 2\n");
    for (let i = 0; i < 50 && updates.length <= before; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(updates.length).toBeGreaterThan(before);

    // And a read reflects the appended output (the read connection's own
    // follow accumulates the snapshot + appends; poll until it lands).
    let text = "";
    for (let i = 0; i < 50 && !text.includes("scenario 2"); i += 1) {
      const read = await mcp.readResource({ uri });
      text = JSON.parse((read.contents[0] as { text: string }).text).text;
      if (!text.includes("scenario 2")) await new Promise((r) => setTimeout(r, 20));
    }
    expect(text).toContain("scenario 2");
  });
});

describe("no-run state — the face stays usable with no coordinator socket", () => {
  /** Stand up the server exactly as `mcpCommand` does for the no-socket case:
   *  the factory returns the no-run fallback client (no dial). This is the
   *  state an agent is in when it calls `run` to start a pipeline. */
  async function connectNoRun(runHandler: () => unknown) {
    const projection = buildAgentProjection(oduSurface, gitRunContext);
    // A re-dialing A-client whose dial always fails (no coordinator socket) —
    // the exact wiring `mcpCommand` uses, minus a live socket.
    const aClient = redialingAClient(async () => null);
    const { router } = projection.implement(aClient);
    const bClient = directLink<typeof projection.surface.contract>(router);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const served = await serveSurfaceAsMcp({
      surface: projection.surface,
      client: () => bClient,
      expose: {
        nodes: "resource",
        logs: "resource",
        "node.rerun": { tool: { mutates: true } },
      },
      tools: {
        run: { description: "stub", handler: runHandler, mutates: true },
      },
      serverInfo: { name: "odu", version: "0.0.0" },
      transport: serverTransport,
    });
    const mcp = new Client({ name: "test-client", version: "0.0.0" });
    await mcp.connect(clientTransport);
    closers.push(
      () => mcp.close(),
      () => served.close(),
    );
    return mcp;
  }

  it("run reaches its handler with no socket (does not throw 'no run in progress')", async () => {
    let reached = false;
    const mcp = await connectNoRun(() => {
      reached = true;
      return { ok: true, started: true };
    });
    const res = await mcp.callTool({ name: "run", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(reached).toBe(true);
  });

  it("nodes reads { run: false } with no socket (mirrors old get_nodes)", async () => {
    const mcp = await connectNoRun(() => ({ ok: true, started: true }));
    const read = await mcp.readResource({ uri: "surface://streams/nodes" });
    const body = JSON.parse((read.contents[0] as { text: string }).text);
    expect(body).toEqual({ run: false, pipeline: null, nodes: [] });
  });
});

describe("durableLog — guards (ported)", () => {
  it("refuses a node id that escapes the per-SHA log dir", () => {
    // A real .log file sits outside `.ci/<sha7>`; a `..`-laden node id whose
    // logPathFor resolves to it must be rejected, not read.
    const secret = join(tmpdir(), `odu-traversal-${process.pid}.log`);
    writeFileSync(secret, "SECRET CONTENTS\n");
    try {
      const root = gitTopLevel();
      const sha7 = headSha7(root);
      expect(root).not.toBeNull();
      expect(sha7).not.toBeNull();
      const climb = relative(
        join(root as string, ".ci", sha7 as string, "x86_64-linux"),
        secret,
      ).replace(/\.log$/, "");
      const token = `${climb}@x86_64-linux`;
      const result = durableLog(token, root as string, sha7 as string);
      expect(result.source).toBe("missing");
      expect(result.text).toBe("");
    } finally {
      rmSync(secret, { force: true });
    }
  });

  it("clamps a durable log to the 64KB cap", () => {
    const root = gitTopLevel();
    const sha7 = headSha7(root);
    expect(root).not.toBeNull();
    expect(sha7).not.toBeNull();
    const token = `clamp-test-${process.pid}@x86_64-linux`;
    const dir = join(root as string, ".ci", sha7 as string, "x86_64-linux");
    const file = join(dir, `clamp-test-${process.pid}.log`);
    const big = "x".repeat(200 * 1024);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, big);
      const result = durableLog(token, root as string, sha7 as string);
      expect(result.source).toBe("file");
      expect(result.text.length).toBe(64 * 1024);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("reports missing when no durable file exists", () => {
    const ctx = gitRunContext();
    expect(ctx).not.toBeNull();
    const result = durableLog(
      `ci::nope-${process.pid}@aarch64-darwin`,
      (ctx as { repoRoot: string }).repoRoot,
      (ctx as { sha7: string }).sha7,
    );
    expect(result.source).toBe("missing");
  });
});

describe("wait_for_settle — fail-fast / settle / timeout / cancel (ported)", () => {
  /** A live B (agent) client over a test surface, for the verdict unit. */
  async function agentWaitClient(s: TestSurface): Promise<AgentNodesReader> {
    const { unixSocketLink } = await import("@kolu/surface/links/unix-socket");
    const projection = buildAgentProjection(oduSurface, gitRunContext);
    const dialed = await unixSocketLink<typeof oduSurface.contract>({
      socketPath: s.socketPath,
    });
    const { router } = projection.implement(dialed.client);
    closers.push(() => dialed.dispose());
    return directLink<typeof projection.surface.contract>(
      router,
    ) as AgentNodesReader;
  }

  it("returns the verdict the instant a node goes red (fail-fast)", async () => {
    const s = await serve([
      ["ci::nix@x86_64-linux", "running"],
      ["ci::e2e@x86_64-linux", "running"],
    ]);
    const client = await agentWaitClient(s);
    setTimeout(() => {
      s.setState(
        state([
          ["ci::nix@x86_64-linux", "running"],
          ["ci::e2e@x86_64-linux", "failed"],
        ]),
      );
    }, 30);
    const v = await waitForSettle({ client, failFast: true, timeoutMs: 2000 });
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
    const client = await agentWaitClient(s);
    const v = await waitForSettle({ client, failFast: false, timeoutMs: 2000 });
    expect(v).toMatchObject({ settled: true, passed: true, timed_out: false });
  });

  it("times out on a run that never settles", async () => {
    const s = await serve([["ci::nix@x86_64-linux", "running"]]);
    const client = await agentWaitClient(s);
    const v = await waitForSettle({ client, failFast: false, timeoutMs: 80 });
    expect(v.timed_out).toBe(true);
    expect(v.settled).toBe(false);
  });

  it("never reports passed when the run does not settle green", async () => {
    // Coordinator vanishes (crash / socket close) while a node is still
    // running and no node is red — must NOT be a false green.
    const s = await serve([["ci::nix@x86_64-linux", "running"]]);
    const client = await agentWaitClient(s);
    setTimeout(() => s.close(), 30);
    const v = await waitForSettle({ client, failFast: false, timeoutMs: 300 });
    expect(v.passed).toBe(false);
    expect(v.settled).toBe(false);
  });

  it("returns cancelled when the caller aborts the wait", async () => {
    const s = await serve([["ci::nix@x86_64-linux", "running"]]);
    const client = await agentWaitClient(s);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const v = await waitForSettle({
      client,
      failFast: false,
      timeoutMs: 2000,
      signal: ac.signal,
    });
    expect(v.cancelled).toBe(true);
    expect(v.timed_out).toBe(false);
    expect(v.passed).toBe(false);
  });
});
