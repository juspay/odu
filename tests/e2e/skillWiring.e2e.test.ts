/**
 * ONE SKILL, ONE LAUNCHER — asserted against this repo's own committed tree.
 *
 * odu's agent face used to be two authored skills: `odu` for the runner and
 * `odu-mcp` for a second MCP face with nine tools of its own. That second face
 * is gone, and merging the skills is not a tidy-up — while two existed, an agent
 * could read either one and reach a different vocabulary, which is the same
 * "two answers to one question" problem the service consolidation exists to
 * remove, moved one layer out into the documentation.
 *
 * ## What this file checks, and what it deliberately does not
 *
 * These are STATIC checks over the tree a maintainer commits: the authored
 * skill, the deployed copy `just apm` regenerates, and the `.mcp.json` that
 * names it. They are cheap and they run everywhere.
 *
 * They are not, and were never, an installation gate. That distinction is not
 * pedantry — it is the exact shape of a defect that shipped. This file used to
 * assert that `.claude/skills/odu/bin/serve` existed and was executable, and it
 * passed, because that file was COMMITTED here by hand. Meanwhile a fresh
 * consumer running `apm install` got a `.mcp.json` naming that path and no file
 * at it, and odu's agent face failed to spawn for every new adopter. A test
 * that reads a repository can only ever tell you about that repository.
 * `tests/e2e/install.e2e.test.ts` performs a real installation, and it is what
 * actually gates first contact.
 *
 * ## The claim this file used to make, which was false
 *
 * It said "apm-cli deploys a skill's `SKILL.md` and NOT the rest of its
 * directory", and concluded that the launcher therefore had to be hand-copied
 * and committed. That is not how apm works and it sent the next reader in
 * exactly the wrong direction. apm deploys a skill's WHOLE directory tree; the
 * only thing it ever skips is a top-level `bin/`, and only when stdout is not a
 * tty — which is every CI install and every `apm install` run from a script.
 * Neither `apm approve` nor `--trust-bin` lifts that for a project's own
 * skills. The launcher was under `bin/`, so it was the one file apm would not
 * place. It lives at `.apm/skills/odu/serve` now, apm deploys it with its mode
 * bit intact, and there is nothing left to copy by hand.
 */

import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { SHARED_TOOLS } from "./webHarness";

const repoRoot = join(import.meta.dirname, "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf-8");

/** The authored launcher, and the copy `just apm` deploys from it. NOT under
 *  `bin/`, which is the one path segment apm skips non-interactively. */
const AUTHORED = ".apm/skills/odu/serve";
const DEPLOYED = ".claude/skills/odu/serve";

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

  it("has that launcher on disk, executable, and out of `bin/`", () => {
    const path = join(repoRoot, DEPLOYED);
    expect(existsSync(path), `${DEPLOYED} is missing`).toBe(true);
    // Executable, because `.mcp.json` `exec`s it rather than running it through
    // a shell. A file that lost its mode bit fails at spawn time with an EACCES
    // an MCP host reports as "server exited".
    expect(() => accessSync(path, constants.X_OK)).not.toThrow();
    expect(statSync(path).size).toBeGreaterThan(0);

    // NEITHER HALF MAY MOVE BACK UNDER `bin/`. Both are asserted because they
    // fail differently and only one of them is loud: an authored `bin/serve`
    // silently stops being deployed to consumers, while a deployed `bin/serve`
    // is the stale hand-copy this repo used to carry.
    for (const stale of [".apm/skills/odu/bin", ".claude/skills/odu/bin"]) {
      expect(
        existsSync(join(repoRoot, stale)),
        `${stale} exists — apm does not deploy a skill's bin/ when stdout is not a tty`,
      ).toBe(false);
    }
  });

  it("keeps the deployed copy identical to the authored source", () => {
    // Both files are committed, and only one of them is edited: `.claude/` is
    // apm's output and `just apm` regenerates it. A difference here means the
    // authored launcher changed and the deploy was never re-run, so what a
    // reviewer read and what an MCP host would execute are two different files.
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
    // The exact argv is EXECUTED in `install.e2e.test.ts`, under a `nix` shim
    // that records anything else. These patterns are the cheap first line; that
    // one is the assertion that would catch a rewrite these regexes still like.
  });

  it("leaves no odu-mcp skill anywhere", () => {
    // Both halves: the authored source and the deployed copy. The deployed one
    // was the trap. `juspay/kolu/agents` declares an unpinned `juspay/odu`, so
    // odu arrived back at depth 2 from published master — which still carries
    // the deleted `odu-mcp` skill — and `just apm` re-deployed a second
    // vocabulary into `.claude/skills/` every time it ran. That used to be
    // documented here as "expected locally, must never be committed", which is
    // a defect written down rather than fixed: nothing stopped the commit.
    //
    // `apm.yml` now declares the `juspay/odu` edge directly and subsets it to
    // `skills: [odu]`, so the direct edge wins the resolution and the second
    // skill cannot be deployed at all. Hence an unconditional assertion.
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
    // The DECLARATIONS, with the comments stripped. `odu-mcp` is named at
    // length in a comment — the one explaining why the transitive edge that
    // re-deployed it had to be beaten — and a check that could not tell a
    // declaration from an explanation would push the next reader into deleting
    // the explanation to make the test pass.
    const declared = manifest
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(manifest).toContain(".apm/skills/odu/");
    expect(declared).not.toContain("odu-mcp");
    // The launcher travels INSIDE the skill, at the top of it rather than in a
    // `bin/` apm would skip. `.agents/` is apm's target-agnostic spelling,
    // which it rewrites per harness on deploy.
    expect(declared).toContain(".agents/skills/odu/serve");
    expect(declared).not.toContain(".agents/skills/odu/bin/");

    // THE SUBSET THAT KEEPS `odu-mcp` GONE, asserted so that deleting it fails
    // here with a sentence instead of silently restoring a second vocabulary on
    // whoever next runs `just apm`. odu depending on itself is surprising, and
    // an unexplained deletion of a surprising line is the likeliest way this
    // regresses.
    expect(
      declared,
      "apm.yml no longer declares the juspay/odu edge — the unpinned transitive one wins again",
    ).toContain("git: juspay/odu");
    expect(
      declared.slice(declared.indexOf("git: juspay/odu")),
      "the juspay/odu edge is no longer subsetted to `skills: [odu]`",
    ).toMatch(/skills:\s*\n\s*- odu\b/);
  });

  it("teaches one vocabulary in the skill it does publish", () => {
    const skill = read(".apm/skills/odu/SKILL.md");
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

  it("teaches the launcher's real installed path", () => {
    const skill = read(".apm/skills/odu/SKILL.md");
    // A skill that documented `bin/serve` would be telling a consumer to wire
    // an MCP server at a path apm does not create — which is the defect, stated
    // in prose instead of in a config file.
    expect(skill).toContain(".claude/skills/odu/serve");
    expect(skill, "the skill still points at a bin/ launcher").not.toContain(
      "skills/odu/bin/serve",
    );
  });
});
