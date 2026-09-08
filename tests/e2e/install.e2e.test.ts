/**
 * THE FRESH CONSUMER — installation, all the way to a tool call.
 *
 * Every other gate in this suite starts from odu's own checkout, where the
 * `.claude/` tree and `.mcp.json` are already there and already correct. That
 * is not first contact. First contact is somebody else's repository: they
 * declare a dependency on odu, run `apm install`, and an MCP host reads the
 * `.mcp.json` apm just wrote and spawns whatever it names.
 *
 * Nothing checked that, and the gap was not academic. A fresh consumer got a
 * `.mcp.json` naming `.claude/skills/odu/bin/serve` — a path `apm install` had
 * never written — so odu's agent face failed to spawn for every new adopter,
 * while this repo's own suite stayed green on a launcher that happened to be
 * COMMITTED here.
 *
 * ## Why the launcher is not under `bin/`
 *
 * apm deploys a skill's whole directory tree and skips exactly one path
 * segment: a top-level `bin/`, whenever stdout is not a tty. That is every CI
 * install and every `apm install` run from a script, and neither `apm approve`
 * nor `--trust-bin` lifts it for a project's OWN skills. So the launcher moved
 * to `.apm/skills/odu/serve`, where apm deploys it with its mode bit intact,
 * and `apm.yml` names `.agents/skills/odu/serve`. This file is what stops that
 * from silently regressing — a future apm that gated skill executables by MODE
 * rather than by directory name would break it again, invisibly, and only an
 * installation that is actually performed can notice.
 *
 * ## What the `nix` shim buys, and what it does not
 *
 * The deployed launcher's body is `exec nix run --accept-flake-config
 * github:juspay/odu -- mcp "$@"`, and there is deliberately no override knob —
 * a consumer that must pin odu pins the whole skill. So executing it honestly
 * would fetch and build upstream master inside a test. Instead a `nix` shim
 * goes first on PATH: it ASSERTS the exact argv and then execs the locally
 * built binary with the shim removed from PATH again (odu itself shells out to
 * `nix`, and a shim still shadowing it would break every run the service
 * starts).
 *
 * That proves the launcher invokes nix correctly, which is strictly more than
 * the regex it replaces. It does NOT prove `nix run github:juspay/odu`
 * resolves; a broken upstream flake would still ship. Accepted deliberately:
 * the alternative is a multi-minute network build inside an e2e.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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

/** What apm writes for a Claude consumer. */
interface McpConfig {
  mcpServers: Record<string, { command?: string; args?: string[] }>;
}

let oduBin: string;
/** The consumer's directory — outside this repo, because a consumer is. */
let consumer: string;
/** Where the `nix` shim lives, prepended to the launcher's PATH. */
let shimDir: string;
/** This gate's own state root and origin, so the daemon the launcher
 *  bootstraps is nobody else's. */
let stateDir: string;
let origin: string;
/** Read off the service the launcher started, so teardown reaps exactly it. */
let daemonHome: string | null = null;
let daemonPid: number | null = null;

/**
 * A consumer repository with ONE fact in it: a dependency on this checkout.
 *
 * `type: hybrid` because apm rejects anything else here — "Valid types are:
 * instructions, skill, hybrid, prompts" — and `targets: [claude]` because odu's
 * own `.grok/` makes target inference ambiguous, which apm refuses rather than
 * guesses at.
 */
function makeConsumer(): string {
  const dir = scratchDir("odu-e2e-consumer-");
  writeFileSync(
    join(dir, "apm.yml"),
    [
      "name: fresh-consumer",
      "version: 0.0.1",
      "type: hybrid",
      "targets:",
      "  - claude",
      "dependencies:",
      "  apm:",
      `    - path: ${publishable()}`,
      "",
    ].join("\n"),
  );
  return dir;
}

/** The checkout's TRACKED files, copied out — what a consumer would actually
 *  get, and the only shape apm can read.
 *
 *  apm resolves a `path:` dependency by copying the directory, and a working
 *  checkout is not copyable: while any run is live it holds `.ci/odu.sock`, a
 *  unix socket, and the copy dies with `[Errno 6] No such device or address`.
 *  This gate passes standalone and fails under `odu run` for that reason alone
 *  — which is to say it fails exactly when CI runs it, and passed every time
 *  anybody checked it by hand.
 *
 *  `git ls-files` is the right filter rather than an `.ci`-shaped exclusion: it
 *  is the set a consumer receives, it honours `.gitignore` (so `.ci/` and
 *  `node_modules/` go without being named), and it takes the WORKING TREE's
 *  contents — so an uncommitted edit to the skill under test is still what gets
 *  installed. */
function publishable(): string {
  const dir = scratchDir("odu-e2e-publishable-");
  const copied = spawnSync(
    "sh",
    ["-c", `git ls-files -z | tar --null -T - -cf - | tar -xf - -C '${dir}'`],
    { cwd: repoRoot, encoding: "utf-8", maxBuffer: BIG },
  );
  if (copied.status !== 0) {
    throw new Error(
      `e2e: could not export the checkout's tracked files: ${copied.stderr}`,
    );
  }
  return dir;
}

/**
 * `apm install`, exactly as a consumer's CI runs it — piped stdout, no tty.
 *
 * Deliberately NOT under a pty. The tty is the whole difference: apm's
 * executable gate skips a skill's `bin/` when stdout is not one, so a gate that
 * allocated a pty would test the case that already worked and miss the case
 * that broke every fresh install.
 */
function apmInstall(dir: string): void {
  const res = spawnSync("uvx", ["--from", "apm-cli", "apm", "install"], {
    cwd: dir,
    encoding: "utf-8",
    maxBuffer: BIG,
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(
      `e2e: \`apm install\` in ${dir} exited ${res.status}\n` +
        `--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
    );
  }
}

/**
 * A `nix` that refuses to be anything but the launcher's one call.
 *
 * An argv the launcher was not supposed to send is recorded and exits 97, so a
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
  consumer = makeConsumer();
  shimDir = scratchDir("odu-e2e-nixshim-");
  writeNixShim(shimDir);
  stateDir = scratchDir("odu-e2e-installstate-");
  mkdirSync(stateDir, { recursive: true });
  origin = `http://127.0.0.1:${suitePortFor("freshInstall")}`;
  // One install, not one per test: it resolves a package tree and reaches PyPI,
  // and it is the SUBJECT of all three assertions rather than a fixture for
  // each of them.
  apmInstall(consumer);
  // 900s: an `apm install` on a cold `~/.cache/uv` fetches apm-cli from PyPI
  // and has been measured at two minutes here, and the nix build in front of it
  // is minutes more.
}, 900_000);

afterAll(() => {
  if (daemonPid !== null) killDaemon(daemonPid);
  for (const dir of [consumer, shimDir, stateDir, daemonHome]) {
    if (dir === undefined || dir === null) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(`e2e: failed to remove ${dir}: ${String(err)}\n`);
    }
  }
  // 120s, not the 5s default: the consumer directory holds a whole resolved
  // `apm_modules/` tree, and removing it took longer than the hook was allowed
  // — which failed the FILE after every test in it had passed.
}, 120_000);

describe("a fresh consumer installing odu", () => {
  it("gets exactly one usable skill, with no manual cleanup", () => {
    const skills = join(consumer, ".claude", "skills");
    // EQUALITY. A second skill directory is a second vocabulary — that is what
    // the deleted `odu-mcp` was, and it came back through an unpinned
    // transitive `juspay/odu` until `apm.yml` declared the edge itself and
    // subsetted it. "Contains odu" would not have seen it.
    expect(readdirSync(skills).sort()).toEqual(["odu"]);

    const launcher = join(skills, "odu", "serve");
    expect(existsSync(launcher), `${launcher} was not deployed`).toBe(true);
    // Executable, because `.mcp.json` `exec`s it rather than running it through
    // a shell. A deployed file that lost its mode bit fails at spawn time with
    // an EACCES an MCP host reports as "server exited".
    expect(() => accessSync(launcher, constants.X_OK)).not.toThrow();
    expect(statSync(launcher).size).toBeGreaterThan(0);

    // NOT under `bin/`, and this is the assertion that names the cause: apm
    // skips a top-level `bin/` whenever stdout is not a tty. A launcher that
    // moved back there would deploy in a maintainer's terminal and vanish in
    // everybody's CI.
    expect(
      existsSync(join(skills, "odu", "bin")),
      "the skill grew a bin/ again — apm does not deploy it non-interactively",
    ).toBe(false);

    // And the skill itself is the authored one, byte for byte. A deploy that
    // rewrote it would mean consumers read something this repo does not review.
    expect(readFileSync(join(skills, "odu", "SKILL.md"), "utf-8")).toBe(
      readFileSync(join(repoRoot, ".apm/skills/odu/SKILL.md"), "utf-8"),
    );
  });

  it("gets an .mcp.json naming a launcher that is actually there", () => {
    const config = JSON.parse(
      readFileSync(join(consumer, ".mcp.json"), "utf-8"),
    ) as McpConfig;
    const odu = config.mcpServers.odu;
    expect(odu, "apm wrote no `odu` MCP server").toBeDefined();
    const command = odu?.command;
    expect(command, "the `odu` server has no command").toBeString();
    // THE DEFECT, stated as a test. `command` is relative and an MCP host
    // resolves it against the project root, so that is where this resolves it.
    // Before the launcher moved out of `bin/` this named a file apm had never
    // written, and every fresh consumer's odu server failed to spawn.
    const resolved = join(consumer, command as string);
    expect(existsSync(resolved), `${command} does not exist in the consumer`).toBe(
      true,
    );
    expect(() => accessSync(resolved, constants.X_OK)).not.toThrow();
    // The bridge addresses runs globally and takes its checkout as an explicit
    // path, so there is nothing for a host to pass it.
    expect(odu?.args ?? []).toEqual([]);
  });

  it("bootstraps a service and answers a tool call through that exact path", async () => {
    const config = JSON.parse(
      readFileSync(join(consumer, ".mcp.json"), "utf-8"),
    ) as McpConfig;
    const command = config.mcpServers.odu?.command as string;

    expect(
      await tcpListening(origin),
      "something is already serving this gate's origin",
    ).toBe(false);

    // Launched the way an MCP host launches it: the command from `.mcp.json`,
    // no args, cwd at the consumer's project root. Nothing here reaches for
    // `oduBin` — that path exists only inside the shim.
    const transport = new StdioClientTransport({
      command,
      args: [],
      cwd: consumer,
      env: {
        ...hermeticEnv,
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
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

      // ONE VOCABULARY, reached through an installed launcher. Equality: a face
      // a consumer installs that could do one more thing than the browser can
      // is the second face growing back where nobody would look for it.
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual([...SHARED_TOOLS]);

      // COLD BOOTSTRAP THROUGH THE INSTALLED PATH. Nothing set a service up;
      // answering this at all is the launcher having started one.
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
      // The shim's own verdict on the launcher, checked last so an argv
      // regression reports what was run rather than a connect that timed out.
      const offending = join(shimDir, "nix.argv");
      if (existsSync(offending)) {
        throw new Error(
          "e2e: the installed launcher did not invoke nix the way the skill " +
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
