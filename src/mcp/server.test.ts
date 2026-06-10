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

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { directLink } from "@kolu/surface/links/direct";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { serveSurfaceAsMcp } from "@kolu/surface-mcp";
import { afterEach, describe, expect, it } from "vitest";
import { gitTopLevel, headSha7 } from "../common/git";
import { oduSurface, pendingNode, type PipelineState } from "../common/surface";
import { buildAgentProjection, durableLog } from "./agentSurface";
import { serveTestSurface, type TestSurface } from "./serveForTest";
import { waitForSettle, type WaitClient } from "./waitTool";

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

/** Stand up the MCP server (projection of the live test surface) + a connected
 *  MCP client over an in-memory pair. */
async function connect(s: TestSurface) {
  const projection = buildAgentProjection(oduSurface);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const { unixSocketLink } = await import("@kolu/surface/links/unix-socket");

  const served = await serveSurfaceAsMcp({
    surface: projection.surface,
    client: async () => {
      const dialed = await unixSocketLink<typeof oduSurface.contract>({
        socketPath: s.socketPath,
      });
      const { router } = projection.implement(dialed.client);
      return {
        client: directLink<typeof projection.surface.contract>(router),
        dispose: dialed.dispose,
      };
    },
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
    expect(uris).toContain("surface://cells/nodes");

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

  it("reads the nodes cell as the flattened agent snapshot", async () => {
    const s = await serve([
      ["ci::unit@x86_64-linux", "ok"],
      ["ci::e2e@x86_64-linux", "running"],
    ]);
    const { mcp } = await connect(s);

    // The agent `nodes` cell is a `deriveCell` projection: its snapshot tracks
    // A's cell asynchronously (A's frame arrives a tick after the connect
    // subscription starts), so a one-shot read can briefly see the empty
    // pre-snapshot value. Poll until A's snapshot has propagated — the live
    // resource is subscribable, so a host gets the update via a notification.
    let body: { run: boolean; pipeline: string | null; nodes: unknown[] } = {
      run: false,
      pipeline: null,
      nodes: [],
    };
    for (let i = 0; i < 50 && !body.run; i += 1) {
      const read = await mcp.readResource({ uri: "surface://cells/nodes" });
      body = JSON.parse((read.contents[0] as { text: string }).text);
      if (!body.run) await new Promise((r) => setTimeout(r, 20));
    }
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

    // First read primes the live cache (returns the durable/empty fallback);
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
      const result = durableLog(token);
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
      const result = durableLog(token);
      expect(result.source).toBe("file");
      expect(result.text.length).toBe(64 * 1024);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("reports missing when no durable file exists", () => {
    const result = durableLog(`ci::nope-${process.pid}@aarch64-darwin`);
    expect(result.source).toBe("missing");
  });
});

describe("wait_for_settle — fail-fast / settle / timeout / cancel (ported)", () => {
  /** A live B (agent) client over a test surface, for the verdict unit. */
  async function agentWaitClient(s: TestSurface): Promise<WaitClient> {
    const { unixSocketLink } = await import("@kolu/surface/links/unix-socket");
    const projection = buildAgentProjection(oduSurface);
    const dialed = await unixSocketLink<typeof oduSurface.contract>({
      socketPath: s.socketPath,
    });
    const { router } = projection.implement(dialed.client);
    closers.push(() => dialed.dispose());
    return directLink<typeof projection.surface.contract>(router) as WaitClient;
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
