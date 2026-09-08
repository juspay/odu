/**
 * THE CROSS-FACE GATE — the same run, through every face odu advertises.
 *
 * Black-box and out-of-process: a real nix-built binary, a real daemon that
 * outlives its launcher, a real coordinator on a localhost lane, a real
 * websocket and a real JSON-RPC endpoint. Nothing here imports `src/`.
 *
 * What it is FOR is the property the whole release rests on and that no unit
 * test can reach: a start, a wait, a log read, a retry and a cancel produce the
 * SAME addressed state whichever door they came through — and the three
 * outcomes (answered, refused, nothing serving) stay apart at each one.
 *
 * **The BROWSER is not one of the doors this file drives, and used to be.** It
 * held three cases that shelled out to `chrome --headless --dump-dom` and
 * asserted on substrings of one static snapshot — no click, no keystroke, no
 * viewport, no reconnect — and skipped themselves entirely where no browser was
 * on PATH, which on a CI runner meant they graded nothing at all. That coverage
 * now lives in `packages/web-acceptance`: Gherkin scenarios driven through
 * Playwright against this same nix-built binary, where the browser is REQUIRED
 * and its absence is a hard failure. See that package's README.
 */

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

/** A DAG whose second node fails — the shape a diagnosis is about. */
const FAILING = `[metadata("ci")]
default: alpha beta

alpha:
    echo "alpha ok"

beta: alpha
    echo "beta is about to fail"
    exit 3
`;

/** A DAG that stays running, to cancel out from under. */
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

/**
 * Start a run through the service, or fail with the reason.
 *
 * The reason MATTERS. `run_start` refusing is one assertion — `status` is 1 —
 * and on a CI runner nobody can attach to, "expected 0, received 1" is the
 * whole of what a failure says. The refusal carries a sentence naming what odu
 * declined and why, and the daemon's own log carries the rest, so both go into
 * the message.
 */
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

/** Start a run through the service and wait for it to settle. */
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
    // Concurrent launchers converge through the framework's pid gate — a
    // loser never binds the port, and yielding is a SUCCESS because the caller
    // wanted a service and there is one.
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
    // The UX this default exists for. `--background` asks "make sure one is
    // running", and there is one, so it succeeds. Bare `odu web` asks "serve
    // HERE", and here is taken — returning 0 with a URL would tell a person
    // this terminal is the server when Ctrl-C would stop nothing.
    const res = Bun.spawnSync([odu, "web"], { env: world.env });
    expect(res.exitCode).toBe(1);
    const said = res.stderr.toString();
    expect(said).toContain("already running");
    expect(said).toContain("This terminal is NOT serving it");
    // And it names both ways out rather than leaving a person stuck.
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
    // Both compatibility axes are visible — a caller can see what it is talking
    // to rather than inferring it from behaviour.
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
    // The log got its producer's last word — distinct from having been read to
    // its end.
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
    // A cursor is per CALLER and never a destructive global acknowledgement:
    // one observer draining the journal must not blind the other.
    const a = verb(world, "run_wait", { runId, deadlineMs: 1000 });
    const b = verb(world, "run_wait", { runId, deadlineMs: 1000 });
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    const first = a.json as { cursor: string; failuresTotal: number };
    const second = b.json as { cursor: string; failuresTotal: number };
    expect(second.cursor).toBe(first.cursor);
    // And the red node is STILL red for both. Consuming a cursor resolves
    // nothing.
    expect(first.failuresTotal).toBe(1);
    expect(second.failuresTotal).toBe(1);
  }, 120_000);

  it("refuses a cursor that belongs to another run, with a resync", () => {
    const refused = verb(world, "run_wait", {
      runId,
      after: "0zzzzzzzz-zzzzzzzz@2",
    });
    // A REFUSAL is exit 1 and one JSON line on stderr — not exit 0 with a
    // different answer, and not exit 3.
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
    // The caller did not choose this — odu did, because the run had finalized.
    expect(receipt.mode).toBe("relaunched");
    expect(receipt.parentRun).toBe(runId);
    expect(receipt.effectiveRun).not.toBe(runId);
    // A SELECTION is not a pipeline, and the receipt says which it got.
    expect(receipt.scope.selectors).toEqual(["beta"]);

    // Repeating the same request id replays rather than starting a second run.
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
    // The domain is taught at the handshake, which is the only place an MCP
    // host will read it.
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
    // A half-duplex transport hands the SDK a message and waits for a reply; a
    // non-object body would be reported to `onerror` and answered with nothing,
    // hanging the POST until the client gives up. Refused at the HTTP edge.
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
    // The mutation IS the attack: a cross-site page never has to read the
    // reply. This used to answer 200 and reach domain dispatch.
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

  it("refuses a Host it does not answer to — the rebinding case", async () => {
    const response = await fetch(`${world.origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "untrusted.example",
        origin: "https://untrusted.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(421);
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

    // A second start in the same checkout is an ANSWER — the run already there
    // — rather than a refusal.
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
    // A cancelled run is INCOMPLETE, never failed: reporting it as failed sends
    // somebody looking for a test that broke.
    expect(settled.outcome).toBe("incomplete");
  }, 900_000);

  it("takes a busy checkout when asked, and refuses a replacement that never starts", async () => {
    // THE FALSE-READINESS CASE, end to end against the packaged binary.
    //
    // `.ci/odu.sock` belongs to the CHECKOUT, so while a run is live there the
    // path answers immediately. A launcher that waited on the path therefore
    // reported a replacement as started before it had reached its own DAG
    // ingest — and `run.start` wrote an accepted receipt for a run that never
    // registered. Both halves are here: a replacement that dies, and one that
    // works.
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
    // The run it minted an id for does not exist, and the service says so
    // rather than handing out a receipt for it.
    if (refusal.runId !== undefined) {
      const missing = verb(world, "run_wait", { runId: refusal.runId });
      expect(missing.status).toBe(1);
      expect((missing.json as { code: string }).code).toBe("unknown_run");
    }
    // And the run that WAS there is untouched.
    expect(running(runId)).toBe("running");

    // Now a replacement that can actually start.
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
    // The one it replaced stopped, and stopped as INCOMPLETE rather than
    // failed: nothing about it broke.
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

  it("discovers a native run started with `odu run`, from the catalog alone", async () => {
    // No filesystem scan and nothing told the service: `odu run` registers in
    // the per-user catalog, and the board is a projection of that.
    const dir = fixture(FAILING);
    Bun.spawnSync([odu, "run", "--no-post"], { cwd: dir, env: world.env });
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
  it("serves NOTHING on a websocket claiming somebody else's Host", async () => {
    // The rebinding shape, on the real listener: a page from `untrusted.example`
    // whose DNS points at loopback sends an Origin and a Host that MATCH — so
    // the framework's same-origin gate says yes, and the connection used to be
    // served. It reaches the same surface `/mcp` does.
    //
    // The upgrade belongs to `serveSurfaceApp` and takes no hook, so the
    // handshake completes; what must not happen is a serving stack behind it.
    // The daemon says so on its own log, which is what this reads.
    const port = new URL(world.origin).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc/ws`, {
      headers: {
        host: `untrusted.example:${port}`,
        origin: `http://untrusted.example:${port}`,
      },
    } as unknown as string[]);
    const messages: unknown[] = [];
    socket.addEventListener("message", (event) => messages.push(event.data));
    await until(
      "the service to refuse the hostile websocket",
      () => (daemonLog(world).includes("refused a websocket") ? true : null),
      30_000,
    );
    // And it answered nothing at all on the way.
    expect(messages).toEqual([]);
    socket.close();
  }, 60_000);
});

/**
 * THE FOREGROUND — bare `odu web`, which is what a person types.
 *
 * Two promises, and neither is checkable from the inside: the server lives as
 * long as the terminal does, and a run it started does NOT. Ctrl-C reaches this
 * process's group; a coordinator is a detached group of its own, so the signal
 * never arrives there.
 */
describe("`odu web` serves in this terminal", () => {
  it("serves until it is interrupted, and leaves the run it started going", async () => {
    // A THIRD origin, which is also what gives this server its own gate: the
    // daemon home is named for the origin (`daemonHome`'s "state" placement
    // ignores XDG_STATE_HOME on purpose), so moving the port moves the gate.
    const origin = `http://127.0.0.1:${suitePort() + 2}`;
    const env = { ...world.env, ODU_WEB_ORIGIN: origin };
    const server = Bun.spawn([odu, "web"], { env, stdout: "pipe", stderr: "pipe" });
    const at = { ...world, origin, env } as WebWorld;
    let home: string | undefined;
    try {
      // It STAYS UP. A command that printed a URL and exited is the thing this
      // default replaced, so the first assertion is that it is still there.
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

      // A run started through it, which must outlive it.
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

      // Ctrl-C.
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

      // The RUN is not. Its coordinator is a process group of its own, so the
      // interrupt never reached it — and its evidence is in the catalog, which
      // this suite can still read with a different service.
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

/**
 * THE BOOTSTRAP — `odu web --background`, which is what an agent runs.
 *
 * Everything above drives a daemon this suite forked itself, which means it
 * never used the one path a person does: the launch-mode decision, the
 * environment the child is handed, and the readiness handshake the command
 * prints a URL on the strength of. All three were wrong at once, and no test
 * noticed, because none of them was ever executed.
 */
describe("`odu web --background` starts a service that can run CI", () => {
  let booted: WebWorld | null = null;

  afterAll(() => booted?.dispose());

  it("spawns a daemon that outlives the command, and runs a real pipeline", async () => {
    booted = await startWebServiceViaCommand(odu);
    // The daemon is nobody's child — the command returned and this process
    // never forked it — and it is nonetheless serving.
    const cell = surfaceCall(booted, ["get", "service"]);
    expect(cell.status).toBe(0);

    // And the environment it was handed is enough to START A RUN, which is the
    // part an allowlist gets wrong quietly: a daemon missing PATH or the nix
    // variables looks perfectly healthy until the first coordinator.
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

/**
 * A REPLAY RESOLVES THE CALLER'S INVENTORY, NOT THE DAEMON'S.
 *
 * The service is a per-user singleton, so `$ODU_HOSTS` at the moment a run
 * started is a fact about somebody's shell and has nothing to do with the shell
 * the daemon was started in. A run records the caller's; a replay is checked
 * against the recorded one and the child is handed the recorded one.
 *
 * Three readings, and the middle one is what this gate is about: a PATH names a
 * file, `""` says the caller's shell named none (so resolution starts at
 * `~/.config`), and ABSENT says nobody said, which is the only reading under
 * which the daemon's own environment answers. `""` was being translated into
 * absent on the way into the pre-check — so validation consulted the service's
 * fleet while execution got the caller's, and the two disagreed about their
 * inputs.
 *
 * Stated here by giving the DAEMON an `$ODU_HOSTS` it cannot even read. Nothing
 * in a correct replay ever opens that file; a replay that consulted it refuses
 * with `no_venue` naming a parse error, which is a sentence about a fleet
 * nobody in this run ever named. Packaged, because the divergence only exists
 * where the client and the service are separate processes.
 */
describe("a replay resolves the caller's inventory", () => {
  /** One node, so the run settles in seconds; the placement is what is on
   *  trial, not the DAG. */
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
    // `hostsFile: ""` is the caller SAYING its shell had none — the reading the
    // wire carries and the manifest records. The pin is what makes the run
    // hermetic without one: `--host P=ADDR` upserts a pool on top of whatever
    // the chain resolved, so this does not depend on the machine having a
    // `~/.config/odu/hosts.json` (or on what is in one).
    const { runId } = startOrExplain(alien, {
      checkout: dir,
      expectedSha: headOf(dir),
      requestId: "alien-start",
      noPost: true,
      hostsFile: "",
      // The pin AND the slice. `""` means resolution starts at `~/.config`, so
      // on a developer's machine the chain resolves a real fleet — and an
      // unsliced run would then fan out onto whatever platforms that file
      // configures, which is somebody's build farm rather than this test's
      // subject. One platform, pinned to localhost, on every machine.
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

    // THE ASSERTION. A finalized run, so this is the replay path: the recorded
    // `""` is checked against the caller's chain and handed to the child. A
    // replay that read the daemon's `$ODU_HOSTS` instead would refuse here,
    // and its refusal would quote a JSON parse error from a file this run
    // never had anything to do with.
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
