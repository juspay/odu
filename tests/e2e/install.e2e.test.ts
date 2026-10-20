/**
 * THE FRESH CONSUMER — loading the plugin, all the way to a tool call.
 *
 * Every other gate in this suite starts from odu's own checkout. That is not
 * first contact. First contact is a client that has installed odu's Agent
 * Plugin (https://agent-plugins.org/): the repository root IS the plugin root,
 * so it reads `plugin.json` and `mcp.json` there and spawns what `mcp.json`
 * names — with the plugin root as the working directory and `PLUGIN_ROOT` /
 * `PLUGIN_DATA` in the environment, as the spec requires.
 *
 * This gate does exactly that against the TRACKED contents a client reading the
 * root receives — `plugin.json`, `skills/` and `mcp.json` (§6.1 fixed
 * locations) — so a file a client would never receive cannot make it pass, and
 * a fixed location that went missing cannot hide behind the rest of the repo.
 *
 * ## What the `nix` shim buys, and what it does not
 *
 * The server's command is `nix run --accept-flake-config github:juspay/odu --
 * mcp`, and there is deliberately no override knob — a consumer that must pin
 * odu pins the whole plugin. So executing it honestly would fetch and build
 * upstream master inside a test. Instead a `nix` shim goes first on PATH: it
 * ASSERTS the exact argv and then execs the locally built binary with the shim
 * removed from PATH again (odu itself shells out to `nix`, and a shim still
 * shadowing it would break every run the service starts).
 *
 * That proves the plugin invokes nix correctly. It does NOT prove `nix run
 * github:juspay/odu` resolves; a broken upstream flake would still ship.
 * Accepted deliberately: the alternative is a multi-minute network build inside
 * an e2e.
 */

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
  cleanup,
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

/** A DAG whose second node fails — so the tool call this ends on has something
 *  real to diagnose. */
const FAILING = `[metadata("ci")]
default: alpha beta

alpha:
    echo "alpha ok"

beta: alpha
    echo "beta is about to fail"
    exit 3
`;

/** The §6.1 fixed locations a client reading the root receives. One list,
 *  because the export and the equality below must name the same set. */
const FIXED_LOCATIONS = ["mcp.json", "plugin.json", "skills"] as const;
const ODU_SKILL = "skills/odu/SKILL.md";

/** The plugin's `mcp.json`, as the spec shapes it. */
interface McpConfig {
  $schema: string;
  mcpServers: Record<
    string,
    { type: string; command: string; args?: string[]; cwd?: string }
  >;
}

let oduBin: string;
/** The installed plugin root — outside this repo, because a client's copy is. */
let pluginRoot: string;
/** The client-managed `PLUGIN_DATA` directory. */
let pluginData: string;
/** Where the `nix` shim lives, prepended to the server's PATH. */
let shimDir: string;
/** This gate's own state root and origin, so the daemon the server bootstraps
 *  is nobody else's. */
let stateDir: string;
let origin: string;
/** Read off the service the server started, so teardown reaps exactly it. */
let daemonHome: string | null = null;
let daemonPid: number | null = null;

/** The plugin's TRACKED fixed locations, copied out — what a client actually
 *  installs.
 *
 *  The root is the plugin, but not the whole root is the package: §6.1 names
 *  the fixed locations, so those are exported whole. Exporting `skills/odu` by
 *  name would filter a stray `skills/other/` out of the copy, and the "exactly
 *  one skill" equality below would then never see what a real client installs.
 *  `git ls-files` rather than a recursive copy: it is the set a consumer
 *  receives, it honours `.gitignore`, and it takes the WORKING TREE's contents
 *  — so an uncommitted edit to the plugin under test is still what gets
 *  loaded. */
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

/**
 * A `nix` that refuses to be anything but the MCP server's one call.
 *
 * An argv the server was not supposed to send is recorded and exits 97, so a
 * regression in that line fails as "here is what it actually ran" rather than
 * as a hang or a network fetch. `PATH` is restored before the exec because odu
 * shells out to the real `nix` for every run it starts.
 */
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
      '# The shim is out of the way from here on: the service this becomes',
      '# starts coordinators that shell out to the REAL nix.',
      'export PATH="$ODU_E2E_REAL_PATH"',
      'exec "$ODU_E2E_BIN" mcp "$@"',
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
  // 900s: the nix build of odu in front of everything is minutes on a cold
  // store.
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

/** `mcp.json` from the installed plugin root — where a client reads it. */
function mcpConfig(): McpConfig {
  return JSON.parse(readFileSync(join(pluginRoot, "mcp.json"), "utf-8")) as McpConfig;
}

describe("a client loading odu's Agent Plugin", () => {
  it("sees exactly the root fixed locations, and one authored skill", () => {
    // THE WHOLE PACKAGE A CLIENT READING THE ROOT SEES: the manifest, the
    // `skills/` fixed location, and `mcp.json`. EQUALITY, because a file that
    // happens to sit at the root is not part of the plugin unless §6.1 names it.
    expect(readdirSync(pluginRoot).sort()).toEqual([...FIXED_LOCATIONS].sort());
    const skills = join(pluginRoot, "skills");
    // EQUALITY. A second skill directory is a second vocabulary — that is what
    // the deleted `odu-mcp` was. "Contains odu" would not have seen it.
    expect(readdirSync(skills).sort()).toEqual(["odu"]);
    // A client that loaded something other than what this repo reviews would
    // be teaching agents an unreviewed skill.
    expect(readFileSync(join(pluginRoot, ODU_SKILL), "utf-8")).toBe(
      readFileSync(join(repoRoot, ODU_SKILL), "utf-8"),
    );
  });

  it("finds one stdio MCP server with a single-token command", () => {
    const servers = mcpConfig().mcpServers;
    expect(Object.keys(servers)).toEqual(["odu"]);
    const odu = servers.odu;
    expect(odu?.type).toBe("stdio");
    // The spec requires `command` to be ONE executable token — a bare name or a
    // `./` plugin-relative path — never a shell string. A bare `nix` needs
    // nothing shipped in the package, so there is no launcher to lose.
    expect(odu?.command).toMatch(/^[^\s/]+$/);
  });

  it("bootstraps a service and answers a tool call through that exact server", async () => {
    const odu = mcpConfig().mcpServers.odu;
    if (odu === undefined) throw new Error("e2e: mcp.json declares no `odu` server");

    expect(
      await tcpListening(origin),
      "something is already serving this gate's origin",
    ).toBe(false);

    // Launched the way a conformant client launches it: `command` and `args`
    // from `mcp.json`, cwd at the plugin root (the spec's default when `cwd` is
    // omitted), and the two variables the spec has the client supply. Nothing
    // here reaches for `oduBin` — that path exists only inside the shim.
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

      // ONE VOCABULARY, reached through an installed plugin. Equality: a face
      // a consumer installs that could do one more thing than the browser can
      // is the second face growing back where nobody would look for it.
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual([...SHARED_TOOLS]);

      // COLD BOOTSTRAP THROUGH THE INSTALLED PATH. Nothing set a service up;
      // answering this at all is the server having started one.
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
      // READY, not merely answering: a service still reconciling its catalog
      // would hand an agent a partial board with no way to tell.
      expect(cell.readiness.state).toBe("ready");
      daemonPid = cell.identity.pid;
      daemonHome = cell.identity.home;

      // AND A REAL TOOL CALL, to a real verdict. A listing proves a vocabulary;
      // only a run proves the installed face can do the thing it is for.
      const started = await client.callTool({
        name: "run_start",
        arguments: {
          checkout: dir,
          expectedSha: headOf(dir),
          requestId: "e2e-install-1",
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
        // RED CI IS NOT A TOOL ERROR — `payload` throws if it ever becomes one.
        answer = JSON.parse(payload(waited, "run_wait"));
        cursor = answer.cursor;
        if (answer.reason !== "still_running") break;
      }
      expect(answer.settled).toBe(true);
      expect(answer.passed).toBe(false);
      expect(answer.failures.length).toBeGreaterThan(0);

      // The evidence is ADDRESSED: echo the key, do not rebuild it.
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
      cleanup(dir);
      // The shim's own verdict on the server's argv, checked last so an argv
      // regression reports what was run rather than a connect that timed out.
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
