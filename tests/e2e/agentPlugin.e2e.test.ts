import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { SHARED_TOOLS } from "./webHarness";

const repoRoot = join(import.meta.dirname, "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf-8");
const readJson = <T>(rel: string): T => JSON.parse(read(rel)) as T;

const PLUGIN = ".";
const SKILL = "skills/odu/SKILL.md";
const SPEC = "https://agent-plugins.org/schemas/1.0.0";

interface McpConfig {
  $schema?: string;
  mcpServers: Record<string, { type?: string; command?: string; args?: string[] }>;
}

const ODU_SERVER = {
  type: "stdio",
  command: "nix",
  args: ["run", "--accept-flake-config", "github:juspay/odu", "--", "mcp"],
};

describe("odu's Agent Plugin", () => {
  it("has a conformant plugin.json at the repository root", () => {
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

  it("is the plugin odu's own profile publishes, with only dev/ added", () => {
    const profile = readJson<{
      name: string;
      extensions: Record<string, { plugins: string[] }>;
    }>("plugin.json");
    expect(profile.name).toBe("odu");
    expect(profile.extensions["asia.nixos.agent-distro"]?.plugins).toEqual(["./dev"]);
    const dev = readJson<Record<string, unknown>>("dev/plugin.json");
    expect(dev.$schema).toBe(`${SPEC}/plugin.schema.json`);
    expect(dev.name).toBe("odu-dev");
  });

  it("publishes exactly one skill", () => {
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
    for (const named of ["wait_for_settle", "node_rerun", "odu runs"]) {
      expect(notice, `the removal notice never mentions ${named}`).toContain(
        named,
      );
    }
  });

  it("teaches the MCP command the plugin actually ships", () => {
    expect(read(SKILL)).toContain(
      "nix run --accept-flake-config github:juspay/odu -- mcp",
    );
  });
});
