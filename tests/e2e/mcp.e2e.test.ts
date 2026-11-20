import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  buildOduBinary,
  removeNow,
  hermeticEnv,
  scratchDir,
} from "./harness";
import {
  headOf,
  killDaemon,
  until,
  makeWebFixture,
  SHARED_TOOLS,
  startWebServiceViaCommand,
  suitePortFor,
  tcpListening,
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

let oduBin: string;

beforeAll(() => {
  oduBin = buildOduBinary();
}, 600_000);

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

function payload(result: Record<string, unknown>, what: string): string {
  const text = String(
    (result.content as { text?: string }[] | undefined)?.[0]?.text ?? "",
  );
  if (result.isError === true) {
    throw new Error(`e2e: ${what} was refused — ${text}`);
  }
  return text;
}

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

interface ServiceCellish {
  identity: { origin: string; pid: number; home: string };
  readiness: { state: string };
}

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
      expect(names).toEqual([...SHARED_TOOLS]);
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
      expect(uris.some((u) => u.includes("nodes"))).toBe(false);
    } finally {
      await close();
    }
  }, 120_000);

  it("names the same service the terminal face is talking to", async () => {
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
            noPost: true,
          },
        });
        const receipt = JSON.parse(payload(started, "run_start")) as {
          runId: string;
          cursor: string;
          accepted: boolean;
        };
        expect(receipt.accepted).toBe(true);

        const again = await client.callTool({
          name: "run_start",
          arguments: {
            checkout: dir,
            expectedSha: headOf(dir),
            requestId: "e2e-bridge-1",
            noPost: true,
          },
        });
        const replayed = JSON.parse(payload(again, "the repeated run_start")) as {
          runId: string;
          replayed: boolean;
        };
        expect(replayed.runId).toBe(receipt.runId);
        expect(replayed.replayed).toBe(true);

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
          answer = JSON.parse(payload(waited, "run_wait"));
          cursor = answer.cursor;
          if (answer.reason !== "still_running") break;
        }
        expect(answer.settled).toBe(true);
        expect(answer.passed).toBe(false);
        expect(answer.failures.length).toBeGreaterThan(0);

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
      removeNow(dir);
    }
  }, 300_000);

  it("refuses a hand-built log key rather than guessing at it", async () => {
    const { client, close } = await connectBridge(world.env);
    try {
      const read = await client.callTool({
        name: "log_read",
        arguments: { key: "not/a/key/odu/issued" },
      });
      expect(read.isError).toBe(true);
    } finally {
      await close();
    }
  }, 120_000);
});

describe("odu mcp — cold bootstrap", () => {
  it("starts the service itself when nothing is serving", async () => {
    const world = coldWorld("cold", suitePortFor("coldBootstrap"));
    try {
      expect(
        await tcpListening(world.origin),
        "something is already serving this suite's cold port",
      ).toBe(false);

      const { client, close } = await connectBridge(world.env);
      try {
        const cell = await readServiceCell(client);
        expect(cell.identity.origin).toBe(world.origin);
        expect(cell.readiness.state).toBe("ready");
        world.adopt(cell.identity.pid, cell.identity.home);
      } finally {
        await close();
      }

      expect(
        await tcpListening(world.origin),
        "the service did not outlive the bridge that started it",
      ).toBe(true);
    } finally {
      world.dispose();
    }
  }, 300_000);

  it("two cold faces racing for one daemon converge on it", async () => {
    const world = coldWorld("race", suitePortFor("coldRace"));
    try {
      expect(
        await tcpListening(world.origin),
        "something is already serving this suite's race port",
      ).toBe(false);

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

      for (const answer of answers) {
        expect(answer.state).toBe("ready");
        expect(answer.origin).toBe(world.origin);
      }
      const pids = new Set(answers.map((a) => a.pid));
      expect(
        [...pids],
        `four cold faces reached ${pids.size} different services`,
      ).toHaveLength(1);
      const winner = answers[0] as ServiceFacts;
      world.adopt(winner.pid, winner.home);

      expect((await viaTerminal()).pid).toBe(winner.pid);
    } finally {
      world.dispose();
    }
  }, 300_000);
});

describe("odu mcp — a port that belongs to something else", () => {
  it("refuses in a sentence that names the port, fast", async () => {
    const port = suitePortFor("occupiedAgent");
    const world = coldWorld("occupied", port);
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
        expect(
          refusal ?? "",
          "the refusal never names the port that is taken",
        ).toContain(String(port));
        expect(refusal ?? "").not.toContain("Request timed out");
        expect(
          elapsed,
          `the refusal took ${elapsed}ms — it is available immediately`,
        ).toBeLessThan(15_000);
      } finally {
        await close();
      }
    } finally {
      squatter.stop(true);
      world.dispose();
    }
  }, 300_000);
});

describe("odu mcp — the bridge redials", () => {
  it("answers again after the daemon it was talking to is killed", async () => {
    const world = coldWorld("redial", suitePortFor("bridgeRedial"));
    try {
      const { client, close } = await connectBridge(world.env);
      try {
        const first = await client.callTool({ name: "run_list", arguments: {} });
        expect(JSON.parse(payload(first, "run_list"))).toHaveProperty("rows");

        const cell = await readServiceCell(client);
        world.adopt(cell.identity.pid, cell.identity.home);
        killDaemon(cell.identity.pid);
        await until(
          "the killed daemon's port to close",
          async () => ((await tcpListening(world.origin)) ? null : true),
          30_000,
        );

        let last = "no answer at all";
        const answered = await until(
          "a run_list answered after the daemon was killed",
          async () => {
            try {
              const again = await client.callTool({ name: "run_list", arguments: {} });
              if (again.isError === true) {
                last = String((again.content as { text?: string }[] | undefined)?.[0]?.text ?? "");
                return null;
              }
              return JSON.parse(payload(again, "run_list"));
            } catch (err) {
              last = String(err);
              return null;
            }
          },
          60_000,
        ).catch((err: unknown) => {
          throw new Error(`${String(err)}\nlast answer: ${last}`);
        });
        expect(answered).toHaveProperty("rows");

        const replacement = await readServiceCell(client);
        world.adopt(replacement.identity.pid, replacement.identity.home);
      } finally {
        await close();
      }
    } finally {
      world.dispose();
    }
  }, 300_000);
});

function coldWorld(
  name: string,
  port: number,
): {
  origin: string;
  env: NodeJS.ProcessEnv;
  adopt: (pid: number, home: string) => void;
  dispose: () => void;
} {
  const root = scratchDir(`odu-e2e-${name}-`);
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const origin = `http://127.0.0.1:${port}`;
  let adopted: { pid: number; home: string } | null = null;
  return {
    origin,
    env: {
      ...hermeticEnv,
      ODU_STATE_DIR: state,
      ODU_WEB_ORIGIN: origin,
    } as NodeJS.ProcessEnv,
    adopt: (pid, home) => {
      adopted = { pid, home };
    },
    dispose: () => {
      const owned: { pid: number; home: string } | null = adopted;
      if (owned !== null) killDaemon(owned.pid);
      for (const dir of [root, ...(owned === null ? [] : [owned.home])]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          process.stderr.write(`e2e: failed to remove ${dir}: ${String(err)}\n`);
        }
      }
    },
  };
}
