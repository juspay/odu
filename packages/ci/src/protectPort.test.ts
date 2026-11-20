import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghForge } from "@odu/execution/common/forge";
import { LOCAL_OWNER } from "@odu/cordis/principal";
import { protectBranch } from "./protectPort";

const protect = protectBranch(ghForge());

const trash: string[] = [];
const GH_WAS = process.env.ODU_GH_BIN;
const HOSTS_WAS = process.env.ODU_HOSTS;

afterEach(() => {
  for (const dir of trash.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, was] of [
    ["ODU_GH_BIN", GH_WAS],
    ["ODU_HOSTS", HOSTS_WAS],
  ] as const) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trash.push(dir);
  return dir;
}

const JUSTFILE = `[metadata("ci")]
default: alpha beta

alpha:
    echo alpha

beta: alpha
    echo beta
`;

const SLUG = "odu-unit-fixture/absent-repo";

function checkout(opts: { origin?: string; justfile?: string } = {}): string {
  const dir = temp("odu-protect-port-");
  if (opts.justfile !== "") {
    writeFileSync(join(dir, "justfile"), opts.justfile ?? JUSTFILE);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (opts.origin !== undefined) {
    execFileSync("git", ["remote", "add", "origin", opts.origin], { cwd: dir });
  }
  return dir;
}

function hosts(config: Record<string, unknown>): string {
  const file = join(temp("odu-protect-hosts-"), "hosts.json");
  writeFileSync(file, JSON.stringify(config));
  process.env.ODU_HOSTS = file;
  return file;
}

function fakeGh(
  mode: "ok" | "unauthenticated" | "absent",
  opts: { branchRules?: unknown; ruleset?: unknown } = {},
): { calls: () => string[] } {
  const dir = temp("odu-protect-gh-");
  const at = (name: string): string => join(dir, name);
  if (mode === "absent") {
    process.env.ODU_GH_BIN = at("nothing-is-here");
    return { calls: () => [] };
  }
  writeFileSync(at("calls.txt"), "");
  writeFileSync(at("branch-rules.json"), JSON.stringify(opts.branchRules ?? []));
  writeFileSync(at("ruleset.json"), JSON.stringify(opts.ruleset ?? {}));
  const body =
    mode === "unauthenticated"
      ? `printf 'To get started with GitHub CLI, please run: gh auth login\\n' >&2; exit 4`
      : `case "$*" in
  *"--method PUT"*) printf '{}\\n' ;;
  *"--method POST"*) printf '{"id":777,"name":"odu: required checks","target":"branch","enforcement":"active"}\\n' ;;
  *"--jq .default_branch"*) printf 'master\\n' ;;
  *"/rules/branches/"*) cat '${at("branch-rules.json")}' ;;
  *"/rulesets/"*) cat '${at("ruleset.json")}' ;;
  *) printf 'fake gh: unexpected call: %s\\n' "$*" >&2; exit 1 ;;
esac`;
  const bin = at("gh");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${at("calls.txt")}'\n${body}\n`);
  chmodSync(bin, 0o755);
  process.env.ODU_GH_BIN = bin;
  return {
    calls: () =>
      readFileSync(at("calls.txt"), "utf-8")
        .split("\n")
        .filter((l) => l !== ""),
  };
}

const LINUX = ["x86_64-linux"];

describe("protectBranch refusals", () => {
  it("refuses a path that is not a git checkout, naming it", async () => {
    const bare = temp("odu-protect-bare-");
    const outcome = await protect({
      checkout: bare,
      platforms: LINUX,
      caller: { hostsFile: null, principal: LOCAL_OWNER },
      dryRun: true,
      create: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("checkout_refused");
    expect(outcome.message).toContain(bare);
  });

  it("refuses a checkout whose justfile does not resolve, with the ENGINE's sentence", async () => {
    const outcome = await protect({
      checkout: checkout({ justfile: "alpha:\n    echo hi\n" }),
      platforms: LINUX,
      caller: { hostsFile: null, principal: LOCAL_OWNER },
      dryRun: true,
      create: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("pipeline_refused");
    expect(outcome.message).toContain("metadata");
  });

  it("refuses a platform set that resolves to nothing, naming the empty file", async () => {
    const file = hosts({});
    const outcome = await protect({
      checkout: checkout(),
      platforms: [],
      caller: { hostsFile: null, principal: LOCAL_OWNER },
      dryRun: true,
      create: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("bad_input");
    expect(outcome.message).toContain(file);
    expect(outcome.suggestion).toEqual([
      "odu",
      "ci",
      "protect",
      "--platform",
      "x86_64-linux",
    ]);
  });

  it("refuses a blank platform instead of fanning out `recipe@` contexts", async () => {
    const outcome = await protect({
      checkout: checkout(),
      platforms: [""],
      caller: { hostsFile: null, principal: LOCAL_OWNER },
      dryRun: true,
      create: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("bad_input");
  });

  it("refuses an origin that is not github.com — when it is about to write", async () => {
    const outcome = await protect({
      checkout: checkout({ origin: "git@gitlab.com:someone/thing.git" }),
      platforms: LINUX,
      caller: { hostsFile: null, principal: LOCAL_OWNER },
      dryRun: false,
      create: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("checkout_refused");
  });

  it("refuses `no_credential` when gh cannot authenticate, with an ARGV recovery", async () => {
    fakeGh("unauthenticated");
    const outcome = await protect({
      checkout: checkout({ origin: `https://github.com/${SLUG}` }),
      platforms: LINUX,
      caller: { hostsFile: null, principal: LOCAL_OWNER },
      dryRun: false,
      create: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("no_credential");
    expect(outcome.suggestion).toEqual(["gh", "auth", "login"]);
  });

  it("refuses `no_credential` when there is no gh at all — the daemon's own case", async () => {
    fakeGh("absent");
    const outcome = await protect({
      checkout: checkout({ origin: `https://github.com/${SLUG}` }),
      platforms: LINUX,
      caller: { hostsFile: null, principal: LOCAL_OWNER },
      dryRun: false,
      create: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("no_credential");
    expect(outcome.suggestion).toEqual(["gh", "auth", "login"]);
  });

  it("refuses an unruled branch unless creating was asked for, and says how", async () => {
    fakeGh("ok", { branchRules: [] });
    const outcome = await protect({
      checkout: checkout({ origin: `https://github.com/${SLUG}` }),
      branch: "master",
      platforms: LINUX,
      caller: { hostsFile: null, principal: LOCAL_OWNER },
      dryRun: false,
      create: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("bad_input");
    expect(outcome.suggestion).toEqual(["odu", "ci", "protect", "--create"]);
  });
});

const RULESET = {
  id: 20468764,
  name: "master: PRs + green CI",
  target: "branch",
  source_type: "Repository",
  source: SLUG,
  enforcement: "active",
  conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } },
  bypass_actors: [],
  rules: [
    { type: "pull_request", parameters: { required_approving_review_count: 0 } },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: false,
        required_status_checks: [{ context: "build-and-test (ubuntu-latest)" }],
      },
    },
  ],
};

const RULES_ON_MASTER = RULESET.rules.map((rule) => ({
  type: rule.type,
  ruleset_source_type: "Repository",
  ruleset_source: SLUG,
  ruleset_id: RULESET.id,
}));

describe("protectBranch successes", () => {
  it("previews the contexts without asking the forge anything at all", async () => {
    const gh = fakeGh("ok");
    const outcome = await protect({
      checkout: checkout({ origin: `https://github.com/${SLUG}` }),
      platforms: ["x86_64-linux", "aarch64-darwin"],
      caller: { hostsFile: null, principal: LOCAL_OWNER },
      dryRun: true,
      create: false,
    });
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
    expect([...outcome.facts.contexts].sort()).toEqual([
      "alpha@aarch64-darwin",
      "alpha@x86_64-linux",
      "beta@aarch64-darwin",
      "beta@x86_64-linux",
    ]);
    expect(outcome.facts.repo).toBeNull();
    expect(outcome.facts.branch).toBeNull();
    expect(outcome.facts.applied).toBe(false);
    expect(outcome.facts.created).toBe(false);
    expect(outcome.facts.rulesetId).toBeNull();
    expect(outcome.facts.derivedFrom).toBeNull();
    expect(gh.calls()).toEqual([]);
  });

  it("previews in a checkout with no origin remote at all", async () => {
    fakeGh("ok");
    const outcome = await protect({
      checkout: checkout({}),
      platforms: ["x86_64-linux"],
      caller: { hostsFile: null, principal: LOCAL_OWNER },
      dryRun: true,
      create: false,
    });
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
    expect([...outcome.facts.contexts].sort()).toEqual([
      "alpha@x86_64-linux",
      "beta@x86_64-linux",
    ]);
  });

  it("reports a hosts-derived platform set in derivedFrom, not on stderr", async () => {
    const file = hosts({ "x86_64-linux": "some-box" });
    fakeGh("ok");
    const outcome = await protect({
      checkout: checkout({ origin: `https://github.com/${SLUG}` }),
      branch: "master",
      platforms: [],
      caller: { hostsFile: null, principal: LOCAL_OWNER },
      dryRun: true,
      create: false,
    });
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
    expect(outcome.facts.derivedFrom).toBe(file);
    expect([...outcome.facts.contexts].sort()).toEqual([
      "alpha@x86_64-linux",
      "beta@x86_64-linux",
    ]);
  });

  it("writes the existing ruleset, reporting which one carries the contexts", async () => {
    const gh = fakeGh("ok", {
      branchRules: RULES_ON_MASTER,
      ruleset: RULESET,
    });
    const outcome = await protect({
      checkout: checkout({ origin: `https://github.com/${SLUG}` }),
      branch: "master",
      platforms: LINUX,
      caller: { hostsFile: null, principal: LOCAL_OWNER },
      dryRun: false,
      create: false,
    });
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
    expect(outcome.facts.applied).toBe(true);
    expect(outcome.facts.created).toBe(false);
    expect(outcome.facts.rulesetId).toBe(RULESET.id);
    expect(gh.calls().some((c) => c.includes("--method PUT"))).toBe(true);
    expect(gh.calls().some((c) => c.includes(".default_branch"))).toBe(false);
  });

  it("creates a ruleset when asked, and says a merge gate now exists", async () => {
    const gh = fakeGh("ok", { branchRules: [] });
    const outcome = await protect({
      checkout: checkout({ origin: `https://github.com/${SLUG}` }),
      branch: "master",
      platforms: LINUX,
      caller: { hostsFile: null, principal: LOCAL_OWNER },
      dryRun: false,
      create: true,
    });
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
    expect(outcome.facts.created).toBe(true);
    expect(outcome.facts.applied).toBe(true);
    expect(outcome.facts.rulesetId).toBe(777);
    expect(outcome.facts.detail).toContain("nobody bypasses it");
    expect(gh.calls().some((c) => c.includes("--method POST"))).toBe(true);
  });
});
