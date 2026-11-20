import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  BIG,
  buildOduBinary,
  removeNow,
  hermeticEnv,
  repoRoot,
  scratchDir,
} from "./harness";
import {
  headOf,
  killDaemon,
  makeWebFixture,
  SHARED_TOOLS,
  suitePortFor,
  tcpListening,
} from "./webHarness";

const FAILING = `[metadata("ci")]
default: alpha beta

alpha:
    echo "alpha ok"

beta: alpha
    echo "beta is about to fail"
    exit 3
`;

const FIXED_LOCATIONS = ["mcp.json", "plugin.json", "skills"] as const;
const ODU_SKILL = "skills/odu/SKILL.md";

interface McpConfig {
  $schema: string;
  mcpServers: Record<
    string,
    { type: string; command: string; args?: string[]; cwd?: string }
  >;
}

let oduBin: string;
let pluginRoot: string;
let pluginData: string;
let shimDir: string;
let stateDir: string;
let origin: string;
let daemonHome: string | null = null;
let daemonPid: number | null = null;

function installPlugin(): string {
  const dir = scratchDir("odu-e2e-plugin-");
  const copied = spawnSync(
    "sh",
    [
      "-c",
      `git ls-files -z -- ${FIXED_LOCATIONS.join(" ")} | tar --null -T - -cf - | tar -xf - -C '${dir}'`,
    ],
    { cwd: repoRoot, encoding: "utf-8", maxBuffer: BIG },
  );
  if (copied.status !== 0) {
    throw new Error(`e2e: could not export the plugin's tracked files: ${copied.stderr}`);
  }
  return dir;
}

function withoutShim(command: string): string[] {
  return ['export PATH="$ODU_E2E_REAL_PATH"', command];
}

function writeNixShim(dir: string): void {
  const path = join(dir, "nix");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "${1:-}" != "run" ] || [ "${2:-}" != "--accept-flake-config" ] \\',
      '   || [ "${3:-}" != "github:juspay/odu" ] || [ "${4:-}" != "--" ] \\',
      '   || [ "${5:-}" != "mcp" ]; then',
      `  printf '%s\\n' "$*" > ${JSON.stringify(join(dir, "nix.argv"))}`,
      "  exit 97",
      "fi",
      "shift 5",
      ...withoutShim('exec "$ODU_E2E_BIN" mcp "$@"'),
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

beforeAll(() => {
  oduBin = buildOduBinary();
  pluginRoot = installPlugin();
  pluginData = scratchDir("odu-e2e-plugindata-");
  shimDir = scratchDir("odu-e2e-nixshim-");
  writeNixShim(shimDir);
  stateDir = scratchDir("odu-e2e-installstate-");
  mkdirSync(stateDir, { recursive: true });
  origin = `http://127.0.0.1:${suitePortFor("freshInstall")}`;
}, 900_000);

afterAll(() => {
  if (daemonPid !== null) killDaemon(daemonPid);
  for (const dir of [pluginRoot, pluginData, shimDir, stateDir, daemonHome]) {
    if (dir === undefined || dir === null) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(`e2e: failed to remove ${dir}: ${String(err)}\n`);
    }
  }
});

function mcpConfig(): McpConfig {
  return JSON.parse(readFileSync(join(pluginRoot, "mcp.json"), "utf-8")) as McpConfig;
}

describe("a client loading odu's Agent Plugin", () => {
  it("sees exactly the root fixed locations, and one authored skill", () => {
    expect(readdirSync(pluginRoot).sort()).toEqual([...FIXED_LOCATIONS].sort());
    const skills = join(pluginRoot, "skills");
    expect(readdirSync(skills).sort()).toEqual(["odu"]);
    expect(readFileSync(join(pluginRoot, ODU_SKILL), "utf-8")).toBe(
      readFileSync(join(repoRoot, ODU_SKILL), "utf-8"),
    );
  });

  it("finds one stdio MCP server with a single-token command", () => {
    const servers = mcpConfig().mcpServers;
    expect(Object.keys(servers)).toEqual(["odu"]);
    const odu = servers.odu;
    expect(odu?.type).toBe("stdio");
    expect(odu?.command).toMatch(/^[^\s/]+$/);
  });

  it("bootstraps a service and answers a tool call through that exact server", async () => {
    const odu = mcpConfig().mcpServers.odu;
    if (odu === undefined) throw new Error("e2e: mcp.json declares no `odu` server");

    expect(
      await tcpListening(origin),
      "something is already serving this gate's origin",
    ).toBe(false);

    const transport = new StdioClientTransport({
      command: odu.command,
      args: odu.args ?? [],
      cwd: pluginRoot,
      env: {
        ...hermeticEnv,
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        PLUGIN_ROOT: pluginRoot,
        PLUGIN_DATA: pluginData,
        ODU_E2E_BIN: oduBin,
        ODU_E2E_REAL_PATH: process.env.PATH ?? "",
        ODU_STATE_DIR: stateDir,
        ODU_WEB_ORIGIN: origin,
      } as Record<string, string>,
    });
    const client = new Client({ name: "odu-e2e-install", version: "0.0.0" });
    const dir = makeWebFixture(FAILING);
    try {
      await client.connect(transport);

      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual([...SHARED_TOOLS]);

      const read = await client.readResource({ uri: "surface://cells/service" });
      const first = read.contents[0];
      if (first === undefined || !("text" in first)) {
        throw new Error(
          `e2e: the service cell came back as ${JSON.stringify(first)} — expected a text resource`,
        );
      }
      const cell = JSON.parse(first.text) as {
        identity: { origin: string; pid: number; home: string };
        readiness: { state: string };
      };
      expect(cell.identity.origin).toBe(origin);
      expect(cell.readiness.state).toBe("ready");
      daemonPid = cell.identity.pid;
      daemonHome = cell.identity.home;

      const started = await client.callTool({
        name: "run_start",
        arguments: {
          checkout: dir,
          expectedSha: headOf(dir),
          requestId: "e2e-install-1",
          noPost: true,
        },
      });
      const receipt = JSON.parse(payload(started, "run_start")) as {
        runId: string;
        cursor: string;
        accepted: boolean;
      };
      expect(receipt.accepted).toBe(true);

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

      const page = JSON.parse(
        payload(
          await client.callTool({
            name: "log_read",
            arguments: { key: answer.failures[0]?.logKey, offset: -4096 },
          }),
          "log_read",
        ),
      ) as { text: string };
      expect(page.text.length).toBeGreaterThan(0);
    } finally {
      await client.close().catch(() => {});
      removeNow(dir);
      const offending = join(shimDir, "nix.argv");
      if (existsSync(offending)) {
        throw new Error(
          "e2e: the plugin's MCP server did not invoke nix the way the skill " +
            `promises — it ran: nix ${readFileSync(offending, "utf-8").trim()}`,
        );
      }
    }
  }, 900_000);
});

function payload(result: Record<string, unknown>, what: string): string {
  const text = String(
    (result.content as { text?: string }[] | undefined)?.[0]?.text ?? "",
  );
  if (result.isError === true) {
    throw new Error(`e2e: ${what} was refused — ${text}`);
  }
  return text;
}
