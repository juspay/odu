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
import { buildSurfaceFace } from "@kolu/surface/client";
import { directDispatch } from "@kolu/surface/links/direct";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  serveSurfaceAsMcp,
  type SurfaceClientCallable,
} from "@kolu/surface-mcp";
import { Cause, Effect, Stream } from "effect";
import { SurfaceStdioTransportClosed } from "@kolu/surface/errors";
import { afterEach, describe, expect, it } from "bun:test";
import {
  oduSurface,
  pendingNode,
  type PipelineState,
} from "@odu/run-client/surface";
import { gitRunContext } from "../common/git";
import type { RunOutcome, RunRecord } from "@odu/run-history/legacy/record";
import { writeRunRecord } from "@odu/run-history/legacy/ledger";
import {
  type AgentNodes,
  type AgentNodesReader,
  buildAgentProjection,
  type DialA,
  dialAFor,
  type ResolveRunContext,
  toAgentNodes,
  durableLog,
  redialingAClient,
} from "./agentSurface";
import { cancelTool } from "./cancelTool";
import { leaseTool, releaseTool } from "./leaseTool";
import { laneCancelTool, nodeCancelTool } from "./partialCancelTools";
import { rerunTool } from "./rerunTool";
import { runTool } from "./runTool";
import { runsTool } from "./runsTool";
import { serveTestSurface, type TestSurface } from "./serveForTest";
import {
  type SettleVerdict,
  waitForSettle,
} from "../coordinator/waitForSettle";
import { makeWaitTool } from "./waitTool";

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
  const bClient = buildSurfaceFace(
    projection.surface,
    directDispatch(projection.implement(aClient)),
  ) as unknown as SurfaceClientCallable;
  const served = await serveSurfaceAsMcp({
    surface: projection.surface,
    client: () => bClient,
    expose: {
      nodes: "resource",
      logs: "resource",
      // No procedure entries — exactly as `mcp.ts` ships it: every `node.*` /
      // `lane.*` verb is bespoke (the only door carrying a description AND a
      // per-call `checkout`).
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
    dialAFor(socketPath),
    {
      // The REAL `run` tool, not a stub: its description and its `supersede` /
      // `linger` argument annotations are part of what this file asserts, and a
      // stub would assert the stub. Never CALLED here (the no-run describe
      // below has its own handler stub), so nothing spawns.
      run: runTool,
      wait_for_settle: {
        description: "stub",
        handler: () => Effect.succeed({ settled: false }),
      },
      cancel: cancelTool,
      node_rerun: rerunTool,
      node_cancel: nodeCancelTool,
      lane_cancel: laneCancelTool,
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

  it("node_rerun tells an agent what it is for, and that it cancels nothing", async () => {
    // It shipped with NO description at all — a bare `id` and nothing else —
    // because a procedure exposure has no field for one, and this is the verb
    // that could least afford it: an agent that cannot see the cheap
    // single-lane retry reasons its way to `run({supersede})` instead and
    // throws away every other lane. The tool now comes through the bespoke
    // door, so the words reach the host. Facts, not phrasing: what it does,
    // that it works mid-run, that nothing else is cancelled, and where to look
    // instead of superseding.
    const s = await serve([["ci::e2e@x86_64-linux", "running"]]);
    const { mcp } = await connect(s);
    const { tools } = await mcp.listTools();
    const rerun = tools.find((t) => t.name === "node_rerun");
    const description = rerun?.description ?? "";
    expect(description.length).toBeGreaterThan(0);
    expect(description).toMatch(/still live|live run/i);
    expect(description).toMatch(/cancels nothing/i);
    expect(description).toMatch(/supersede/);
    // The `id` argument says what an id LOOKS like — it was a bare string.
    const idSchema = (rerun?.inputSchema.properties as Record<string, { description?: string }>)?.id;
    expect(idSchema?.description ?? "").toMatch(/@/);
    // Still advertised as mutating (it puts work back on a lane).
    expect(rerun?.annotations?.readOnlyHint).toBe(false);
  });

  it("run points at node_rerun instead of leaving supersede the documented retry", async () => {
    // The other half of the same misreading: `supersede` was described and
    // `node_rerun` was not, so the destructive whole-run restart was the only
    // legible way to have another go. Both the tool's own words and the
    // `supersede` ARGUMENT (a `.annotate`, which is what a host actually shows
    // — a JSDoc above the field is not) have to name the cheap one.
    const s = await serve([["ci::e2e@x86_64-linux", "running"]]);
    const { mcp } = await connect(s);
    const { tools } = await mcp.listTools();
    const run = tools.find((t) => t.name === "run");
    expect(run?.description ?? "").toContain("node_rerun");
    const props = run?.inputSchema.properties as
      | Record<string, { description?: string }>
      | undefined;
    const supersede = props?.supersede?.description ?? "";
    expect(supersede).toMatch(/whole run|every platform lane/i);
    expect(supersede).toContain("node_rerun");
    // `linger` exists so a node can be rerun after settle — say whose.
    expect(props?.linger?.description ?? "").toContain("node_rerun");
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

  it("every bespoke tool advertises the optional `checkout` argument, exactly as mcp.ts registers the kit", async () => {
    // The multi-checkout contract is a HOST-VISIBLE fact, so it is pinned
    // where a host sees it: the advertised input schemas of the WHOLE tool
    // map `mcp.ts` registers (not a curated subset). Each tool carries the
    // argument, it is never required, and it never arrives undescribed —
    // the `.annotate` text is what an agent reads to discover the default.
    const s = await serve([["ci::e2e@x86_64-linux", "running"]]);
    const { mcp } = await connectWith(dialAFor(s.socketPath), {
      run: runTool,
      node_rerun: rerunTool,
      wait_for_settle: makeWaitTool(),
      cancel: cancelTool,
      runs: runsTool,
      node_cancel: nodeCancelTool,
      lane_cancel: laneCancelTool,
      lease: leaseTool,
      release: releaseTool,
    });

    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "cancel",
      "lane_cancel",
      "lease",
      "node_cancel",
      "node_rerun",
      "release",
      "run",
      "runs",
      "wait_for_settle",
    ]);
    for (const tool of tools) {
      const schema = tool.inputSchema;
      const checkout = (
        schema?.properties as Record<string, { description?: string }> | undefined
      )?.checkout;
      expect(checkout, `${tool.name} carries checkout`).toBeDefined();
      expect(
        checkout?.description ?? "",
        `${tool.name}.checkout is described`,
      ).toMatch(/checkout/i);
      expect(
        (schema?.required as string[] | undefined) ?? [],
        `${tool.name}.checkout is optional`,
      ).not.toContain("checkout");
    }
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
  async function connectNoRun(runHandler: () => Effect.Effect<unknown, unknown>) {
    // A re-dialing A-client whose dial always fails (no coordinator socket) —
    // the exact wiring `mcpCommand` uses, minus a live socket.
    const { mcp } = await connectWith(async () => null, {
      run: { description: "stub", handler: runHandler, mutates: true },
    });
    return mcp;
  }

  it("run reaches its handler with no socket (does not throw 'no run in progress')", async () => {
    let reached = false;
    const mcp = await connectNoRun(() =>
      Effect.sync(() => {
        reached = true;
        return { ok: true, started: true };
      }),
    );
    const res = await mcp.callTool({ name: "run", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(reached).toBe(true);
  });

  it("nodes reads { run: false } with no socket (mirrors old get_nodes)", async () => {
    const mcp = await connectNoRun(() =>
      Effect.succeed({ ok: true, started: true }),
    );
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
    // A directory of our own, not a NAME in the shared one. `tmpdir()` is
    // world-writable and a pid is guessable, so a fixture at a predictable
    // path there can be pre-created — as a symlink to somewhere else, say — by
    // anything else on the machine before this line runs. `mkdtempSync` gets
    // a private directory whose name nobody could have predicted, which is
    // the point in a test whose whole subject is a path-traversal guard.
    const secretDir = mkdtempSync(join(tmpdir(), "odu-traversal-"));
    const secret = join(secretDir, "secret.log");
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
      rmSync(secretDir, { recursive: true, force: true });
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
  /** A live B (agent) client over a test surface, for the verdict unit — wired
   *  exactly as `mcpCommand` wires it: the projection over a RE-DIALING
   *  A-client (`dialAFor` at the harness's socket path).
   *
   *  It used to hold one `unixSocketLink` dialed here and hand the projection
   *  that. Production has never done this — `mcp.ts` has always passed
   *  `redialingAClient` — and the difference is not cosmetic: a captured link
   *  is a corpse once it dies, so every test below that closes the surface was
   *  measuring a client shape odu does not ship. The settle wait now re-dials
   *  across a transport-loss end, and what a re-dial FINDS is the whole
   *  question, so the harness has to be able to make one. */
  function agentWaitClient(s: TestSurface): AgentNodesReader {
    const projection = buildAgentProjection(oduSurface, gitRunContext);
    // `as unknown as`: `buildSurfaceFace` returns the deliberately STRUCTURAL
    // `SurfaceFace` (per-member precision lives one layer up — kolu PLAN D2), so
    // it does not structurally overlap the narrower `AgentNodesReader`. The
    // runtime face DOES carry `surface.nodes`, minted by the projection.s own
    // tag walk, so the narrowing is sound.
    return buildSurfaceFace(
      projection.surface,
      directDispatch(projection.implement(redialingAClient(dialAFor(s.socketPath)))),
    ) as unknown as AgentNodesReader;
  }

  /**
   * `reader`, but the server is closed once the wait has actually SEEN a live
   * frame.
   *
   * The cases below are about a close that beat the TERMINAL frame — the last
   * snapshot still says running, the run finished, and the record is the
   * authority. Staging that with `setTimeout(() => s.close(), 30)` stages
   * something else: on a loaded machine the close lands before the wait's first
   * subscription delivers anything, so the wait never observes a live run at
   * all and spends its whole timeout re-dialling a socket nobody serves. That
   * is a different scenario, and it fails.
   *
   * Ordering it on the frame rather than on a clock makes the intended sequence
   * the only one that can happen.
   */
  function closeAfterFirstFrame(
    s: TestSurface,
    reader: AgentNodesReader,
  ): AgentNodesReader {
    let closed = false;
    return {
      surface: {
        nodes: {
          get: (input: void) =>
            Stream.tap(reader.surface.nodes.get(input), (frame) =>
              Effect.sync(() => {
                if (closed || !frame.run) return;
                closed = true;
                s.close();
              }),
            ),
        },
      },
    };
  }

  /** `reader`, but its FIRST subscription dies after `afterFrames` frames with
   *  the error the wire raises when a link's keep-alive goes unanswered — the
   *  exact failure `openWireLink` mints (`SurfaceStdioTransportClosed` with
   *  `death: "keepAliveUnanswered"`) when a coordinator goes quiet for 5–10s,
   *  which a coordinator claiming a venue or copying a runner closure does
   *  routinely.
   *
   *  Only the MOMENT of death is staged. The surface underneath stays up, the
   *  reader is the shipping one, and its next subscription is a real re-dial to
   *  the real socket — which is the whole thing under test. Staging it beats a
   *  20-second `SIGSTOP` on a child coordinator for a unit suite, and pins the
   *  same fact: the wait must not answer a dropped LINK as a settled RUN. */
  function dyingOnce(
    reader: AgentNodesReader,
    afterFrames: number,
    /** Run AT the death, before anything can re-subscribe — the only way to put
     *  a publish deterministically inside the gap the dead link leaves. */
    onDeath: () => void = () => {},
  ): AgentNodesReader {
    let armed = true;
    return {
      surface: {
        nodes: {
          get: (input: void) => {
            const upstream = reader.surface.nodes.get(input);
            if (!armed) return upstream;
            armed = false;
            return Stream.concat(
              Stream.take(upstream, afterFrames),
              Stream.suspend(() => {
                onDeath();
                return Stream.fail(
                  new SurfaceStdioTransportClosed({
                    death: "keepAliveUnanswered",
                    reason:
                      "test: the peer stopped answering the keep-alive ping",
                  }),
                );
              }),
            );
          },
        },
      },
    };
  }

  it("rides out a link death through the SHIPPING B-client, defect and all", async () => {
    // The third path, and the one neither the CLI test nor the units traverse.
    // `odu mcp` does not hand the handler `agentReaderForSocket`; it hands it
    // the adapter's projected B-client (`buildSurfaceFace ∘ directDispatch ∘
    // deriveStream`, src/cli/mcp.ts). The two faces therefore share the settle
    // core and the row mapping but NOT the error channel: `deriveStream`
    // `Stream.orDie`s an upstream failure (`@kolu/surface` project.ts), so the
    // tagged transport death crosses as a DEFECT rather than a failure.
    //
    // Whether `isDeadTransportError` still recognises it on the far side of
    // that squash is the load-bearing question for the MCP half of this change,
    // and it was answered by reading. Answer it by measuring: build the real
    // projection over an A-client whose `nodes` dies once, and drive the core
    // through the B-client the adapter would have been given.
    let pass = 0;
    const aClient = {
      surface: {
        nodes: {
          get: () => {
            pass += 1;
            return pass === 1
              ? Stream.concat(
                  Stream.make(state([["ci::e2e@x86_64-linux", "running"]])),
                  Stream.fail(
                    new SurfaceStdioTransportClosed({
                      death: "keepAliveUnanswered",
                      reason: "test: the peer stopped answering",
                    }),
                  ),
                )
              : Stream.make(state([["ci::e2e@x86_64-linux", "ok"]]));
          },
        },
        nodeLog: { get: () => Stream.empty },
        node: { rerun: () => Effect.succeed({ ok: true }), cancel: () => Effect.succeed({ ok: true }) },
        lane: { cancel: () => Effect.succeed({ ok: true }) },
      },
    };
    const projection = buildAgentProjection(oduSurface, () => null);
    const bClient = buildSurfaceFace(
      projection.surface,
      directDispatch(
        projection.implement(aClient as unknown as Parameters<typeof projection.implement>[0]),
      ),
    ) as unknown as AgentNodesReader;

    const v = await waitForSettle({
      client: bClient,
      failFast: false,
      timeoutMs: 10_000,
      resolveRunContext: () => null,
    });
    expect(v).toMatchObject({ settled: true, passed: true, timed_out: false });
    expect(pass).toBe(2);
  });

  it("never answers a probe that got nothing as a finished run", async () => {
    // THE SEQUENCE, and it is one real scenario rather than two stitched
    // together: a live frame, the wire's keep-alive death, and then the re-dial
    // landing exactly as the peer closes — an interrupt-only `Cause`, which
    // `endOnInterrupt` converts to a CLEAN end carrying no frames.
    //
    // Before the clean-end arm learned to ask `delivered`, that sequence walked
    // straight into `streamEndedVerdict()` with `lastLive` already set and no
    // finalized record to answer, and returned `{settled:false, passed:false}`
    // with every reason flag false — the exact shape of the bug this whole
    // change exists to kill, re-entering through the arm the change added.
    // Measured on that code: 2 passes, 6ms, that verdict.
    let pass = 0;
    const reader: AgentNodesReader = {
      surface: {
        nodes: {
          get: () => {
            pass += 1;
            if (pass === 1) {
              return Stream.concat(
                Stream.make(toAgentNodes(state([["ci::e2e@x86_64-linux", "running"]]))),
                Stream.fail(
                  new SurfaceStdioTransportClosed({
                    death: "keepAliveUnanswered",
                    reason: "test: the peer stopped answering the keep-alive ping",
                  }),
                ),
              );
            }
            if (pass === 2) {
              // The dial that lands as the peer closes. No `_tag`, no frames.
              return Stream.failCause(
                Cause.interrupt(1 as never),
              ) as unknown as Stream.Stream<AgentNodes>;
            }
            // The coordinator is back, and the run it was running settled.
            return Stream.make(
              toAgentNodes(state([["ci::e2e@x86_64-linux", "ok"]])),
            );
          },
        },
      },
    };
    const v = await waitForSettle({
      client: reader,
      failFast: false,
      timeoutMs: 10_000,
      // No ledger record can answer, so a wrong verdict has nowhere to hide.
      resolveRunContext: () => null,
    });
    expect(v).toMatchObject({ settled: true, passed: true, timed_out: false });
    expect(pass).toBe(3);
  });

  it("times out — paced — when the reader goes corpse under a run it had seen", async () => {
    // TWO things at once, both of them holes a reviewer named.
    //
    // (1) THE READER HALF OF THE DIAGNOSIS — and the sequence matters, which
    // is why the corpse FOLLOWS a live frame. A reader built over one captured
    // link is not born dead: it works, delivers the run's frames, and becomes a
    // corpse the moment that one link dies — after which every subscription it
    // mints goes to the same dead socket and delivers nothing. Staging it as
    // dead-from-the-start would go through a different door entirely: with no
    // frame ever delivered `lastLive` is never set, so a loop that wrongly
    // ANSWERED here would raise `NoLiveRunError` ("no run in progress") rather
    // than return the nothing-shape — which is the failure this is supposed to
    // discriminate. With a live frame first, `lastLive` IS set, the fail-closed
    // snapshot IS reachable, and the assertion below is a real refutation:
    // never a green verdict, and never `{settled:false, passed:false}` with
    // `timed_out: false`. `agentReaderFromA` is unexported so this shape cannot
    // be built against a real checkout any more, but a future caller could
    // reintroduce it, and this is what must happen when they do.
    //
    // (2) THE PAUSE. `delivered`-gated backpressure is the only thing between a
    // pathological instant-death dial loop and a reconnect storm, and it was
    // the one branch in the loop pinned by nothing but reading. Every attempt
    // after the first fails INSTANTLY, so an unpaced loop would spin as fast as
    // the event loop allows; at one `STREAM_RETRY_DELAY_MS` (1s) per frameless
    // attempt, a 2.5s budget admits only a handful.
    let attempts = 0;
    const goesCorpse: AgentNodesReader = {
      surface: {
        nodes: {
          get: () => {
            attempts += 1;
            const dead = Stream.fail(
              new SurfaceStdioTransportClosed({
                death: "streamEnded",
                reason: "test: the link this reader captured is gone",
              }),
            ) as unknown as Stream.Stream<AgentNodes>;
            // The link worked once. Everything after it is the same corpse.
            return attempts === 1
              ? Stream.concat(
                  Stream.make(
                    toAgentNodes(state([["ci::e2e@x86_64-linux", "running"]])),
                  ),
                  dead,
                )
              : dead;
          },
        },
      },
    };
    const v = await waitForSettle({
      client: goesCorpse,
      failFast: false,
      timeoutMs: 2_500,
      // No ledger record can answer, so a wrong verdict has nowhere to hide.
      resolveRunContext: () => null,
    });
    expect(v).toMatchObject({
      settled: false,
      passed: false,
      timed_out: true,
      cancelled: false,
    });
    // It knows WHICH run it gave up on — the frame it did see is not forgotten.
    expect(v.sha7).toBe("abc1234");
    // Paced, not spun: without the pause this is thousands.
    expect(attempts).toBeLessThanOrEqual(6);
    // The floor is a TIMING assertion, and the one thing here that could flake:
    // it needs attempt 1 (which delivers, so it re-dials with no pause) and
    // attempt 2 to both land inside the 2.5s budget. That is two synchronous
    // passes with no sleep between them, so a stalled event loop on a loaded
    // runner would have to eat the whole budget to reach 1 — and the failure
    // mode if it ever did is a flaky test, never a masked verdict: the
    // assertions above are what say the wait told the truth.
    expect(attempts).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it("rides out a link that dies under a run still running", async () => {
    // THE BUG (juspay/odu: `wait --settle` returns before the run settles).
    // The link died; the RUN did not. This used to answer `{settled:false,
    // passed:false}` with every reason flag false — no fail-fast, no timeout,
    // no cancellation — which is the nothing-verdict odu#49 exists to kill,
    // arriving through the one door it was never fitted to. The wait must
    // re-subscribe (a re-DIAL, through the shipping reader) and go on waiting.
    const s = await serve([
      ["ci::unit@x86_64-linux", "running"],
      ["ci::nix@x86_64-linux", "running"],
    ]);
    const client = dyingOnce(agentWaitClient(s), 1);
    setTimeout(() => {
      s.setState(
        state([
          ["ci::unit@x86_64-linux", "ok"],
          ["ci::nix@x86_64-linux", "ok"],
        ]),
      );
    }, 120);
    const v = await waitForSettle({
      client,
      failFast: false,
      timeoutMs: 5_000,
      // The verdict must come from the RUN, not from this checkout's real
      // ledger — no run context, so the record path can answer nothing.
      resolveRunContext: () => null,
    });
    expect(v).toMatchObject({
      settled: true,
      passed: true,
      timed_out: false,
      cancelled: false,
      fail_fast_tripped: false,
      sha7: "abc1234",
    });
  });

  it("does not lose a red node to the gap a dead link left", async () => {
    // The re-subscribe leads with the `nodes` cell's CURRENT snapshot, so a
    // node that went red while nothing was subscribed is red in it. The
    // alternative — resuming from deltas — would drop exactly the transition
    // the caller is waiting for.
    const s = await serve([
      ["ci::unit@x86_64-linux", "running"],
      ["ci::e2e@x86_64-linux", "running"],
    ]);
    // Published DURING the gap: at the staged death itself, so the red
    // transition provably happens while nothing is subscribed.
    const client = dyingOnce(agentWaitClient(s), 1, () => {
      s.setState(
        state([
          ["ci::unit@x86_64-linux", "ok"],
          ["ci::e2e@x86_64-linux", "failed"],
        ]),
      );
    });
    const v = await waitForSettle({
      client,
      failFast: true,
      timeoutMs: 5_000,
      resolveRunContext: () => null,
    });
    expect(v.passed).toBe(false);
    expect(v.failed).toContain("ci::e2e@x86_64-linux");
  });

  it("returns the verdict the instant a node goes red (fail-fast)", async () => {
    const s = await serve([
      ["ci::nix@x86_64-linux", "running"],
      ["ci::e2e@x86_64-linux", "running"],
    ]);
    const client = agentWaitClient(s);
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
    const client = agentWaitClient(s);
    const v = await waitForSettle({ client, failFast: false, timeoutMs: 2000 });
    expect(v).toMatchObject({ settled: true, passed: true, timed_out: false });
  });

  it("times out on a run that never settles", async () => {
    const s = await serve([["ci::nix@x86_64-linux", "running"]]);
    const client = agentWaitClient(s);
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
    const client = closeAfterFirstFrame(s, agentWaitClient(s));
    const v = await waitForSettle({
      client,
      failFast: false,
      timeoutMs: 10_000,
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
    const client = closeAfterFirstFrame(s, agentWaitClient(s));
    const v = await waitForSettle({
      client,
      failFast: false,
      timeoutMs: 10_000,
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
    const client = closeAfterFirstFrame(s, agentWaitClient(s));
    const tool = makeWaitTool(ledgerWith(record("passed")));
    // RUN the handler.s Effect — do not `await` it. A bespoke handler returns a
    // description now, and awaiting one resolves to the Effect object without
    // ever dispatching, so this assertion would have passed against a verdict
    // that was never computed. That exact shape is what kolu.s governance check
    // (and odu.s, in effectEdges.test.ts) exists to ban.
    const v = (await Effect.runPromise(
      tool.handler(
        { fail_fast: false, timeout_ms: 10_000 },
        client as never,
        undefined,
      ),
    )) as SettleVerdict;
    expect(v).toMatchObject({ settled: true, passed: true });
  });

  it("settles red from the finalized record, naming the failed node", async () => {
    const s = await serve([["ci::e2e@x86_64-linux", "running"]]);
    const client = closeAfterFirstFrame(s, agentWaitClient(s));
    const failedNodes = state([["ci::e2e@x86_64-linux", "failed"]]).nodes;
    const v = await waitForSettle({
      client,
      failFast: false,
      timeoutMs: 10_000,
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
    const client = closeAfterFirstFrame(s, agentWaitClient(s));
    const v = await waitForSettle({
      client,
      failFast: false,
      timeoutMs: 10_000,
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
    const client = closeAfterFirstFrame(s, agentWaitClient(s));
    const redNodes = state([["ci::e2e@x86_64-linux", "failed"]]).nodes;
    const v = await waitForSettle({
      client,
      failFast: false,
      timeoutMs: 10_000,
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
      const client = agentWaitClient(s);
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
    const client = closeAfterFirstFrame(s, agentWaitClient(s));
    const greenNodes = state([["ci::nix@x86_64-linux", "ok"]]).nodes;
    const v = await waitForSettle({
      client,
      failFast: false,
      timeoutMs: 10_000,
      resolveRunContext: ledgerWith(record("failed", greenNodes)),
    });
    expect(v.settled).toBe(false);
  });

  it("takes posting debt from the record it settled from, not the stale frame", async () => {
    // One authority per verdict: if the record answers pass/fail, it also
    // answers what statuses it still owed at finalize (juspay/odu#61).
    const s = await serve([["ci::nix@x86_64-linux", "running"]]);
    const client = closeAfterFirstFrame(s, agentWaitClient(s));
    const owed = {
      ...record("passed"),
      unposted: [{ context: "odu / unit", lastError: "gh: 502" }],
    };
    const v = await waitForSettle({
      client,
      failFast: false,
      timeoutMs: 10_000,
      resolveRunContext: ledgerWith(owed),
    });
    expect(v.passed).toBe(true);
    expect(v.unposted).toEqual([
      { context: "odu / unit", lastError: "gh: 502", attempts: 0 },
    ]);
  });

  it("returns cancelled when the caller aborts the wait", async () => {
    const s = await serve([["ci::nix@x86_64-linux", "running"]]);
    const client = agentWaitClient(s);
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
    return buildSurfaceFace(
      projection.surface,
      directDispatch(projection.implement(aClient)),
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
    const client = agentWaitClient(s);
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
    const client = agentWaitClient(s);
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
    // The key is OMITTED, not spelled `undefined` — `PipelineState.seq` is
    // `Schema.optionalKey` (PLAN #17) and rejects a present-but-undefined key on
    // encode, so this fixture is spelled the way the real producer must spell it
    // (`run.ts` spreads the key in only when a seq was reserved).
    const { seq: _dropped, ...noSeq } = state([["ci::unit@x86_64-linux", "ok"]]);
    const s = await serveTestSurface(noSeq);
    open.push(s);
    const client = agentWaitClient(s);
    const v = await waitForSettle({ client, failFast: false, timeoutMs: 2000 });
    expect(v).toMatchObject({ settled: true, passed: true, sha7: "abc1234" });
    expect(v.seq).toBeNull();
  });

  it("ask 2: stamps run identity onto a fail-fast verdict too", async () => {
    const s = await serve([
      ["ci::nix@x86_64-linux", "running"],
      ["ci::e2e@x86_64-linux", "running"],
    ]);
    const client = agentWaitClient(s);
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
    const client = agentWaitClient(s);
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
    const client = agentWaitClient(s);
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
          get: () =>
            Stream.fromAsyncIterable(
              (async function* () {
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
              })(),
              (e) => e,
            ) as Stream.Stream<AgentNodes, unknown>,
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
