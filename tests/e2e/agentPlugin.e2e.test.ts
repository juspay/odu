/**
 * ONE PLUGIN, ONE SKILL, ONE MCP SERVER — asserted against this repo's tree.
 *
 * odu's agent face is an Agent Plugin (https://agent-plugins.org/, spec 1.0.0)
 * rooted at `agent-plugin/`: a `plugin.json`, the `odu` skill under `skills/`,
 * and the `odu` MCP server in `mcp.json`. odu's own `plugin.json` profile
 * loads that very directory rather than a copy of it.
 *
 * ## What this file checks, and what it deliberately does not
 *
 * These are STATIC checks over the committed tree: the manifests are shaped the
 * way the spec requires, the profile loads them, and the skill teaches the one
 * vocabulary. They are cheap and run everywhere. They are not a loading gate —
 * `install.e2e.test.ts` loads the exported plugin the way a client does and
 * drives a real tool call through it.
 *
 * odu's agent face used to be two authored skills, `odu` and `odu-mcp`; while
 * two existed, an agent could read either and reach a different vocabulary.
 * Hence the insistence on exactly one of each below.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { SHARED_TOOLS } from "./webHarness";

const repoRoot = join(import.meta.dirname, "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf-8");
const readJson = <T>(rel: string): T => JSON.parse(read(rel)) as T;

const PLUGIN = "agent-plugin";
const SKILL = `${PLUGIN}/skills/odu/SKILL.md`;
const SPEC = "https://agent-plugins.org/schemas/1.0.0";

interface McpConfig {
  $schema?: string;
  mcpServers: Record<string, { type?: string; command?: string; args?: string[] }>;
}

/** The one command odu's MCP face is launched with, everywhere it is named:
 *  upstream master, unpinned, through Nix. `--accept-flake-config` because
 *  odu's flake declares a binary cache, and without it `nix run` stops on a
 *  trust prompt no MCP host can answer. */
const ODU_SERVER = {
  type: "stdio",
  command: "nix",
  args: ["run", "--accept-flake-config", "github:juspay/odu", "--", "mcp"],
};

describe("odu's Agent Plugin", () => {
  it("has a conformant plugin.json", () => {
    const manifest = readJson<Record<string, unknown>>(`${PLUGIN}/plugin.json`);
    expect(manifest.$schema).toBe(`${SPEC}/plugin.schema.json`);
    expect(manifest.name).toBe("odu");
    // The spec's manifest schema is CLOSED. An unknown field is reported and
    // ignored by a conformant client, which is a silent no-op for whoever
    // added it — so it is refused here instead.
    const allowed = [
      "$schema",
      "name",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
      "extensions",
    ];
    for (const key of Object.keys(manifest)) {
      expect(allowed, `plugin.json has a non-spec field "${key}"`).toContain(key);
    }
  });

  it("declares exactly one MCP server, and it is the shared-service bridge", () => {
    const config = readJson<McpConfig>(`${PLUGIN}/mcp.json`);
    // The spec requires mcp.json to target the same version as plugin.json, or
    // a client disables MCP for the whole plugin.
    expect(config.$schema).toBe(`${SPEC}/mcp.schema.json`);
    expect(Object.keys(config).sort()).toEqual(["$schema", "mcpServers"]);
    expect(Object.keys(config.mcpServers)).toEqual(["odu"]);
    // `command` is a single bare token and the rest is `args`: the spec forbids
    // a shell string, and Nix is the only supported runtime — a server reaching
    // for bun or a source entry point would be a second way to run odu.
    expect(config.mcpServers.odu).toEqual(ODU_SERVER);
  });

  it("is what odu's own profile loads, not a copy of it", () => {
    // Maintainers get the published plugin exactly as consumers do, plus the
    // maintainer-only `dev/` plugin — which is its own package, so nothing in it
    // can ride along into `agent-plugin/`. The root manifest is a plugin too: its
    // name must not collide with `agent-plugin`'s `odu`.
    const profile = readJson<{ name: string; extensions: Record<string, { plugins: string[] }> }>("plugin.json");
    expect(profile.name).toBe("odu-maintainers");
    expect(profile.extensions["asia.nixos.agent-distro"].plugins).toEqual(["./agent-plugin", "./dev"]);
    const dev = readJson<Record<string, unknown>>("dev/plugin.json");
    expect(dev.$schema).toBe(`${SPEC}/plugin.schema.json`);
    expect(dev.name).toBe("odu-dev");
  });

  it("publishes exactly one skill", () => {
    // EQUALITY. A second skill directory is a second vocabulary — that is what
    // the deleted `odu-mcp` was. "Contains odu" would not have seen it.
    expect(readdirSync(join(repoRoot, PLUGIN, "skills")).sort()).toEqual(["odu"]);
  });

  it("teaches one vocabulary in the skill it does publish", () => {
    const skill = read(SKILL);
    // THE WHOLE SHARED VOCABULARY, from the same list the MCP faces are
    // asserted against. A verb that reached the contract without reaching the
    // skill is a capability an agent has and cannot find, which is the same
    // failure as not having it — and the list grew from five to thirteen
    // precisely by people adding to one and not the other.
    for (const verb of SHARED_TOOLS) {
      expect(skill, `the skill never mentions ${verb}`).toContain(verb);
    }
    // Nothing deleted may still be TAUGHT — but the skill is allowed, and
    // expected, to NAME what is gone in its closing removal notice. An agent
    // arriving with stale knowledge of the nine tools is better served by being
    // told they no longer exist than by their silent absence, so the two are
    // different things and the check has to tell them apart. Everything before
    // "## What changed" is instruction; the notice below it is history.
    const marker = "## What changed";
    expect(skill, "the skill has no removal notice").toContain(marker);
    const teaches = skill.slice(0, skill.indexOf(marker));
    const notice = skill.slice(skill.indexOf(marker));
    for (const gone of [
      "wait_for_settle",
      "node_rerun",
      "node_cancel",
      "lane_cancel",
      ".ci/odu.sock",
      "bun run start",
      "odu mcp --service",
      "odu runs",
      "--linger",
    ]) {
      expect(teaches, `the skill still teaches "${gone}", which no longer exists`)
        .not.toContain(gone);
    }
    // And the notice must actually say the nine tools are gone, rather than
    // leaving an agent to discover it as a tool that is not there.
    for (const named of ["wait_for_settle", "node_rerun", "odu runs"]) {
      expect(notice, `the removal notice never mentions ${named}`).toContain(
        named,
      );
    }
  });

  it("teaches the MCP command the plugin actually ships", () => {
    // A skill documenting a different launch than `mcp.json` declares would be
    // telling a hand-configuring user to wire something no client runs.
    expect(read(SKILL)).toContain(
      "nix run --accept-flake-config github:juspay/odu -- mcp",
    );
  });
});
