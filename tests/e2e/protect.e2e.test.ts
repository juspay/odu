/**
 * End-to-end: `odu protect --dry-run` prints the (recipe × platform) contexts
 * branch protection would require. `protect` never dials a host, so its
 * platform enumeration must not depend on the machine's hosts config:
 * explicit `--platform` flags work against an EMPTY hosts file
 * (juspay/odu#52), and a hosts-derived platform set names its machine-local
 * provenance on stderr — branch protection is a repo-global fact, and
 * deriving it silently from one machine's config once halved a repo's
 * required contexts.
 *
 * The second suite drives the write path against a stand-in `gh`. Everything
 * `protect` decides is unit-tested (src/cli/rulesets.test.ts); what only a
 * black-box run can catch is which GitHub endpoint it decides *at* — the
 * `Branch not protected (HTTP 404)` bug was a correct context list PATCHed to
 * classic branch protection on a repo that has none.
 */

import {
  execFileSync,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { BIG, buildOduBinary, cleanup, makeFixture } from "./harness";

let oduBin: string;

// Dry-run never builds or dials anything — git rev-parse + just ingest only.
const PROTECT_TIMEOUT = 60_000;

beforeAll(() => {
  oduBin = buildOduBinary();
}, 600_000); // nix build, cold cache

// Every temp dir a test makes — fixture repos and per-test hosts dirs alike —
// lands here and is swept after the test. bun:test has no per-test
// `onTestFinished`, so one file-local registry stands in for it.
const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) cleanup(dir);
});

function fixture(name: string): string {
  const dir = makeFixture(name);
  created.push(dir);
  return dir;
}

/** Run `odu protect --dry-run` in `dir` with a throwaway hosts file holding
 *  exactly `hosts` (an object, or a raw string for a deliberately malformed
 *  file) — hermetic against the dev machine's ambient config, like the
 *  harness's `hermeticEnv`, but per-test so a test can name an EMPTY config
 *  (the #52 case `hermeticEnv` can never express). Returns the generated
 *  `hostsFile` path too, so tests can assert the provenance messages name the
 *  file that actually won. */
function oduProtect(
  dir: string,
  hosts: Record<string, string> | string,
  args: string[] = [],
): { res: SpawnSyncReturns<string>; hostsFile: string } {
  const hostsDir = mkdtempSync(join(tmpdir(), "odu-e2e-protect-"));
  created.push(hostsDir);
  const hostsFile = join(hostsDir, "hosts.json");
  writeFileSync(
    hostsFile,
    typeof hosts === "string" ? hosts : JSON.stringify(hosts),
  );
  const res = spawnSync(oduBin, ["protect", "--dry-run", ...args], {
    cwd: dir,
    encoding: "utf-8",
    maxBuffer: BIG,
    env: { ...process.env, ODU_HOSTS: hostsFile },
  });
  return { res, hostsFile };
}

const lines = (out: string): string[] =>
  out.split("\n").filter((l) => l !== "");

const BOTH_PLATFORMS = [
  "--platform",
  "x86_64-linux",
  "--platform",
  "aarch64-darwin",
];

describe("odu protect --dry-run (black-box)", () => {
  it("enumerates explicit --platform flags with an empty hosts config (#52)", () => {
    const { res } = oduProtect(fixture("pass"), {}, BOTH_PLATFORMS);
    // Explicit platforms are the operator's own decision — no provenance
    // warning, no host requirement, just the contexts.
    expect(res.stderr).toBe("");
    expect(lines(res.stdout).sort()).toEqual([
      "alpha@aarch64-darwin",
      "alpha@x86_64-linux",
      "beta@aarch64-darwin",
      "beta@x86_64-linux",
    ]);
    expect(res.status).toBe(0);
  }, PROTECT_TIMEOUT);

  it("never parses the hosts file when --platform is explicit", () => {
    // Not just independence from the file's *membership* — the explicit path
    // must bypass hosts resolution entirely, so even an unparseable file
    // cannot break it.
    const { res } = oduProtect(fixture("pass"), "not json {{{", BOTH_PLATFORMS);
    expect(res.stderr).toBe("");
    expect(lines(res.stdout).length).toBe(4);
    expect(res.status).toBe(0);
  }, PROTECT_TIMEOUT);

  it("refuses a blank --platform value instead of emitting `recipe@` contexts", () => {
    // `--platform=` used to be rejected only incidentally (no host named "");
    // with enumeration decoupled the refusal must be deliberate.
    const { res } = oduProtect(fixture("pass"), {}, ["--platform", ""]);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--platform");
  }, PROTECT_TIMEOUT);

  it("derives platforms from the hosts config when unsliced — and names that provenance", () => {
    const { res, hostsFile } = oduProtect(fixture("pass"), {
      "x86_64-linux": "some-host",
    });
    expect(lines(res.stdout)).toEqual([
      "alpha@x86_64-linux",
      "beta@x86_64-linux",
    ]);
    // The silent-halving trap: protection is repo-global, the hosts file is
    // machine-local. The derived set must say exactly which file it came from.
    expect(res.stderr).toContain("derives from");
    expect(res.stderr).toContain(hostsFile);
    expect(res.stderr).toContain("--platform");
    expect(res.status).toBe(0);
  }, PROTECT_TIMEOUT);

  it("refuses an empty platform set, naming the empty file and --platform", () => {
    const { res, hostsFile } = oduProtect(fixture("pass"), {});
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--platform");
    // The winning-but-empty file is diagnosed as such (lens fix ee4939f).
    expect(res.stderr).toContain(hostsFile);
  }, PROTECT_TIMEOUT);
});

/**
 * The fixture's origin. Deliberately a repo that does not exist on GitHub: this
 * suite drives the WRITE path, so if the `$ODU_GH_BIN` seam ever stops holding,
 * the calls it aims at a stand-in land on the real API under the developer's
 * own credentials. Naming a real repo here once rewrote that repo's live
 * ruleset. A slug that 404s makes such an escape fail loudly instead.
 */
const SLUG = "odu-e2e-fixture/absent-repo";

/** The ruleset governing the fixture's `master`, shaped like the real
 *  `GET /repos/juspay/olai/rulesets/20468764` that provoked this path: PRs plus
 *  green CI, still requiring the GitHub Actions contexts a move to odu leaves
 *  behind. */
const FIXTURE_RULESET = {
  id: 20468764,
  name: "master: PRs + green CI",
  target: "branch",
  source_type: "Repository",
  source: SLUG,
  enforcement: "active",
  conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } },
  bypass_actors: [
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
  ],
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 0,
        allowed_merge_methods: ["squash", "merge", "rebase"],
      },
    },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: false,
        required_status_checks: [
          { context: "build-and-test (ubuntu-latest)" },
          { context: "build-and-test (macos-latest)" },
        ],
      },
    },
  ],
};

const RULES_ON_MASTER = FIXTURE_RULESET.rules.map((rule) => ({
  type: rule.type,
  ruleset_source_type: "Repository",
  ruleset_source: SLUG,
  ruleset_id: FIXTURE_RULESET.id,
}));

/**
 * Run a real `odu protect` (no `--dry-run`) whose `gh` is a shell script
 * answering the two reads from canned JSON and capturing the write. Faking at
 * the `$ODU_GH_BIN` seam rather than stubbing a module keeps the test
 * black-box: the argv it records is exactly the argv that would have reached
 * GitHub, which is the only place an endpoint mistake is observable.
 */
function oduProtectWrite(opts: {
  branchRules: unknown;
  ruleset?: unknown;
}): {
  res: SpawnSyncReturns<string>;
  /** Every argv the fake `gh` was spawned with, one string per call. */
  calls: string[];
  putBody: () => Record<string, unknown> | null;
} {
  const dir = fixture("pass");
  execFileSync("git", ["remote", "add", "origin", `https://github.com/${SLUG}`], {
    cwd: dir,
  });

  const gh = mkdtempSync(join(tmpdir(), "odu-e2e-gh-"));
  created.push(gh);
  const at = (name: string): string => join(gh, name);
  writeFileSync(at("branch-rules.json"), JSON.stringify(opts.branchRules));
  writeFileSync(at("ruleset.json"), JSON.stringify(opts.ruleset ?? {}));
  writeFileSync(at("calls.txt"), "");

  // Cases are ordered by specificity: a PUT's URL also contains `/rulesets/`.
  // An unmatched call fails loudly — a silently empty answer would read as a
  // GitHub quirk rather than protect calling somewhere unexpected.
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> '${at("calls.txt")}'
case "$*" in
  *"--method PUT"*) cat > '${at("put-body.json")}'; printf '{}\\n' ;;
  *"--jq .default_branch"*) printf 'master\\n' ;;
  *"/rules/branches/"*) cat '${at("branch-rules.json")}' ;;
  *"/rulesets/"*) cat '${at("ruleset.json")}' ;;
  *) printf 'fake gh: unexpected call: %s\\n' "$*" >&2; exit 1 ;;
esac
`;
  const ghBin = at("gh");
  writeFileSync(ghBin, script);
  chmodSync(ghBin, 0o755);

  const res = spawnSync(oduBin, ["protect", ...BOTH_PLATFORMS], {
    cwd: dir,
    encoding: "utf-8",
    maxBuffer: BIG,
    env: { ...process.env, ODU_GH_BIN: ghBin },
  });
  const calls = lines(readFileSync(at("calls.txt"), "utf-8"));
  // Every path through `protect` reaches GitHub at least once, so an empty
  // recording means the stand-in was bypassed — the nix wrapper `--set` rather
  // than `--set-default`-ing ODU_GH_BIN did exactly that. Fail here rather than
  // let assertions further down interpret a real API's answers.
  if (calls.length === 0) {
    throw new Error(
      "e2e: $ODU_GH_BIN was bypassed — protect ran against the real `gh`",
    );
  }
  return {
    res,
    calls,
    putBody: () => {
      try {
        return JSON.parse(readFileSync(at("put-body.json"), "utf-8"));
      } catch {
        return null; // no PUT was made
      }
    },
  };
}

const CONTEXTS = [
  { context: "alpha@aarch64-darwin" },
  { context: "beta@aarch64-darwin" },
  { context: "alpha@x86_64-linux" },
  { context: "beta@x86_64-linux" },
];

interface Rule {
  type: string;
  parameters?: Record<string, unknown>;
}

describe("odu protect (ruleset write path)", () => {
  it("writes the contexts into the ruleset governing the branch", () => {
    const { res, putBody } = oduProtectWrite({
      branchRules: RULES_ON_MASTER,
      ruleset: FIXTURE_RULESET,
    });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);

    const body = putBody();
    expect(body).not.toBeNull();
    const checks = (body?.rules as Rule[]).find(
      (rule) => rule.type === "required_status_checks",
    );
    // The stale Actions contexts are gone: leaving them required would block
    // every merge on checks no odu run posts.
    expect(checks?.parameters?.required_status_checks).toEqual(
      expect.arrayContaining(CONTEXTS),
    );
    expect(
      (checks?.parameters?.required_status_checks as unknown[]).length,
    ).toBe(CONTEXTS.length);
    expect(res.stdout).toContain("master: PRs + green CI");
  }, PROTECT_TIMEOUT);

  it("never touches the classic branch-protection endpoint", () => {
    // The regression this suite exists for. `protect` PATCHed
    // /branches/{b}/protection/required_status_checks, which 404s
    // `Branch not protected` on any repo governed by a ruleset — and the
    // context list it sent was perfectly correct, so nothing but the endpoint
    // itself is worth asserting on.
    const { calls } = oduProtectWrite({
      branchRules: RULES_ON_MASTER,
      ruleset: FIXTURE_RULESET,
    });
    const argv = calls.join("\n");
    expect(argv).not.toContain("/protection");
    expect(argv).not.toContain("PATCH");
    expect(argv).toContain(`PUT repos/${SLUG}/rulesets/20468764`);
  }, PROTECT_TIMEOUT);

  it("carries the ruleset's other rules and bypass actors through the write", () => {
    // The PUT replaces `rules` wholesale and GitHub has no per-rule endpoint,
    // so anything protect fails to echo back is policy it silently deleted.
    const { putBody } = oduProtectWrite({
      branchRules: RULES_ON_MASTER,
      ruleset: FIXTURE_RULESET,
    });
    const body = putBody();
    expect((body?.rules as Rule[]).map((r) => r.type)).toEqual([
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_status_checks",
    ]);
    expect(body?.bypass_actors).toEqual(FIXTURE_RULESET.bypass_actors);
    expect(body?.conditions).toEqual(FIXTURE_RULESET.conditions);
    expect(body?.enforcement).toBe("active");
  }, PROTECT_TIMEOUT);

  it("refuses a branch no ruleset covers instead of writing somewhere", () => {
    // GitHub answers 200 `[]` here, so there is no error to propagate — the
    // refusal is protect's own, and it has to say what to create.
    const { res, putBody } = oduProtectWrite({ branchRules: [] });
    expect(res.status).toBe(1);
    expect(putBody()).toBeNull();
    expect(res.stderr).toContain("no ruleset covering master");
    expect(res.stderr).toContain("Settings → Rules");
  }, PROTECT_TIMEOUT);

  it("refuses when two rulesets require checks, naming both", () => {
    const { res, putBody } = oduProtectWrite({
      branchRules: [
        { type: "required_status_checks", ruleset_id: 111 },
        { type: "required_status_checks", ruleset_id: 222 },
      ],
    });
    expect(res.status).toBe(1);
    expect(putBody()).toBeNull();
    expect(res.stderr).toContain(`${SLUG}/rules/111`);
    expect(res.stderr).toContain(`${SLUG}/rules/222`);
  }, PROTECT_TIMEOUT);
});
