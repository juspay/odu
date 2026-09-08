/**
 * PROTECT AS A VALUE — the four refusals, and what a success reports.
 *
 * `protectCommand` used to answer with an exit code and a paragraph on stderr,
 * which is the whole reason it could only ever be run by a person at a
 * terminal. A browser cannot branch on prose. So every `stderr; return 1` here
 * became one of four codes, and the codes are the four DIFFERENT things an
 * operator has to do: fix the checkout, fix the justfile, log in, or say which
 * platforms. A suite that only checked `ok === false` would not notice them
 * collapsing back into one.
 *
 * `gh` is faked at the `$ODU_GH_BIN` seam rather than by stubbing a module, for
 * the reason the e2e suite gives: the argv the fake records is exactly the argv
 * that would have reached GitHub. It also means these tests can express "your
 * credential is not there", which is the refusal the daemon made newly reachable
 * — the daemon is where `gh` now runs, and a daemon that cannot find it must
 * say so with a recovery rather than fail as a 500.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectBranch } from "./protectPort";

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

/** A checkout with a resolvable DAG, optionally with an `origin`. */
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

/** Point `loadHosts` somewhere hermetic — the dev machine's own hosts file must
 *  never decide which platforms a test protects. */
function hosts(config: Record<string, unknown>): string {
  const file = join(temp("odu-protect-hosts-"), "hosts.json");
  writeFileSync(file, JSON.stringify(config));
  process.env.ODU_HOSTS = file;
  return file;
}

/**
 * Install a stand-in `gh`. `mode` picks how it answers:
 *  - `ok`: the reads GitHub would answer, and captured writes;
 *  - `unauthenticated`: what `gh` prints when nobody is logged in;
 *  - `absent`: no binary at all, which is the daemon's own failure mode.
 */
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
      execFileSync("cat", [at("calls.txt")], { encoding: "utf-8" })
        .split("\n")
        .filter((l) => l !== ""),
  };
}

const LINUX = ["x86_64-linux"];

describe("protectBranch refusals", () => {
  it("refuses a path that is not a git checkout, naming it", async () => {
    const bare = temp("odu-protect-bare-");
    const outcome = await protectBranch({
      checkout: bare,
      platforms: LINUX,
      hostsFile: null,
      dryRun: true,
      create: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("checkout_refused");
    expect(outcome.message).toContain(bare);
  });

  it("refuses a checkout whose justfile does not resolve, with the ENGINE's sentence", async () => {
    // `pipeline_refused` and not `checkout_refused`: the directory is fine, the
    // DAG is not — and the required contexts ARE the DAG, so there is nothing
    // to protect against. `just` names the recipe; this layer could not.
    const outcome = await protectBranch({
      checkout: checkout({ justfile: "alpha:\n    echo hi\n" }),
      platforms: LINUX,
      hostsFile: null,
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
    const outcome = await protectBranch({
      checkout: checkout(),
      platforms: [],
      hostsFile: null,
      dryRun: true,
      create: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("bad_input");
    // An empty-but-PRESENT hosts file is diagnosed as such, rather than told to
    // configure the one it already has.
    expect(outcome.message).toContain(file);
    expect(outcome.suggestion).toEqual([
      "odu",
      "protect",
      "--platform",
      "x86_64-linux",
    ]);
  });

  it("refuses a blank platform instead of fanning out `recipe@` contexts", async () => {
    const outcome = await protectBranch({
      checkout: checkout(),
      platforms: [""],
      hostsFile: null,
      dryRun: true,
      create: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("bad_input");
  });

  it("refuses an origin that is not github.com — when it is about to write", async () => {
    // `dryRun: false` is load-bearing. A dry run never asks the forge anything,
    // so it has no origin to object to and answers happily in a repository
    // hosted anywhere or nowhere. The refusal belongs to the WRITE, which is
    // the only part that needs a GitHub API to exist.
    const outcome = await protectBranch({
      checkout: checkout({ origin: "git@gitlab.com:someone/thing.git" }),
      platforms: LINUX,
      hostsFile: null,
      dryRun: false,
      create: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("checkout_refused");
  });

  it("refuses `no_credential` when gh cannot authenticate, with an ARGV recovery", async () => {
    fakeGh("unauthenticated");
    const outcome = await protectBranch({
      checkout: checkout({ origin: `https://github.com/${SLUG}` }),
      platforms: LINUX,
      hostsFile: null,
      dryRun: false,
      create: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("no_credential");
    // ARGV, never a string a face could be tempted to eval or a shell to glob.
    expect(outcome.suggestion).toEqual(["gh", "auth", "login"]);
  });

  it("refuses `no_credential` when there is no gh at all — the daemon's own case", async () => {
    // The failure the `GH_TOKEN`/`GH_HOST`/`GH_CONFIG_DIR` forwarding exists to
    // prevent. It is the same refusal as "not logged in" on purpose: both mean
    // "this process cannot speak to GitHub as you", and they are told apart by
    // the message rather than by a code nobody would branch on differently.
    fakeGh("absent");
    const outcome = await protectBranch({
      checkout: checkout({ origin: `https://github.com/${SLUG}` }),
      platforms: LINUX,
      hostsFile: null,
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
    const outcome = await protectBranch({
      checkout: checkout({ origin: `https://github.com/${SLUG}` }),
      branch: "master",
      platforms: LINUX,
      hostsFile: null,
      dryRun: false,
      create: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // NOT `no_credential`: logging in again changes nothing. The repository
    // has no ruleset, and bringing merge-blocking policy into existence is a
    // decision, not a recovery.
    expect(outcome.code).toBe("bad_input");
    expect(outcome.suggestion).toEqual(["odu", "protect", "--create"]);
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
    // The required contexts are the checkout's recipes crossed with a platform
    // set. Nothing in that depends on the origin or on which branch is the
    // default, so a dry run does not go and find out — which is what keeps
    // "show me what this would require" working in a repository that has no
    // GitHub remote yet, and what keeps it from spending a network round trip
    // to print a list that would be identical either way.
    const gh = fakeGh("ok");
    const outcome = await protectBranch({
      checkout: checkout({ origin: `https://github.com/${SLUG}` }),
      platforms: ["x86_64-linux", "aarch64-darwin"],
      hostsFile: null,
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
    // NOT KNOWN rather than not applicable: the forge was never asked, so
    // there is no repo and no branch to name, and naming a guess would be
    // worse than naming neither.
    expect(outcome.facts.repo).toBeNull();
    expect(outcome.facts.branch).toBeNull();
    expect(outcome.facts.applied).toBe(false);
    expect(outcome.facts.created).toBe(false);
    expect(outcome.facts.rulesetId).toBeNull();
    // An explicit platform set is the caller's own decision, so there is no
    // machine-local provenance to disclose.
    expect(outcome.facts.derivedFrom).toBeNull();
    // THE ASSERTION THAT MATTERS: not one `gh` call.
    expect(gh.calls()).toEqual([]);
  });

  it("previews in a checkout with no origin remote at all", async () => {
    // The case the forge round trip used to break, and the one a person is
    // most likely to be in: a repository that is not on GitHub yet.
    fakeGh("ok");
    const outcome = await protectBranch({
      checkout: checkout({}),
      platforms: ["x86_64-linux"],
      hostsFile: null,
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
    // Protection is repo-global and a hosts file is machine-local; deriving one
    // from the other silently once halved a repo's required contexts. A face
    // can refuse a derived set — but only if the answer says it was derived.
    const file = hosts({ "x86_64-linux": "some-box" });
    fakeGh("ok");
    const outcome = await protectBranch({
      checkout: checkout({ origin: `https://github.com/${SLUG}` }),
      branch: "master",
      platforms: [],
      hostsFile: null,
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
    const outcome = await protectBranch({
      checkout: checkout({ origin: `https://github.com/${SLUG}` }),
      branch: "master",
      platforms: LINUX,
      hostsFile: null,
      dryRun: false,
      create: false,
    });
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
    expect(outcome.facts.applied).toBe(true);
    expect(outcome.facts.created).toBe(false);
    expect(outcome.facts.rulesetId).toBe(RULESET.id);
    expect(gh.calls().some((c) => c.includes("--method PUT"))).toBe(true);
    // A named branch means gh is never asked which the default is.
    expect(gh.calls().some((c) => c.includes(".default_branch"))).toBe(false);
  });

  it("creates a ruleset when asked, and says a merge gate now exists", async () => {
    const gh = fakeGh("ok", { branchRules: [] });
    const outcome = await protectBranch({
      checkout: checkout({ origin: `https://github.com/${SLUG}` }),
      branch: "master",
      platforms: LINUX,
      hostsFile: null,
      dryRun: false,
      create: true,
    });
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
    expect(outcome.facts.created).toBe(true);
    expect(outcome.facts.applied).toBe(true);
    expect(outcome.facts.rulesetId).toBe(777);
    // The part that surprises people, carried as a fact rather than left on a
    // terminal nobody was watching.
    expect(outcome.facts.detail).toContain("nobody bypasses it");
    expect(gh.calls().some((c) => c.includes("--method POST"))).toBe(true);
  });
});
