/**
 * ONE SKILL, ONE LAUNCHER — asserted against the tree a consumer actually gets.
 *
 * odu's agent face used to be two authored skills: `odu` for the runner and
 * `odu-mcp` for a second MCP face with nine tools of its own. That second face
 * is gone, and merging the skills is not a tidy-up — while two existed, an agent
 * could read either one and reach a different vocabulary, which is the same
 * "two answers to one question" problem the service consolidation exists to
 * remove, moved one layer out into the documentation.
 *
 * ## Why this is a test and not a checklist
 *
 * The wiring has three parts that are edited in three different files by three
 * different mechanisms, and two of them are GENERATED:
 *
 *   - `.apm/skills/odu/bin/serve` is the authored launcher;
 *   - `.claude/skills/odu/bin/serve` is the deployed copy an MCP host executes;
 *   - `.mcp.json` names that second path.
 *
 * Nothing checks that those three agree. Worse, apm-cli deploys a skill's
 * `SKILL.md` and NOT the rest of its directory — the previous launcher was
 * placed under `.claude/` by hand and committed, and it appears nowhere in
 * `apm.lock.yaml`'s `deployed_files`. So `just apm` will neither create the new
 * launcher nor prune the old one, and a rename that forgot either half would
 * leave `.mcp.json` pointing at a path that does not exist — discovered by
 * whoever next started an agent, as an MCP server that fails to spawn.
 *
 * This is the reviewer's asked-for installation check: the path MCP
 * configuration references, verified to exist, be executable, and launch the
 * shared-service bridge unpinned from upstream.
 */

import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const repoRoot = join(import.meta.dirname, "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf-8");

const AUTHORED = ".apm/skills/odu/bin/serve";
const DEPLOYED = ".claude/skills/odu/bin/serve";

describe("the odu skill's MCP wiring", () => {
  it("names one launcher in .mcp.json, and it is the deployed one", () => {
    const config = JSON.parse(read(".mcp.json")) as {
      mcpServers: Record<string, { command?: string; args?: string[] }>;
    };
    const odu = config.mcpServers.odu;
    expect(odu, ".mcp.json has no `odu` MCP server").toBeDefined();
    expect(odu?.command).toBe(DEPLOYED);
    // The bridge addresses runs globally and takes its checkout as an explicit
    // path, so there is nothing for a host to pass it. An argv that grew here
    // would be a per-host difference in a face whose whole point is that there
    // is only one.
    expect(odu?.args ?? []).toEqual([]);
  });

  it("has that launcher on disk, executable", () => {
    const path = join(repoRoot, DEPLOYED);
    expect(existsSync(path), `${DEPLOYED} is missing`).toBe(true);
    // Executable, because `.mcp.json` `exec`s it rather than running it through
    // a shell. A committed file that lost its mode bit fails at spawn time with
    // an EACCES an MCP host reports as "server exited".
    expect(() => accessSync(path, constants.X_OK)).not.toThrow();
    expect(statSync(path).size).toBeGreaterThan(0);
  });

  it("keeps the deployed copy identical to the authored source", () => {
    // apm-cli deploys `SKILL.md` and nothing else in a skill directory, so this
    // copy is maintained by hand — which is exactly why it needs an assertion
    // rather than a convention.
    expect(read(DEPLOYED)).toBe(read(AUTHORED));
  });

  it("launches the shared-service bridge, unpinned from upstream", () => {
    const script = read(AUTHORED);
    // UNPINNED by default: the agent face tracks upstream rather than ageing
    // behind a consumer-side pin.
    expect(script).toContain("github:juspay/odu");
    // Bare `odu mcp` IS the shared-service bridge now. `--service` would be the
    // deprecated spelling and must not be what a fresh install runs.
    expect(script).toMatch(/--\s+mcp\b/);
    expect(script).not.toContain("--service");
    // NO pin-override knob. `ODU_FLAKE` used to let a consumer point this at a
    // pinned output of their own, which is a second supported build reachable
    // by environment variable — an alternate adoption route, and the review
    // asked for those to go. It may still be NAMED in the comment that explains
    // its removal, so this asserts it is not read by the command.
    expect(script).not.toMatch(/\$\{?ODU_FLAKE/);
    // The trust prompt an MCP host cannot answer.
    expect(script).toContain("--accept-flake-config");
    // Nix is the only supported runtime; a launcher reaching for bun or a
    // source entry point would be a second way to run odu.
    expect(script).not.toMatch(/\bbun\b/);
    expect(script).toContain("set -euo pipefail");
  });

  it("leaves no odu-mcp skill anywhere", () => {
    // Both halves: the authored source and the deployed copy. The deployed one
    // is the trap — apm's cleanup refuses to remove a skill directory holding a
    // file it does not own, and the transitive `juspay/odu` self-dependency
    // re-deploys the old skill until that published commit moves. So a stray
    // `.claude/skills/odu-mcp/` after `just apm` is expected locally and must
    // never be committed: a second skill is a second vocabulary.
    for (const stale of [
      ".apm/skills/odu-mcp",
      ".claude/skills/odu-mcp",
    ]) {
      expect(existsSync(join(repoRoot, stale)), `${stale} still exists`).toBe(
        false,
      );
    }
  });

  it("publishes exactly one skill to consumers", () => {
    const manifest = read("apm.yml");
    expect(manifest).toContain(".apm/skills/odu/");
    expect(manifest).not.toContain("odu-mcp");
    // The launcher travels INSIDE the skill now, so the consumer-side command
    // is a path under it. `.agents/` is apm's target-agnostic spelling, which it
    // rewrites per harness on deploy.
    expect(manifest).toContain(".agents/skills/odu/bin/serve");
  });

  it("teaches one vocabulary in the skill it does publish", () => {
    const skill = read(".apm/skills/odu/SKILL.md");
    // The five shared verbs, which is the whole public vocabulary.
    for (const verb of [
      "run_start",
      "run_wait",
      "run_retry",
      "run_cancel",
      "log_read",
    ]) {
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
});
