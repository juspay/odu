/**
 * End-to-end over `odu mcp` — the ONE agent face, and the only one.
 *
 * This file used to drive the per-checkout MCP server: nine tools of its own, a
 * dial of `.ci/odu.sock`, and run authority that no other face could see. That
 * server is deleted, and what replaced it is a BRIDGE — bare `odu mcp` dials the
 * singleton web service and projects the same five verbs the browser and
 * `odu surface` project, under the same names.
 *
 * Two properties are worth an e2e rather than a unit test, and both are about
 * the seam between processes rather than about a tool:
 *
 *   - **A cold host gets a working face.** An MCP host launches this bridge on a
 *     machine where nothing has ever run odu. That is the ORDINARY first
 *     contact, not an edge case, and it is the one the old face never had to
 *     handle because it carried its own authority. Here the bridge must start
 *     the service itself, verify it is ready, and answer — and it must do so
 *     through the REAL launcher an MCP config points at, not through a
 *     convenient in-process shortcut.
 *   - **The vocabulary is exactly the shared one.** Not "contains the five
 *     verbs" — EXACTLY them. An extra tool here would be the second face growing
 *     back, and it would grow back invisibly: nothing else in the suite would
 *     notice a face that could do one more thing than the browser can.
 *
 * Black-box like the rest of `tests/e2e`: no import from `src/`, the packaged
 * Nix binary only.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildOduBinary, cleanup, hermeticEnv } from "./harness";
import {
  headOf,
  makeWebFixture,
  startWebServiceViaCommand,
  until,
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

/** The five verbs the shared contract exposes as tools, and nothing else. */
const SHARED_TOOLS = [
  "log_read",
  "run_cancel",
  "run_retry",
  "run_start",
  "run_wait",
] as const;

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
async function readServiceCell(client: Client): Promise<{
  identity: { origin: string; pid: number };
  readiness: { state: string };
}> {
  const read = await client.readResource({ uri: "surface://cells/service" });
  const first = read.contents[0];
  if (first === undefined || !("text" in first)) {
    throw new Error(
      `e2e: the service cell came back as ${JSON.stringify(first)} — expected a text resource`,
    );
  }
  return JSON.parse(first.text) as {
    identity: { origin: string; pid: number };
    readiness: { state: string };
  };
}

describe("odu mcp — the shared-service bridge", () => {
  let world: WebWorld;

  beforeAll(async () => {
    world = await startWebServiceViaCommand(oduBin);
  }, 300_000);

  afterAll(() => world?.dispose());

  it("exposes EXACTLY the five shared verbs — no face-local tool", async () => {
    const { client, close } = await connectBridge(world.env);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      // Equality, not containment. A face that could do one more thing than the
      // browser can is the second vocabulary growing back, and containment would
      // not see it.
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
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { spawnSync } = await import("node:child_process");

    const root = mkdtempSync(join(tmpdir(), "odu-e2e-cold-"));
    const state = join(root, "state");
    mkdirSync(state, { recursive: true });
    // A port nothing else in this suite uses, so "nothing is serving" is a fact
    // rather than a hope.
    const origin = "http://127.0.0.1:18493";
    const env = {
      ...hermeticEnv,
      ODU_STATE_DIR: state,
      ODU_WEB_ORIGIN: origin,
    } as NodeJS.ProcessEnv;

    // RECLAIM THE PORT, then prove the premise. This test's whole subject is
    // "nothing is serving", and a daemon it started on a previous run — or one
    // an earlier failure left behind before it could capture a pid — would make
    // the premise false and the result meaningless. So it stops whatever is
    // there rather than asserting an empty machine it does not control.
    //
    // **Probed over TCP, never through `odu surface`.** Every service client
    // bootstraps now, so asking odu whether a service is running STARTS one —
    // and a poll loop written that way kills a daemon and immediately spawns
    // its replacement, forever. That is not a flaw in the bootstrap; it is what
    // "no face reports nothing-serving without trying to fix it" means. A test
    // that wants to observe absence has to observe it from outside odu.
    const anythingServing = async (): Promise<boolean> => {
      try {
        await fetch(`${origin}/`, { signal: AbortSignal.timeout(1_000) });
        return true;
      } catch {
        return false;
      }
    };
    if (await anythingServing()) {
      const cell = spawnSync(
        oduBin,
        ["surface", "get", "service", "--origin", origin],
        { env: env as Record<string, string>, encoding: "utf-8" },
      );
      if (cell.status === 0) {
        const stale = JSON.parse(cell.stdout) as { identity: { pid: number } };
        for (const target of [-stale.identity.pid, stale.identity.pid]) {
          try {
            process.kill(target, "SIGTERM");
          } catch {
            // Already gone, or never a group leader.
          }
        }
      }
      await until("the stale cold-port daemon to go away", async () =>
        (await anythingServing()) ? null : true,
      );
    }
    expect(
      await anythingServing(),
      "something is still serving the cold port",
    ).toBe(false);

    let daemonPid: number | null = null;
    try {
      const { client, close } = await connectBridge(env);
      try {
        // One ordinary read. It can only be answered by a service, so answering
        // it at all is the bootstrap.
        const cell = await readServiceCell(client);
        expect(cell.identity.origin).toBe(origin);
        // READY, not merely answering: a service still reconciling its catalog
        // would give an agent a partial board with no way to tell.
        expect(cell.readiness.state).toBe("ready");
        daemonPid = cell.identity.pid;
      } finally {
        await close();
      }

      // And it OUTLIVES the bridge, which is the other half of the promise: the
      // host restarting its MCP server must not take the service with it.
      // Probed over TCP again, for the same reason as above — asking odu would
      // start one and prove nothing.
      expect(
        await anythingServing(),
        "the service did not outlive the bridge that started it",
      ).toBe(true);
    } finally {
      if (daemonPid !== null) {
        for (const target of [-daemonPid, daemonPid]) {
          try {
            process.kill(target, "SIGTERM");
          } catch {
            // Already gone, or never a group leader.
          }
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
