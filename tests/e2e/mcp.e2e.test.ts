/**
 * End-to-end over `odu mcp` — the ONE agent face, and the only one.
 *
 * This file used to drive the per-checkout MCP server: nine tools of its own, a
 * dial of `.ci/odu.sock`, and run authority that no other face could see. That
 * server is deleted, and what replaced it is a BRIDGE — bare `odu mcp` dials the
 * singleton web service and projects the same verbs the browser and
 * `odu surface` project, under the same names.
 *
 * Four properties are worth an e2e rather than a unit test, and every one of
 * them is about the seam between processes rather than about a tool:
 *
 *   - **A cold host gets a working face.** An MCP host launches this bridge on a
 *     machine where nothing has ever run odu. That is the ORDINARY first
 *     contact, not an edge case, and it is the one the old face never had to
 *     handle because it carried its own authority. Here the bridge must start
 *     the service itself, verify it is ready, and answer — and it must do so
 *     through the REAL launcher an MCP config points at, not through a
 *     convenient in-process shortcut.
 *   - **Two cold faces converge on ONE daemon.** A person's terminal and an
 *     agent's bridge reaching an empty machine at the same instant is the
 *     ordinary morning, and two services would be two truths about one run.
 *   - **An occupied port is a REFUSAL, said quickly.** Not a timeout: an agent
 *     that is told `Request timed out` after a minute has learned nothing it
 *     can act on, and the thing it needed to hear was one sentence long.
 *   - **The vocabulary is exactly the shared one.** Not "contains the verbs" —
 *     EXACTLY them. An extra tool here would be the second face growing back,
 *     and it would grow back invisibly: nothing else in the suite would notice a
 *     face that could do one more thing than the browser can.
 *
 * Black-box like the rest of `tests/e2e`: no import from `src/`, the packaged
 * Nix binary only.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  buildOduBinary,
  cleanup,
  hermeticEnv,
  scratchDir,
} from "./harness";
import {
  headOf,
  killDaemon,
  makeWebFixture,
  SHARED_TOOLS,
  startWebServiceViaCommand,
  suitePortFor,
  tcpListening,
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

let oduBin: string;

beforeAll(() => {
  oduBin = buildOduBinary();
}, 600_000);

/** Connect a real MCP client to `odu mcp`, in a world of its own. `env` decides
 *  which service the bridge reaches — and, when nothing is serving there, which
 *  one it starts. */
async function connectBridge(env: NodeJS.ProcessEnv): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const transport = new StdioClientTransport({
    command: oduBin,
    args: ["mcp"],
    env: env as Record<string, string>,
  });
  const client = new Client({ name: "odu-e2e", version: "0.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

/** A tool call's text payload, or a failure that says what the tool actually
 *  answered. `isError` alone is "expected false, received true" on a CI runner
 *  nobody can attach to; the refusal underneath it carries the sentence. */
function payload(result: Record<string, unknown>, what: string): string {
  const text = String(
    (result.content as { text?: string }[] | undefined)?.[0]?.text ?? "",
  );
  if (result.isError === true) {
    throw new Error(`e2e: ${what} was refused — ${text}`);
  }
  return text;
}

/** The service cell, decoded. A resource's content is a union of text and blob
 *  arms, so the text arm is NAMED rather than assumed: a blob here would be a
 *  transport change this suite should notice, not silently `String()` into
 *  "[object Object]" and fail three lines later on a missing field. */
async function readServiceCell(client: Client): Promise<ServiceCellish> {
  const read = await client.readResource({ uri: "surface://cells/service" });
  const first = read.contents[0];
  if (first === undefined || !("text" in first)) {
    throw new Error(
      `e2e: the service cell came back as ${JSON.stringify(first)} — expected a text resource`,
    );
  }
  return JSON.parse(first.text) as ServiceCellish;
}

/** As much of the service cell as this file reads. Mirrors — and is NOT
 *  imported from — `ServiceCellSchema`: black-box, so a shape imported from the
 *  code under test would agree with a mistake. */
interface ServiceCellish {
  identity: { origin: string; pid: number; home: string };
  readiness: { state: string };
}

/** The three facts a race compares, from either face. */
interface ServiceFacts {
  origin: string;
  pid: number;
  home: string;
  state: string;
}

function factsOf(cell: ServiceCellish): ServiceFacts {
  return {
    origin: cell.identity.origin,
    pid: cell.identity.pid,
    home: cell.identity.home,
    state: cell.readiness.state,
  };
}

describe("odu mcp — the shared-service bridge", () => {
  let world: WebWorld;

  beforeAll(async () => {
    world = await startWebServiceViaCommand(oduBin);
  }, 300_000);

  afterAll(() => world?.dispose());

  it("exposes EXACTLY the shared verbs — no face-local tool", async () => {
    const { client, close } = await connectBridge(world.env);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      // Equality, not containment. A face that could do one more thing than the
      // browser can is the second vocabulary growing back, and containment would
      // not see it. The list GREW — from five to thirteen — and equality is
      // exactly what made that growth a reviewed change rather than a drift:
      // every one of the eight new verbs had to be added here, in the shared
      // list, at the same time as it reached the contract.
      expect(names).toEqual([...SHARED_TOOLS]);
      // And none of the deleted per-checkout tools, named explicitly so a
      // reintroduction fails here with the name rather than as a count.
      for (const gone of [
        "run",
        "node_rerun",
        "wait_for_settle",
        "cancel",
        "runs",
        "node_cancel",
        "lane_cancel",
        "lease",
        "release",
      ]) {
        expect(names).not.toContain(gone);
      }
    } finally {
      await close();
    }
  }, 120_000);

  it("publishes the board and the service cell as resources, and not the DAG", async () => {
    const { client, close } = await connectBridge(world.env);
    try {
      const listed = await client.listResources();
      const uris = listed.resources.map((r) => r.uri);
      expect(uris).toContain("surface://cells/service");
      expect(uris).toContain("surface://collections/runs");
      // `nodes` is deliberately absent: it is a stream whose input is a run id,
      // and a stream that requires an input cannot be a static resource. An
      // agent reads a run's shape from `run_wait`'s answer instead.
      expect(uris.some((u) => u.includes("nodes"))).toBe(false);
    } finally {
      await close();
    }
  }, 120_000);

  it("names the same service the terminal face is talking to", async () => {
    // The whole claim of the consolidation, checked across two processes: the
    // bridge and `odu surface` must be looking at ONE daemon.
    const { client, close } = await connectBridge(world.env);
    try {
      const cell = await readServiceCell(client);
      expect(cell.identity.origin).toBe(world.origin);
    } finally {
      await close();
    }
  }, 120_000);

  it("drives a real run: start, wait, and a red node's addressed evidence", async () => {
    const dir = makeWebFixture(FAILING);
    try {
      const { client, close } = await connectBridge(world.env);
      try {
        const started = await client.callTool({
          name: "run_start",
          arguments: {
            checkout: dir,
            expectedSha: headOf(dir),
            requestId: "e2e-bridge-1",
            // The fixture has no GitHub origin, and strict mode is right to
            // refuse a run it could not report. `noPost` is strict WITHOUT the
            // GitHub writes, which is what a throwaway repo can honour.
            noPost: true,
          },
        });
        const receipt = JSON.parse(payload(started, "run_start")) as {
          runId: string;
          cursor: string;
          accepted: boolean;
        };
        expect(receipt.accepted).toBe(true);

        // The IDEMPOTENCY property, across the bridge: the same request id must
        // replay the receipt rather than start a second run. This is the one an
        // agent's lost tool call depends on.
        const again = await client.callTool({
          name: "run_start",
          arguments: {
            checkout: dir,
            expectedSha: headOf(dir),
            requestId: "e2e-bridge-1",
            // The fixture has no GitHub origin, and strict mode is right to
            // refuse a run it could not report. `noPost` is strict WITHOUT the
            // GitHub writes, which is what a throwaway repo can honour.
            noPost: true,
          },
        });
        const replayed = JSON.parse(payload(again, "the repeated run_start")) as {
          runId: string;
          replayed: boolean;
        };
        expect(replayed.runId).toBe(receipt.runId);
        expect(replayed.replayed).toBe(true);

        // Then wait to a verdict, carrying the cursor the way the skill teaches.
        let cursor = receipt.cursor;
        let answer: {
          reason: string;
          settled: boolean;
          passed: boolean;
          cursor: string;
          failures: { logKey: string }[];
        };
        for (;;) {
          const waited = await client.callTool({
            name: "run_wait",
            arguments: { runId: receipt.runId, after: cursor, settle: true },
          });
          // RED CI IS NOT A TOOL ERROR. The distinction an agent branches on,
          // asserted rather than assumed — `payload` throws if it ever becomes
          // one.
          answer = JSON.parse(payload(waited, "run_wait"));
          cursor = answer.cursor;
          if (answer.reason !== "still_running") break;
        }
        expect(answer.settled).toBe(true);
        expect(answer.passed).toBe(false);
        expect(answer.failures.length).toBeGreaterThan(0);

        // The evidence is ADDRESSED: echo the key, do not rebuild it.
        const key = answer.failures[0]?.logKey as string;
        const read = await client.callTool({
          name: "log_read",
          arguments: { key, offset: -4096 },
        });
        const page = JSON.parse(payload(read, "log_read")) as {
          text: string;
          complete: boolean;
        };
        expect(page.text.length).toBeGreaterThan(0);
      } finally {
        await close();
      }
    } finally {
      cleanup(dir);
    }
  }, 300_000);

  it("refuses a hand-built log key rather than guessing at it", async () => {
    const { client, close } = await connectBridge(world.env);
    try {
      const read = await client.callTool({
        name: "log_read",
        arguments: { key: "not/a/key/odu/issued" },
      });
      // A REFUSAL, which is a tool error — as distinct from red CI, which is
      // not. Both arms matter and this is the other one.
      expect(read.isError).toBe(true);
    } finally {
      await close();
    }
  }, 120_000);
});

/**
 * THE COLD-HOST GATE.
 *
 * A fresh machine, no daemon, and the bridge launched exactly the way an MCP
 * host launches it. Nothing in the suite sets a service up first — that is the
 * point. If the bridge could not bootstrap, an agent on a new machine would have
 * no way to get one: it has no terminal to run `odu web --background` in.
 *
 * A world of its own (its own origin, catalog and daemon home) so the daemon
 * this starts cannot be the one the suite above left running.
 */
describe("odu mcp — cold bootstrap", () => {
  it("starts the service itself when nothing is serving", async () => {
    const world = coldWorld("cold", suitePortFor("coldBootstrap"));
    let daemonHome: string | null = null;
    try {
      // THE PREMISE, ASSERTED — not reclaimed. This used to fix a hardcoded
      // 18493 and, finding something on it, try to stop that something through
      // `odu surface get service --origin`. Two things were wrong with that.
      // The port was shared: every other world in this suite derives its port
      // from the pid precisely so two checkouts do not fight, and this one did
      // not, so two suites on one machine each killed the other's daemon and
      // each re-bootstrapped — reported as "the stale cold-port daemon to go
      // away did not happen within 120000ms", in a test whose subject is that
      // nothing is serving. And the reclaim could START what it was emptying:
      // `ODU_WEB_ORIGIN` is in that env, so the probe's own bootstrap was
      // allowed and it spawned a daemon on the port under test. With a port of
      // this process's own there is nothing legitimate to reclaim, so this is a
      // precondition rather than a repair.
      expect(
        await tcpListening(world.origin),
        "something is already serving this suite's cold port",
      ).toBe(false);

      const { client, close } = await connectBridge(world.env);
      try {
        // One ordinary read. It can only be answered by a service, so answering
        // it at all is the bootstrap.
        const cell = await readServiceCell(client);
        expect(cell.identity.origin).toBe(world.origin);
        // READY, not merely answering: a service still reconciling its catalog
        // would give an agent a partial board with no way to tell.
        expect(cell.readiness.state).toBe("ready");
        world.adopt(cell.identity.pid);
        daemonHome = cell.identity.home;
      } finally {
        await close();
      }

      // And it OUTLIVES the bridge, which is the other half of the promise: the
      // host restarting its MCP server must not take the service with it.
      // Probed over TCP again — asking odu would start one and prove nothing.
      expect(
        await tcpListening(world.origin),
        "the service did not outlive the bridge that started it",
      ).toBe(true);
    } finally {
      world.dispose(daemonHome);
    }
  }, 300_000);

  it("two cold faces racing for one daemon converge on it", async () => {
    // The ordinary morning, not an edge case: a person opens a terminal and an
    // agent's host starts its MCP server, on a machine where nothing is
    // running. Two services would be two truths about one run, and the loser of
    // the race must not take the port from the winner — which is what
    // `serveWebService` claiming the pid gate BEFORE it binds is for.
    const world = coldWorld("race", suitePortFor("coldRace"));
    let daemonHome: string | null = null;
    try {
      expect(
        await tcpListening(world.origin),
        "something is already serving this suite's race port",
      ).toBe(false);

      // FOUR AT ONCE, and two of each face — a terminal client and an agent's
      // bridge bootstrap through the same seam but from different processes,
      // and a race that only ever ran one kind would not have exercised it.
      //
      // `Bun.spawn`, never `spawnSync`: a synchronous spawn blocks this thread
      // until the child exits, so a `Promise.all` over four of them would run
      // them one after another and assert nothing about a race at all.
      const viaTerminal = async (): Promise<ServiceFacts> => {
        const child = Bun.spawn([oduBin, "surface", "get", "service"], {
          env: world.env as Record<string, string>,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err, status] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (status !== 0) {
          throw new Error(
            `e2e: cold \`odu surface get service\` exited ${status}\n${err}`,
          );
        }
        return factsOf(JSON.parse(out));
      };
      const viaBridge = async (): Promise<ServiceFacts> => {
        const { client, close } = await connectBridge(world.env);
        try {
          return factsOf(await readServiceCell(client));
        } finally {
          await close();
        }
      };
      const answers = await Promise.all([
        viaTerminal(),
        viaBridge(),
        viaTerminal(),
        viaBridge(),
      ]);

      // ALL FOUR got a working service…
      for (const answer of answers) {
        expect(answer.state).toBe("ready");
        expect(answer.origin).toBe(world.origin);
      }
      // …and it is the SAME one. A second pid here would mean two daemons on
      // one address, which is either impossible (one of them never bound) or
      // catastrophic (one of them took the other's port), and both readings are
      // failures.
      const pids = new Set(answers.map((a) => a.pid));
      expect(
        [...pids],
        `four cold faces reached ${pids.size} different services`,
      ).toHaveLength(1);
      const winner = answers[0] as ServiceFacts;
      world.adopt(winner.pid);
      daemonHome = winner.home;

      // And the survivor is still the survivor a moment later — a loser that
      // had bound anything would have taken this address from it. Read from the
      // service itself rather than by scanning `ps`, because the daemon may be
      // a transient systemd unit rather than a process group and this suite
      // must not depend on which branch the host took.
      expect((await viaTerminal()).pid).toBe(winner.pid);
    } finally {
      world.dispose(daemonHome);
    }
  }, 300_000);
});

/**
 * THE OCCUPIED PORT, THROUGH THE AGENT'S EYES.
 *
 * A person who runs `odu web` on a taken port is told so in a sentence. An
 * agent used to be told nothing at all: the bridge's bootstrap polled the
 * readiness cell for its full sixty seconds, the MCP SDK's own request timeout
 * fired first, and the whole of what reached the agent was
 * `MCP error -32001: Request timed out` after sixty-three seconds. That is not
 * a refusal, it is an absence of one, and an agent cannot act on it.
 */
describe("odu mcp — a port that belongs to something else", () => {
  it("refuses in a sentence that names the port, fast", async () => {
    const port = suitePortFor("occupiedAgent");
    const world = coldWorld("occupied", port);
    // A plain TCP listener that accepts and says nothing — a foreign program,
    // as far as odu can tell, which is the whole point.
    const squatter = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data: () => {}, open: () => {} },
    });
    try {
      const { client, close } = await connectBridge(world.env);
      try {
        const began = Date.now();
        let refusal: string | null = null;
        try {
          // A 30s ceiling deliberately BELOW the SDK's 60s default: if the fix
          // ever regresses, this fails as a timeout at 30s rather than
          // reproducing the original 63s one, and the assertion below still
          // says what was missing.
          await client.readResource(
            { uri: "surface://cells/service" },
            { timeout: 30_000 },
          );
        } catch (err) {
          refusal = String(err);
        }
        const elapsed = Date.now() - began;
        expect(refusal, "an occupied port answered as though it were fine").not
          .toBeNull();
        // THE SENTENCE, not merely a failure. A timeout is not a refusal.
        expect(
          refusal ?? "",
          "the refusal never names the port that is taken",
        ).toContain(String(port));
        expect(refusal ?? "").not.toContain("Request timed out");
        // FAST. The defect was sixty-three seconds of silence; the answer was
        // available in one. Fifteen seconds is slack for a loaded runner, and
        // still four times better than the SDK timeout that used to win.
        expect(
          elapsed,
          `the refusal took ${elapsed}ms — it is available immediately`,
        ).toBeLessThan(15_000);
      } finally {
        await close();
      }
    } finally {
      squatter.stop(true);
      world.dispose(null);
    }
  }, 300_000);
});

/**
 * A world with nothing in it: its own state root, its own origin, and a
 * teardown that reaps whatever it started.
 *
 * `adopt` rather than a return value because the pid is learned in the middle
 * of the test, and a daemon started by an attempt that then FAILED must still
 * be reaped — which is why the pid is recorded on the world the moment it is
 * known rather than at the end.
 */
function coldWorld(
  name: string,
  port: number,
): {
  origin: string;
  env: NodeJS.ProcessEnv;
  adopt: (pid: number) => void;
  dispose: (daemonHome: string | null) => void;
} {
  const root = scratchDir(`odu-e2e-${name}-`);
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const origin = `http://127.0.0.1:${port}`;
  let pid: number | null = null;
  return {
    origin,
    env: {
      ...hermeticEnv,
      ODU_STATE_DIR: state,
      ODU_WEB_ORIGIN: origin,
    } as NodeJS.ProcessEnv,
    adopt: (value) => {
      pid = value;
    },
    dispose: (daemonHome) => {
      if (pid !== null) killDaemon(pid);
      // The daemon home lives under the REAL `~/.local/state` — `daemonHome`'s
      // "state" placement ignores `XDG_STATE_HOME` on purpose, so moving the
      // origin is the only lever and the directory it leaves is this suite's to
      // remove. Twenty-one of them had accumulated on the author's machine
      // because nothing here removed any.
      for (const dir of [root, daemonHome]) {
        if (dir === null) continue;
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          process.stderr.write(`e2e: failed to remove ${dir}: ${String(err)}\n`);
        }
      }
    },
  };
}
