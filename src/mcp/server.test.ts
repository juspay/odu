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
import { afterEach, describe, expect, it } from "bun:test";
import { gitRunContext } from "../common/git";
import type { RunOutcome, RunRecord } from "../common/runRecord";
import { writeRunRecord } from "../coordinator/ledger";
import { tryDialSocket } from "../coordinator/socket";
import { oduSurface, pendingNode, type PipelineState } from "../common/surface";
import {
  type AgentNodesReader,
  buildAgentProjection,
  type DialA,
  type ResolveRunContext,
  durableLog,
  redialingAClient,
} from "./agentSurface";
import { cancelTool } from "./cancelTool";
import { serveTestSurface, type TestSurface } from "./serveForTest";
import { makeWaitTool, type SettleVerdict, waitForSettle } from "./waitTool";


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
  return { name: "test", sha7: "abc1234", dirty: false, seq: 3, order, nodes };
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

/** Retry `fn` up to `maxAttempts` times at `delayMs` intervals until the
 *  returned value satisfies `pred`. Returns the last value regardless. */
async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (val: T) => boolean,
  maxAttempts = 50,
  delayMs = 20,
): Promise<T> {
  // Tolerate a TRANSIENT throw from `fn` (e.g. reading a collection item whose key
  // is not registered YET — surface-mcp throws "collection key is not present" until
  // the run's snapshot lands) by treating it as an unsatisfied poll and retrying.
  // Only surface the last error if we exhaust attempts having NEVER succeeded — a
  // persistently-broken read still fails loudly, but a startup race no longer does.
  let val: T | undefined;
  let lastErr: unknown;
  let succeeded = false;
  for (let i = 0; i < maxAttempts; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      val = await fn();
      succeeded = true;
      lastErr = undefined;
      if (pred(val)) return val;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!succeeded) throw lastErr;
  return val as T;
}

/** Shared MCP-server wiring used by both `connect` and `connectNoRun`: build
 *  the projection over a re-dialing A-client, wire the in-memory transport, and
 *  register closers. `dial` controls whether a live coordinator is reachable;
 *  `tools` is the bespoke-tool map passed to `serveSurfaceAsMcp`. */
async function connectWith(
  dial: DialA,
  tools: Parameters<typeof serveSurfaceAsMcp>[0]["tools"],
) {
  const projection = buildAgentProjection(oduSurface, gitRunContext);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const aClient = redialingAClient(dial);
  const { router } = projection.implement(aClient);
  const bClient = directLink<typeof projection.surface.contract>(router);
  const served = await serveSurfaceAsMcp({
    surface: projection.surface,
    client: () => bClient,
    expose: {
      nodes: "resource",
      logs: "resource",
      "node.rerun": { tool: { mutates: true } },
      "node.cancel": { tool: { mutates: true } },
      "lane.cancel": { tool: { mutates: true } },
    },
    tools,
    serverInfo: { name: "odu", version: "0.0.0" },
    transport: serverTransport,
  });
  const mcp = new Client({ name: "test-client", version: "0.0.0" });
  await mcp.connect(clientTransport);
  closers.push(() => mcp.close(), () => served.close());
  return { mcp, served };
}

/** Stand up the MCP server + a connected MCP client over an in-memory pair,
 *  wired exactly as `mcpCommand`: one stable B-client over a re-dialing
 *  A-client that dials `socketPath` fresh per call (so a coordinator restart at
 *  the same path is observed). `socketPath` defaults to the served surface's. */
async function connect(s: TestSurface, socketPath: string = s.socketPath) {
  return connectWith(
    async () => {
      const dialed = await tryDialSocket(socketPath);
      return dialed === null ? null : { client: dialed.client, close: dialed.close };
    },
    {
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
      cancel: cancelTool,
    },
  );
}

describe("odu agent MCP — end to end over the in-memory transport", () => {
  it("tools/list is exactly [cancel, lane_cancel, node_cancel, node_rerun, run, wait_for_settle] (default-deny)", async () => {
    const s = await serve([["ci::e2e@x86_64-linux", "running"]]);
    const { mcp } = await connect(s);

    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "cancel",
      "lane_cancel",
      "node_cancel",
      "node_rerun",
      "run",
      "wait_for_settle",
    ]);
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
      read = await pollUntil(
        () => mcp.readResource({ uri: "surface://streams/nodes" }),
        (r) => JSON.parse((r.contents[0] as { text: string }).text).pipeline === "run-B",
      );
      expect(JSON.parse((read.contents[0] as { text: string }).text).pipeline).toBe("run-B");

      // And after the second run ends, reads fall back to the no-run value.
      b.close();
      read = await mcp.readResource({ uri: "surface://streams/nodes" });
      expect(JSON.parse((read.contents[0] as { text: string }).text)).toEqual({
        run: false,
        pipeline: null,
        sha7: "",
        seq: null,
        nodes: [],
        unposted: [],
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

  it("node_cancel proxies the mutation to the coordinator surface", async () => {
    const s = await serve([["ci::e2e@x86_64-linux", "running"]]);
    const { mcp } = await connect(s);

    const res = await mcp.callTool({
      name: "node_cancel",
      arguments: { id: "ci::e2e@x86_64-linux" },
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(
      (res.content as Array<{ text: string }>)[0]?.text ?? "null",
    );
    expect(body).toEqual({ ok: true });
    expect(s.nodeCancels).toEqual(["ci::e2e@x86_64-linux"]);
  });

  it("lane_cancel proxies the mutation to the coordinator surface", async () => {
    const s = await serve([["ci::e2e@x86_64-linux", "running"]]);
    const { mcp } = await connect(s);

    const res = await mcp.callTool({
      name: "lane_cancel",
      arguments: { platform: "aarch64-darwin" },
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(
      (res.content as Array<{ text: string }>)[0]?.text ?? "null",
    );
    expect(body).toEqual({ ok: true });
    expect(s.laneCancels).toEqual(["aarch64-darwin"]);
  });

  it("reads a node's live log via the logs collection item", async () => {
    const s = await serve([["ci::e2e@x86_64-linux", "running"]]);
    s.appendLog("ci::e2e@x86_64-linux", "cucumber: 14 scenarios\n");
    const { mcp } = await connect(s);

    // First read primes the live follow (returns the durable/empty fallback);
    // poll the item until the live frame lands.
    const uri = `surface://collections/logs/${encodeURIComponent("ci::e2e@x86_64-linux")}`;
    const read = await pollUntil(
      () => mcp.readResource({ uri }),
      (r) => JSON.parse((r.contents[0] as { text: string }).text).text.includes("cucumber"),
    );
    const text = JSON.parse((read.contents[0] as { text: string }).text).text;
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
    await pollUntil(async () => updates.length, (n) => n >= 1);
    expect(updates.length).toBeGreaterThanOrEqual(1);

    const before = updates.length;
    s.appendLog("ci::e2e@x86_64-linux", "scenario 2\n");
    await pollUntil(async () => updates.length, (n) => n > before);
    expect(updates.length).toBeGreaterThan(before);

    // And a read reflects the appended output (the read connection's own
    // follow accumulates the snapshot + appends; poll until it lands).
    const finalRead = await pollUntil(
      () => mcp.readResource({ uri }),
      (r) => JSON.parse((r.contents[0] as { text: string }).text).text.includes("scenario 2"),
    );
    const text = JSON.parse((finalRead.contents[0] as { text: string }).text).text;
    expect(text).toContain("scenario 2");
  });
});

describe("no-run state — the face stays usable with no coordinator socket", () => {
  /** Stand up the server exactly as `mcpCommand` does for the no-socket case:
   *  the factory returns the no-run fallback client (no dial). This is the
   *  state an agent is in when it calls `run` to start a pipeline. */
  async function connectNoRun(runHandler: () => unknown) {
    // A re-dialing A-client whose dial always fails (no coordinator socket) —
    // the exact wiring `mcpCommand` uses, minus a live socket.
    const { mcp } = await connectWith(async () => null, {
      run: { description: "stub", handler: runHandler, mutates: true },
    });
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
    expect(body).toEqual({
      run: false,
      pipeline: null,
      sha7: "",
      seq: null,
      nodes: [],
      unposted: [],
    });
  });
});

describe("durableLog — guards (ported)", () => {
  it("refuses a node id that escapes the per-SHA log dir", () => {
    // A real .log file sits outside `.ci/<sha7>`; a `..`-laden node id whose
    // logPathFor resolves to it must be rejected, not read.
    const ctx = gitRunContext();
    expect(ctx).not.toBeNull();
    const { repoRoot, sha7 } = ctx as { repoRoot: string; sha7: string };
    const secret = join(tmpdir(), `odu-traversal-${process.pid}.log`);
    writeFileSync(secret, "SECRET CONTENTS\n");
    try {
      const climb = relative(
        join(repoRoot, ".ci", sha7, "x86_64-linux"),
        secret,
      ).replace(/\.log$/, "");
      const token = `${climb}@x86_64-linux`;
      const result = durableLog(token, repoRoot, sha7);
      expect(result.source).toBe("missing");
      expect(result.text).toBe("");
    } finally {
      rmSync(secret, { force: true });
    }
  });

  it("clamps a durable log to the 64KB cap", () => {
    const ctx = gitRunContext();
    expect(ctx).not.toBeNull();
    const { repoRoot, sha7 } = ctx as { repoRoot: string; sha7: string };
    const token = `clamp-test-${process.pid}@x86_64-linux`;
    const dir = join(repoRoot, ".ci", sha7, "x86_64-linux");
    const file = join(dir, `clamp-test-${process.pid}.log`);
    const big = "x".repeat(200 * 1024);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, big);
      const result = durableLog(token, repoRoot, sha7);
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
    // `as unknown as`: every surface contract now intersects the framework-reserved
    // `system.live` proc (kolu#1568), so the inferred client type surfaces
    // `surface.system.live` and no longer structurally overlaps the narrower
    // `AgentNodesReader` for a direct cast. The runtime router DOES serve
    // `surface.nodes` (the agent projection), so the narrowing is sound.
    return directLink<typeof projection.surface.contract>(
      router,
    ) as unknown as AgentNodesReader;
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
    // running and no node is red — must NOT be a false green. The run context
    // points at an EMPTY throwaway checkout, so the verdict rests on the
    // stream alone and the test never reads this checkout's real ledger.
    const s = await serve([["ci::nix@x86_64-linux", "running"]]);
    const client = await agentWaitClient(s);
    setTimeout(() => s.close(), 30);
    const v = await waitForSettle({
      client,
      failFast: false,
      timeoutMs: 300,
      resolveRunContext: ledgerWith(null),
    });
    expect(v.passed).toBe(false);
    expect(v.settled).toBe(false);
  });

  /** The record the coordinator finalizes on its way out, for the identity the
   *  test surface publishes (`abc1234#3`). No clock is threaded through these
   *  tests: `outcome` is the whole rule the reader applies, because the
   *  coordinator re-finalizes a resumed run's record as `incomplete` rather
   *  than leaving the reader to date-check it (run.ts `updateNode`). */
  /** A throwaway checkout whose ledger holds `rec` for the identity the test
   *  surface publishes (`abc1234#3`), plus the resolver the tool reads it
   *  through. Deliberately a REAL `.ci` + the real addressed read rather than a
   *  stubbed lookup: the record path production takes is then the one under
   *  test. `null` gives an empty checkout (no record on disk). */
  function ledgerWith(rec: RunRecord | null): ResolveRunContext {
    const dir = mkdtempSync(join(tmpdir(), "odu-ledger-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    if (rec !== null) writeRunRecord(dir, "abc1234", rec);
    return () => ({ repoRoot: dir, sha7: "abc1234" });
  }

  function record(
    outcome: RunOutcome,
    nodes: PipelineState["nodes"] = {},
    finishedAt = 1_000,
  ): RunRecord {
    return {
      version: 1,
      repo: null,
      sha: "abc1234000000000000000000000000000000000",
      seq: 3,
      dirty: false,
      pipeline: "ci::default",
      outcome,
      startedAt: 0,
      finishedAt,
      lanes: [],
      nodes: Object.values(nodes).map((n) => ({
        id: n.id,
        name: n.name,
        status: n.status,
        exitCode: null,
        durationMs: null,
      })),
    };
  }

  it("settles green from the finalized record when the socket closes first", async () => {
    // The close beat the terminal frame: the last snapshot still says running,
    // but the run finished and wrote `passed`. Reporting that as unsettled made
    // a green run unreadable to an agent — the record is the authority once the
    // socket is gone.
    const s = await serve([["ci::nix@x86_64-linux", "running"]]);
    const client = await agentWaitClient(s);
    setTimeout(() => s.close(), 30);
    const v = await waitForSettle({
      client,
      failFast: false,
      timeoutMs: 300,
      resolveRunContext: ledgerWith(record("passed")),
    });
    expect(v).toMatchObject({ settled: true, passed: true, timed_out: false });
  });

  it("the SHIPPING tool handler settles from the ledger", async () => {
    // The handler used to pass no record reader at all, so the lookup that
    // ships was reachable by no test — every case above exercised an injected
    // one. This drives the tool `mcp.ts` builds, through its own handler, so
    // production and the tests traverse the same path.
    const s = await serve([["ci::nix@x86_64-linux", "running"]]);
    const client = await agentWaitClient(s);
    setTimeout(() => s.close(), 30);
    const tool = makeWaitTool(ledgerWith(record("passed")));
    const v = (await tool.handler(
      { fail_fast: false, timeout_ms: 300 },
      client as never,
      undefined,
    )) as SettleVerdict;
    expect(v).toMatchObject({ settled: true, passed: true });
  });

  it("settles red from the finalized record, naming the failed node", async () => {
    const s = await serve([["ci::e2e@x86_64-linux", "running"]]);
    const client = await agentWaitClient(s);
    setTimeout(() => s.close(), 30);
    const failedNodes = state([["ci::e2e@x86_64-linux", "failed"]]).nodes;
    const v = await waitForSettle({
      client,
      failFast: false,
      timeoutMs: 300,
      resolveRunContext: ledgerWith(record("failed", failedNodes)),
    });
    expect(v.settled).toBe(true);
    expect(v.passed).toBe(false);
    expect(v.failed).toContain("ci::e2e@x86_64-linux");
  });

  it("stays fail-closed on an incomplete record (torn down mid-run, or a --linger rerun in flight)", async () => {
    // `incomplete` is exactly the half-observed case: a node was still pending
    // or running when the coordinator finalized. Never green.
    //
    // It is also the stale `--linger` drain: a lingering run that passed and
    // then took a `node_rerun` used to leave an on-disk `passed` describing a
    // run that was running again, and the reader dated the record against its
    // own clock to spot it. The coordinator now re-finalizes the moment a node
    // resumes (run.ts `updateNode`), so such a record says `incomplete` itself
    // — the reader needs one rule, not two.
    const s = await serve([["ci::nix@x86_64-linux", "running"]]);
    const client = await agentWaitClient(s);
    setTimeout(() => s.close(), 30);
    const v = await waitForSettle({
      client,
      failFast: false,
      timeoutMs: 300,
      resolveRunContext: ledgerWith(record("incomplete")),
    });
    expect(v.passed).toBe(false);
    expect(v.settled).toBe(false);
  });

  it("refuses a record whose outcome contradicts its own nodes", async () => {
    // `buildRunRecord` can't produce this, but `RunRecordSchema` doesn't forbid
    // it and the ledger reader is deliberately forgiving of odd files. A
    // self-contradicting record is not an authority, so it settles nothing —
    // the reader states that rather than trusting a promise from another module.
    const s = await serve([["ci::e2e@x86_64-linux", "running"]]);
    const client = await agentWaitClient(s);
    setTimeout(() => s.close(), 30);
    const redNodes = state([["ci::e2e@x86_64-linux", "failed"]]).nodes;
    const v = await waitForSettle({
      client,
      failFast: false,
      timeoutMs: 300,
      resolveRunContext: ledgerWith(record("passed", redNodes)),
    });
    expect(v.passed).toBe(false);
    expect(v.settled).toBe(false);
  });

  it.each([
    ["pending", "a node never started"],
    ["running", "a node still in flight"],
  ] as const)(
    "refuses a `passed` record carrying a %s node (%s)",
    async (status, _why) => {
      // The half-observed run this path exists to NOT call green. `passed`
      // beside a non-terminal node is the same class of contradiction as
      // `passed` beside a red one — the schema admits both, so the reader
      // re-derives the whole invariant instead of half of it.
      const s = await serve([["ci::e2e@x86_64-linux", "running"]]);
      const client = await agentWaitClient(s);
      // Give the first live frame time to land before closing (darwin flakes
      // with a 30ms close: streamEnded saw no last.run and threw NoLiveRun).
      setTimeout(() => s.close(), 80);
      const openNodes = state([["ci::e2e@x86_64-linux", status]]).nodes;
      const v = await waitForSettle({
        client,
        failFast: false,
        timeoutMs: 500,
        resolveRunContext: ledgerWith(record("passed", openNodes)),
      });
      expect(v.passed).toBe(false);
      expect(v.settled).toBe(false);
    },
  );

  it("refuses a `failed` record with no red node", async () => {
    // The mirror of the passed+red case: an outcome its own node list cannot
    // justify. Reporting it would name no failing node for a red verdict.
    const s = await serve([["ci::nix@x86_64-linux", "running"]]);
    const client = await agentWaitClient(s);
    setTimeout(() => s.close(), 30);
    const greenNodes = state([["ci::nix@x86_64-linux", "ok"]]).nodes;
    const v = await waitForSettle({
      client,
      failFast: false,
      timeoutMs: 300,
      resolveRunContext: ledgerWith(record("failed", greenNodes)),
    });
    expect(v.settled).toBe(false);
  });

  it("takes posting debt from the record it settled from, not the stale frame", async () => {
    // One authority per verdict: if the record answers pass/fail, it also
    // answers what statuses it still owed at finalize (juspay/odu#61).
    const s = await serve([["ci::nix@x86_64-linux", "running"]]);
    const client = await agentWaitClient(s);
    setTimeout(() => s.close(), 30);
    const owed = {
      ...record("passed"),
      unposted: [{ context: "odu / unit", lastError: "gh: 502" }],
    };
    const v = await waitForSettle({
      client,
      failFast: false,
      timeoutMs: 300,
      resolveRunContext: ledgerWith(owed),
    });
    expect(v.passed).toBe(true);
    expect(v.unposted).toEqual([
      { context: "odu / unit", lastError: "gh: 502", attempts: 0 },
    ]);
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

  // ── issue #49 ─────────────────────────────────────────────────────────────

  /** A live B (agent) client wired exactly as `mcpCommand`'s no-run case: the
   *  A-client's dial always fails, so `nodes` yields the `{run:false}` no-run
   *  frame — the state an agent is in when its checkout has no live socket. */
  function agentNoRunClient(): AgentNodesReader {
    const projection = buildAgentProjection(oduSurface, gitRunContext);
    const aClient = redialingAClient(async () => null);
    const { router } = projection.implement(aClient);
    return directLink<typeof projection.surface.contract>(
      router,
    ) as unknown as AgentNodesReader;
  }

  it("ask 1: no live run refuses LOUD (throws) instead of an instant empty verdict", async () => {
    const client = agentNoRunClient();
    // Today's bug: this resolves `{settled:false, …, timed_out:false}` in ~2ms,
    // ignoring the timeout and indistinguishable from a real verdict. It must
    // instead throw the CLI-parity refusal.
    await expect(
      waitForSettle({ client, failFast: false, timeoutMs: 5000 }),
    ).rejects.toThrow(/no run in progress in this checkout/);
  });

  it("ask 2: stamps the settled verdict with run identity (sha7, seq)", async () => {
    const s = await serve([
      ["ci::unit@x86_64-linux", "ok"],
      ["ci::nix@x86_64-linux", "ok"],
    ]);
    const client = await agentWaitClient(s);
    const v = await waitForSettle({ client, failFast: false, timeoutMs: 2000 });
    expect(v).toMatchObject({
      settled: true,
      passed: true,
      sha7: "abc1234",
      seq: 3,
      unposted: [],
    });
  });

  it("carries full unposted rows from the live posting health (juspay/odu#61)", async () => {
    const s = await serve([["ci::unit@x86_64-linux", "ok"]]);
    s.setState({
      ...state([["ci::unit@x86_64-linux", "ok"]]),
      posting: {
        owed: [
          {
            context: "ci::unit@x86_64-linux",
            lastError: "403 rate limited",
            attempts: 2,
          },
        ],
      },
    });
    const client = await agentWaitClient(s);
    const v = await waitForSettle({ client, failFast: false, timeoutMs: 2000 });
    expect(v.settled).toBe(true);
    expect(v.passed).toBe(true);
    expect(v.unposted).toEqual([
      {
        context: "ci::unit@x86_64-linux",
        lastError: "403 rate limited",
        attempts: 2,
      },
    ]);
  });

  it("ask 2: a run frame with no reserved seq yields sha7 but seq null", async () => {
    // The coordinator couldn't reserve a seq (a rare reservation-write failure),
    // so it publishes state with `seq` absent. An observed run's verdict then
    // carries `sha7` but `seq: null` — no unique `sha7#seq` is claimed
    // (juspay/odu#49 F5); the identity is honestly partial, never fabricated.
    const noSeq = { ...state([["ci::unit@x86_64-linux", "ok"]]), seq: undefined };
    const s = await serveTestSurface(noSeq);
    open.push(s);
    const client = await agentWaitClient(s);
    const v = await waitForSettle({ client, failFast: false, timeoutMs: 2000 });
    expect(v).toMatchObject({ settled: true, passed: true, sha7: "abc1234" });
    expect(v.seq).toBeNull();
  });

  it("ask 2: stamps run identity onto a fail-fast verdict too", async () => {
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
    expect(v.fail_fast_tripped).toBe(true);
    expect(v).toMatchObject({ sha7: "abc1234", seq: 3 });
  });

  it("ask 3: refuses LOUD when the live run's sha does not match expected_sha", async () => {
    const s = await serve([["ci::nix@x86_64-linux", "running"]]);
    const client = await agentWaitClient(s);
    await expect(
      waitForSettle({
        client,
        expectedSha: "deadbeef",
        failFast: false,
        timeoutMs: 500,
      }),
    ).rejects.toThrow(/no live run matching deadbeef/);
  });

  it("ask 3: proceeds when expected_sha prefix-matches the live run", async () => {
    const s = await serve([
      ["ci::unit@x86_64-linux", "ok"],
      ["ci::nix@x86_64-linux", "ok"],
    ]);
    const client = await agentWaitClient(s);
    // "abc1234" is the served run's sha7; a prefix of it matches.
    const v = await waitForSettle({
      client,
      expectedSha: "abc12",
      failFast: false,
      timeoutMs: 2000,
    });
    expect(v).toMatchObject({ settled: true, passed: true, sha7: "abc1234" });
  });

  it("ask 3: a mismatch refusal is NOT downgraded to timed_out when the abort races it", async () => {
    // The expected_sha throw fires inside the read loop; its unwinding awaits the
    // iterator cleanup, and the timeout can fire in that window so the controller
    // is aborted by the time the catch runs. The loud refusal must still throw,
    // never be swallowed into a timed_out verdict (the nothing-verdict #49 kills).
    // Reproduced deterministically: the stream aborts (via the caller signal, the
    // same controller the timeout uses) BEFORE yielding the mismatched frame.
    const ac = new AbortController();
    const client: AgentNodesReader = {
      surface: {
        nodes: {
          get: async () => ({
            async *[Symbol.asyncIterator]() {
              ac.abort(); // controller aborted before the throw propagates
              yield {
                run: true,
                pipeline: "p",
                sha7: "beef123",
                seq: 1,
                nodes: [
                  {
                    id: "n",
                    name: "n",
                    status: "running",
                    exit_code: null,
                    duration_ms: null,
                    red: false,
                  },
                ],
                unposted: [],
              };
            },
          }),
        },
      },
    };
    await expect(
      waitForSettle({
        client,
        expectedSha: "deadbeef",
        failFast: false,
        timeoutMs: 5000,
        signal: ac.signal,
      }),
    ).rejects.toThrow(/no live run matching deadbeef/);
  });
});
