import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildOduBinary, cleanup, currentNixSystem, scratchDir } from "./harness";
import {
  daemonLog,
  headOf,
  makeWebFixture,
  mcp,
  runSocketExists,
  SHARED_TOOLS,
  suitePort,
  suitePortFor,
  startWebService,
  startWebServiceViaCommand,
  surfaceCall,
  tcpListening,
  until,
  verb,
  type WebWorld,
} from "./webHarness";

const FAILING = `[metadata("ci")]
default: alpha beta

alpha:
    echo "alpha ok"

beta: alpha
    echo "beta is about to fail"
    exit 3
`;

const SLOW = `[metadata("ci")]
default: alpha slow

alpha:
    echo "alpha ok"

slow: alpha
    echo "slow start"
    sleep 300
`;

let odu: string;
let world: WebWorld;
const fixtures: string[] = [];

beforeAll(async () => {
  odu = buildOduBinary();
  world = await startWebService(odu);
}, 900_000);

afterAll(() => {
  world?.dispose();
  for (const dir of fixtures) cleanup(dir);
});

function fixture(justfile: string): string {
  const dir = makeWebFixture(justfile);
  fixtures.push(dir);
  return dir;
}

function startOrExplain(
  at: WebWorld,
  input: Record<string, unknown>,
): { runId: string } {
  const start = verb(at, "run_start", input);
  if (start.status !== 0) {
    throw new Error(
      `e2e: run_start refused (exit ${start.status})\n` +
        `${start.stderr}\n--- daemon log ---\n${daemonLog(at)}`,
    );
  }
  return start.json as { runId: string };
}

async function runToSettle(
  dir: string,
  requestId: string,
): Promise<{ runId: string; answer: Record<string, unknown> }> {
  const { runId } = startOrExplain(world, {
    checkout: dir,
    expectedSha: headOf(dir),
    requestId,
    noPost: true,
  });
  const answer = await until(
    `run ${runId} to settle`,
    () => {
      const waited = verb(world, "run_wait", { runId, deadlineMs: 20_000 });
      if (waited.status !== 0) return null;
      const value = waited.json as { settled: boolean };
      return value.settled ? (waited.json as Record<string, unknown>) : null;
    },
    300_000,
    0,
  );
  return { runId, answer };
}

describe("the web service", () => {
  it("is one singleton: a second launcher yields rather than binding", () => {
    const second = Bun.spawnSync([odu, "web-daemon"], { env: world.env });
    expect(second.exitCode).toBe(0);
    expect(second.stderr.toString()).toContain("already running");
  }, 120_000);

  it("`odu web --background` adopts the running one and prints its URL", () => {
    const res = Bun.spawnSync([odu, "web", "--background"], { env: world.env });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString().trim()).toBe(world.origin);
    expect(res.stderr.toString()).toContain("reused the service already running");
  }, 120_000);

  it("bare `odu web` REFUSES to pretend it is serving one that already is", () => {
    const res = Bun.spawnSync([odu, "web"], { env: world.env });
    expect(res.exitCode).toBe(1);
    const said = res.stderr.toString();
    expect(said).toContain("already running");
    expect(said).toContain("This terminal is NOT serving it");
    expect(said).toContain("odu web --upgrade");
    expect(said).toContain("odu web --background");
  }, 120_000);

  it("reports its own identity, build and readiness", () => {
    const res = surfaceCall(world, ["get", "service"]);
    expect(res.status).toBe(0);
    const cell = JSON.parse(res.stdout) as {
      identity: { origin: string; protocolVersion: string; storageVersion: number };
      readiness: { state: string };
      build: { oduVersion: string };
    };
    expect(cell.identity.origin).toBe(world.origin);
    expect(cell.readiness.state).toBe("ready");
    expect(cell.identity.protocolVersion).toMatch(/^\d+\.\d+$/);
    expect(cell.identity.storageVersion).toBeGreaterThan(0);
    expect(cell.build.oduVersion).not.toBe("");
  }, 60_000);
});

describe("start → wait → logs → retry, through the CLI face", () => {
  let dir: string;
  let runId: string;
  let failure: { node: string; logKey: string; exitCode: number; excerpt: string };

  beforeAll(async () => {
    dir = fixture(FAILING);
    const settled = await runToSettle(dir, "gate-start");
    runId = settled.runId;
    const answer = settled.answer as unknown as {
      failures: { node: string; logKey: string; exitCode: number; excerpt: string }[];
      passed: boolean;
    };
    expect(answer.passed).toBe(false);
    expect(answer.failures).toHaveLength(1);
    failure = answer.failures[0] as typeof failure;
  }, 600_000);

  it("reports the failing node with its exit code and an excerpt", () => {
    expect(failure.node).toContain("beta@");
    expect(failure.exitCode).toBe(3);
    expect(failure.excerpt).toContain("beta is about to fail");
  }, 120_000);

  it("addresses the log so a caller echoes rather than reassembles", () => {
    const page = verb(world, "log_read", { key: failure.logKey });
    expect(page.status).toBe(0);
    const value = page.json as { text: string; eof: boolean; complete: boolean };
    expect(value.text).toContain("beta is about to fail");
    expect(value.eof).toBe(true);
    expect(value.complete).toBe(true);
  }, 120_000);

  it("pages a log by byte offset and reports where to continue", () => {
    const first = verb(world, "log_read", { key: failure.logKey, limit: 8 });
    expect(first.status).toBe(0);
    const head = first.json as { text: string; nextOffset: number; eof: boolean };
    expect(head.text).toHaveLength(8);
    expect(head.eof).toBe(false);
    const second = verb(world, "log_read", {
      key: failure.logKey,
      offset: head.nextOffset,
    });
    expect((second.json as { eof: boolean }).eof).toBe(true);
  }, 120_000);

  it("gives two observers independent cursors", () => {
    const a = verb(world, "run_wait", { runId, deadlineMs: 1000 });
    const b = verb(world, "run_wait", { runId, deadlineMs: 1000 });
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    const first = a.json as { cursor: string; failuresTotal: number };
    const second = b.json as { cursor: string; failuresTotal: number };
    // A cursor is per CALLER and never a destructive global acknowledgement:
    // one observer draining the journal must not blind the other.
    expect(second.cursor).toBe(first.cursor);
    expect(first.failuresTotal).toBe(1);
    expect(second.failuresTotal).toBe(1);
  }, 120_000);

  it("refuses a cursor that belongs to another run, with a resync", () => {
    const refused = verb(world, "run_wait", {
      runId,
      after: "0zzzzzzzz-zzzzzzzz@2",
    });
    expect(refused.status).toBe(1);
    const value = refused.json as { code: string; resync?: string };
    expect(value.code).toBe("bad_cursor");
    expect(value.resync).toContain(runId);
  }, 120_000);

  it("performs one execution per request id", async () => {
    const repeat = verb(world, "run_start", {
      checkout: dir,
      expectedSha: headOf(dir),
      requestId: "gate-start",
      noPost: true,
    });
    expect(repeat.status).toBe(0);
    const value = repeat.json as { runId: string; replayed: boolean };
    expect(value.runId).toBe(runId);
    expect(value.replayed).toBe(true);
  }, 120_000);

  it("retries a finalized run as a LINKED REPLAY, and says so", async () => {
    const retried = verb(world, "run_retry", {
      runId,
      selector: "beta",
      requestId: "gate-retry",
    });
    expect(retried.status).toBe(0);
    const receipt = retried.json as {
      mode: string;
      effectiveRun: string;
      parentRun: string;
      scope: { selectors: string[] };
    };
    expect(receipt.mode).toBe("relaunched");
    expect(receipt.parentRun).toBe(runId);
    expect(receipt.effectiveRun).not.toBe(runId);
    expect(receipt.scope.selectors).toEqual(["beta"]);

    const again = verb(world, "run_retry", {
      runId,
      selector: "beta",
      requestId: "gate-retry",
    });
    expect(again.status).toBe(0);
    const replayed = again.json as { effectiveRun: string; replayed: boolean };
    expect(replayed.effectiveRun).toBe(receipt.effectiveRun);
    expect(replayed.replayed).toBe(true);
  }, 600_000);

  it("shows the parent and the replay on one board", () => {
    const keys = surfaceCall(world, ["keys", "runs"]);
    expect(keys.status).toBe(0);
    const ids = JSON.parse(keys.stdout) as string[];
    expect(ids).toContain(runId);
    expect(ids.length).toBeGreaterThan(1);
  }, 120_000);
});

describe("the outcomes stay apart", () => {
  it("answers a red run with EXIT 0, because CI failing is not the tool failing", async () => {
    const dir = fixture(FAILING);
    const { runId } = await runToSettle(dir, "gate-exit-0");
    const waited = verb(world, "run_wait", { runId, deadlineMs: 5000 });
    expect(waited.status).toBe(0);
    expect((waited.json as { passed: boolean }).passed).toBe(false);
  }, 600_000);

  it("refuses a checkout that is not a repository — exit 1", () => {
    const refused = verb(world, "run_start", {
      checkout: "/definitely/not/a/repo",
      expectedSha: "0".repeat(40),
      requestId: "gate-bad-checkout",
    });
    expect(refused.status).toBe(1);
    expect((refused.json as { code: string }).code).toBe("checkout_refused");
  }, 60_000);

  it("refuses a run it has never heard of — exit 1, and not exit 3", () => {
    const refused = verb(world, "run_wait", { runId: "0aaaaaaaa-aaaaaaaa" });
    expect(refused.status).toBe(1);
    expect((refused.json as { code: string }).code).toBe("unknown_run");
  }, 60_000);

  it("answers a missing field as a usage error that never left the process — exit 2", () => {
    const res = surfaceCall(world, ["run_wait", "--json"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("runId");
  }, 60_000);

  it("answers a dead endpoint as unreachable — exit 3", () => {
    const res = Bun.spawnSync([odu, "surface", "keys", "runs"], {
      env: { ...world.env, ODU_WEB_ORIGIN: "http://127.0.0.1:1" },
    });
    expect(res.exitCode).toBe(3);
    expect(res.stderr.toString()).toContain("no surface at");
  }, 120_000);
});

describe("the HTTP MCP face", () => {
  it("completes an initialize handshake", async () => {
    const answer = await mcp(world, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "odu-e2e", version: "0" },
    });
    const result = answer.result as { serverInfo: { name: string }; instructions: string };
    expect(result.serverInfo.name).toBe("odu");
    expect(result.instructions).toContain("run_start");
  }, 60_000);

  it("advertises exactly the shared verbs, under the same names", async () => {
    const answer = await mcp(world, "tools/list", undefined, 2);
    const tools = (answer.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    // Against `SHARED_TOOLS`, not a list written out here. This assertion held
    // a copy of five verb names and went stale the moment the contract grew to
    // thirteen — which made a test whose whole subject is "every face offers
    // the same vocabulary" the one place a second vocabulary was written down.
    expect(tools.sort()).toEqual([...SHARED_TOOLS]);
  }, 60_000);

  it("advertises the readable members as resources", async () => {
    const answer = await mcp(world, "resources/list", undefined, 3);
    const uris = (answer.result as { resources: { uri: string }[] }).resources.map(
      (r) => r.uri,
    );
    expect(uris).toContain("surface://cells/service");
    expect(uris).toContain("surface://collections/runs");
  }, 60_000);

  it("answers a red run as a NORMAL tool result, not a tool error", async () => {
    const dir = fixture(FAILING);
    const { runId } = await runToSettle(dir, "gate-mcp");
    const answer = await mcp(
      world,
      "tools/call",
      { name: "run_wait", arguments: { runId, deadlineMs: 5000 } },
      4,
    );
    const result = answer.result as {
      isError?: boolean;
      structuredContent: { passed: boolean; failures: unknown[] };
    };
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent.passed).toBe(false);
    expect(result.structuredContent.failures).toHaveLength(1);
  }, 600_000);

  it("answers a REFUSAL as a tool error", async () => {
    const answer = await mcp(
      world,
      "tools/call",
      { name: "run_wait", arguments: { runId: "0aaaaaaaa-aaaaaaaa" } },
      5,
    );
    expect((answer.result as { isError?: boolean }).isError).toBe(true);
  }, 60_000);

  it("refuses a body that is not a JSON-RPC message rather than hanging", async () => {
    const response = await fetch(`${world.origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    });
    expect(response.status).toBe(400);
  }, 60_000);

  it("says plainly that it pushes nothing, rather than opening a silent stream", async () => {
    const response = await fetch(`${world.origin}/mcp`);
    expect(response.status).toBe(405);
  }, 60_000);

  it("refuses a POST from a page the operator merely visited", async () => {
    const response = await fetch(`${world.origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://untrusted.example",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "run_cancel", arguments: { runId: "x", scope: { kind: "run" } } },
      }),
    });
    expect(response.status).toBe(403);
  }, 60_000);

  it("refuses a form-shaped POST, which is the one a browser sends with no Origin rules", async () => {
    const response = await fetch(`${world.origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(415);
  }, 60_000);

  it("answers under a forwarded name with no configuration", async () => {
    const port = new URL(world.origin).port;
    const response = await fetch(`${world.origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: `forwarded.example:${port}`,
        origin: `http://forwarded.example:${port}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
  }, 60_000);

  it("hands a client a session id at the handshake, so it can cancel its own calls", async () => {
    const response = await fetch(`${world.origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "odu-e2e", version: "0" },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).not.toBeNull();
  }, 60_000);

  it("reads a resource", async () => {
    const answer = await mcp(
      world,
      "resources/read",
      { uri: "surface://cells/service" },
      6,
    );
    const contents = (answer.result as { contents: { text: string }[] }).contents;
    const cell = JSON.parse(contents[0]?.text ?? "{}") as {
      readiness: { state: string };
    };
    expect(cell.readiness.state).toBe("ready");
  }, 60_000);
});

describe("cancelling, and outliving the caller", () => {
  it("cancels a live run at an explicit scope, idempotently", async () => {
    const dir = fixture(SLOW);
    const { runId } = startOrExplain(world, {
      checkout: dir,
      expectedSha: headOf(dir),
      requestId: "gate-cancel",
      noPost: true,
    });

    await until(
      `run ${runId} to be running`,
      () => {
        const row = surfaceCall(world, ["get", "runs", runId]);
        if (row.status !== 0) return null;
        const value = JSON.parse(row.stdout) as { state: string };
        return value.state === "running" ? value : null;
      },
      300_000,
    );

    const busy = verb(world, "run_start", {
      checkout: dir,
      expectedSha: headOf(dir),
      requestId: "gate-busy",
      noPost: true,
    });
    expect(busy.status).toBe(0);
    const conflict = busy.json as { accepted: boolean; runId: string };
    expect(conflict.accepted).toBe(false);
    expect(conflict.runId).toBe(runId);

    const cancelled = verb(world, "run_cancel", {
      runId,
      scope: { kind: "run" },
      requestId: "gate-cancel-1",
    });
    expect(cancelled.status).toBe(0);
    expect((cancelled.json as { effective: string }).effective).toBe("run");

    const again = verb(world, "run_cancel", {
      runId,
      scope: { kind: "run" },
      requestId: "gate-cancel-1",
    });
    expect(again.status).toBe(0);
    expect((again.json as { replayed: boolean }).replayed).toBe(true);

    const settled = await until(
      `run ${runId} to stop`,
      () => {
        const waited = verb(world, "run_wait", { runId, deadlineMs: 10_000 });
        if (waited.status !== 0) return null;
        const value = waited.json as { settled: boolean; outcome: string };
        return value.settled ? value : null;
      },
      300_000,
      0,
    );
    expect(settled.outcome).toBe("incomplete");
  }, 900_000);

  it("takes a busy checkout when asked, and refuses a replacement that never starts", async () => {
    const dir = fixture(SLOW);
    const { runId } = startOrExplain(world, {
      checkout: dir,
      expectedSha: headOf(dir),
      requestId: "sup-live",
      noPost: true,
    });
    const running = (id: string): string | null => {
      const row = surfaceCall(world, ["get", "runs", id]);
      if (row.status !== 0) return null;
      return (JSON.parse(row.stdout) as { state: string }).state;
    };
    await until(
      `run ${runId} to be running`,
      () => (running(runId) === "running" ? true : null),
      300_000,
    );

    // THE FALSE-READINESS CASE, end to end against the packaged binary.
    //
    // `.ci/odu.sock` belongs to the CHECKOUT, so while a run is live there the
    // path answers immediately. A launcher that waited on the path therefore
    // reported a replacement as started before it had reached its own DAG
    // ingest — and `run.start` wrote an accepted receipt for a run that never
    // registered. Both halves are here: a replacement that dies, and one that
    // works.

    // A justfile odu cannot read. The coordinator dies at ingest, which is
    // BEFORE it would claim the checkout — so nothing is superseded and nothing
    // registers, while the incumbent's socket goes on answering.
    writeFileSync(join(dir, "justfile"), "not : a : justfile {{{\n");
    const broken = verb(world, "run_start", {
      checkout: dir,
      expectedSha: headOf(dir),
      requestId: "sup-broken",
      supersede: true,
      noStrict: true,
      noSnapshot: true,
      noPost: true,
    });
    expect(broken.status).toBe(1);
    const refusal = broken.json as { code: string; runId?: string };
    expect(refusal.code).toBe("launch_failed");
    if (refusal.runId !== undefined) {
      const missing = verb(world, "run_wait", { runId: refusal.runId });
      expect(missing.status).toBe(1);
      expect((missing.json as { code: string }).code).toBe("unknown_run");
    }
    expect(running(runId)).toBe("running");

    writeFileSync(join(dir, "justfile"), SLOW);
    const taken = verb(world, "run_start", {
      checkout: dir,
      expectedSha: headOf(dir),
      requestId: "sup-take",
      supersede: true,
      noStrict: true,
      noSnapshot: true,
      noPost: true,
    });
    expect(taken.status).toBe(0);
    const replacement = taken.json as { runId: string; accepted: boolean };
    expect(replacement.accepted).toBe(true);
    expect(replacement.runId).not.toBe(runId);
    const settled = await until(
      `run ${runId} to be superseded`,
      () => {
        const waited = verb(world, "run_wait", { runId, deadlineMs: 10_000 });
        if (waited.status !== 0) return null;
        const value = waited.json as { settled: boolean; outcome: string };
        return value.settled ? value : null;
      },
      300_000,
      0,
    );
    expect(settled.outcome).toBe("incomplete");

    verb(world, "run_cancel", {
      runId: replacement.runId,
      scope: { kind: "run" },
      requestId: "sup-cleanup",
    });
  }, 900_000);

  it("discovers a native run started with `odu ci run`, from the catalog alone", async () => {
    const dir = fixture(FAILING);
    Bun.spawnSync([odu, "ci", "run", "--no-post"], { cwd: dir, env: world.env });
    const found = await until(
      "the native run to appear on the board",
      () => {
        const keys = surfaceCall(world, ["keys", "runs"]);
        if (keys.status !== 0) return null;
        const ids = JSON.parse(keys.stdout) as string[];
        for (const id of ids) {
          const row = surfaceCall(world, ["get", "runs", id]);
          if (row.status !== 0) continue;
          const value = JSON.parse(row.stdout) as { repoRoot: string };
          if (value.repoRoot === dir) return value;
        }
        return null;
      },
      300_000,
    );
    expect(found.repoRoot).toBe(dir);
  }, 900_000);
});

describe("the websocket door", () => {
  it("serves a websocket reached under a forwarded name", async () => {
    const port = new URL(world.origin).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc/ws`, {
      headers: {
        host: `forwarded.example:${port}`,
        origin: `http://forwarded.example:${port}`,
      },
    } as unknown as string[]);
    const messages: string[] = [];
    socket.addEventListener("message", (event) =>
      messages.push(String(event.data)),
    );
    socket.addEventListener("open", () => socket.send('{"_tag":"Ping"}\n'));
    try {
      await until(
        "the forwarded websocket to answer a ping",
        () => (messages.some((m) => m.includes('"Pong"')) ? true : null),
        30_000,
      );
    } finally {
      socket.close();
    }
  }, 60_000);
});

describe("`odu web` serves in this terminal", () => {
  it("serves until it is interrupted, and leaves the run it started going", async () => {
    const origin = `http://127.0.0.1:${suitePort() + 2}`;
    const env = { ...world.env, ODU_WEB_ORIGIN: origin };
    const server = Bun.spawn([odu, "web"], { env, stdout: "pipe", stderr: "pipe" });
    const at = { ...world, origin, env } as WebWorld;
    let home: string | undefined;
    try {
      home = await until(
        "the foreground server to answer",
        () => {
          const cell = surfaceCall(at, ["get", "service"]);
          if (cell.status !== 0) return null;
          const value = JSON.parse(cell.stdout) as {
            identity: { home: string };
            readiness: { state: string };
          };
          return value.readiness.state === "ready" ? value.identity.home : null;
        },
        120_000,
      );
      expect(server.killed).toBe(false);

      const dir = fixture(SLOW);
      const { runId } = startOrExplain(at, {
        checkout: dir,
        expectedSha: headOf(dir),
        requestId: "fg-run",
        noPost: true,
      });
      await until(
        `run ${runId} to be running`,
        () => {
          const row = surfaceCall(at, ["get", "runs", runId]);
          if (row.status !== 0) return null;
          return (JSON.parse(row.stdout) as { state: string }).state === "running"
            ? true
            : null;
        },
        300_000,
      );

      server.kill("SIGINT");
      await server.exited;
      // The SERVER is gone: nothing answers its address any more.
      //
      // **Probed over TCP, never through `odu surface`.** Every service client
      // bootstraps now, so asking odu whether a service is running STARTS one —
      // and a poll written that way waits for a daemon to go away while
      // spawning its replacement on each tick, forever. That is not a flaw in
      // the bootstrap; it is what "no face reports nothing-serving without
      // trying to fix it" means. A test that wants to observe ABSENCE has to
      // observe it from outside odu.
      await until(
        "the foreground server to stop serving",
        async () => ((await tcpListening(at.origin)) ? null : true),
        60_000,
      );

      const stillThere = surfaceCall(world, ["get", "runs", runId]);
      expect(stillThere.status).toBe(0);
      expect(runSocketExists(dir)).toBe(true);

      verb(world, "run_cancel", {
        runId,
        scope: { kind: "run" },
        requestId: "fg-cleanup",
      });
    } finally {
      server.kill("SIGKILL");
      if (home !== undefined) rmSync(home, { recursive: true, force: true });
    }
  }, 900_000);
});

describe("`odu web --background` starts a service that can run CI", () => {
  let booted: WebWorld | null = null;

  afterAll(() => booted?.dispose());

  it("spawns a daemon that outlives the command, and runs a real pipeline", async () => {
    booted = await startWebServiceViaCommand(odu);
    const cell = surfaceCall(booted, ["get", "service"]);
    expect(cell.status).toBe(0);

    const dir = fixture(FAILING);
    const { runId } = startOrExplain(booted, {
      checkout: dir,
      expectedSha: headOf(dir),
      requestId: "boot-1",
      noPost: true,
    });
    const settled = await until(
      `run ${runId} to settle`,
      () => {
        const waited = verb(booted as WebWorld, "run_wait", {
          runId,
          deadlineMs: 20_000,
        });
        if (waited.status !== 0) return null;
        const value = waited.json as { settled: boolean; passed: boolean };
        return value.settled ? value : null;
      },
      300_000,
      0,
    );
    expect(settled.passed).toBe(false);
  }, 900_000);
});

describe("a replay resolves the caller's inventory", () => {
  const SOLO = `[metadata("ci")]
default: solo

solo:
    echo "solo ok"
`;
  let alien: WebWorld | null = null;

  afterAll(() => alien?.dispose());

  it("replays a caller who had no hosts file, against a daemon whose own is unreadable", async () => {
    const brokenDir = scratchDir("odu-e2e-daemon-hosts-");
    const broken = join(brokenDir, "hosts.json");
    writeFileSync(broken, "{ this is not JSON");
    alien = await startWebServiceViaCommand(
      odu,
      suitePortFor("callerInventory"),
      { ODU_HOSTS: broken },
    );

    const dir = fixture(SOLO);
    const { runId } = startOrExplain(alien, {
      checkout: dir,
      expectedSha: headOf(dir),
      requestId: "alien-start",
      noPost: true,
      hostsFile: "",
      platforms: [currentNixSystem()],
      hostPins: [`${currentNixSystem()}=localhost`],
    });
    const settled = await until(
      `run ${runId} to settle`,
      () => {
        const waited = verb(alien as WebWorld, "run_wait", {
          runId,
          deadlineMs: 20_000,
        });
        if (waited.status !== 0) return null;
        const value = waited.json as { settled: boolean; passed: boolean };
        return value.settled ? value : null;
      },
      300_000,
      0,
    );
    expect(settled.passed).toBe(true);

    const retried = verb(alien, "run_retry", {
      runId,
      selector: "solo",
      requestId: "alien-retry",
    });
    expect(retried.stderr).not.toContain("no_venue");
    expect(retried.status).toBe(0);
    const receipt = retried.json as { mode: string; parentRun: string };
    expect(receipt.mode).toBe("relaunched");
    expect(receipt.parentRun).toBe(runId);
  }, 900_000);
});
