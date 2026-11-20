import {
  execFileSync,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  BIG,
  buildOduBinary,
  removeNow,
  hermeticEnv,
  makeFixture,
  scratchDir,
  useGh,
} from "./harness";

let oduBin: string;

const PROTECT_TIMEOUT = 60_000;

beforeAll(() => {
  oduBin = buildOduBinary();
}, 600_000);

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) removeNow(dir);
});

function fixture(name: string): string {
  const dir = makeFixture(name);
  created.push(dir);
  return dir;
}

function oduProtect(
  dir: string,
  hosts: Record<string, string> | string,
  args: string[] = [],
): { res: SpawnSyncReturns<string>; hostsFile: string } {
  const hostsDir = scratchDir("odu-e2e-protect-");
  created.push(hostsDir);
  const hostsFile = join(hostsDir, "hosts.json");
  writeFileSync(
    hostsFile,
    typeof hosts === "string" ? hosts : JSON.stringify(hosts),
  );
  const res = spawnSync(oduBin, ["ci", "protect", "--dry-run", ...args], {
    cwd: dir,
    encoding: "utf-8",
    maxBuffer: BIG,
    env: { ...hermeticEnv, ODU_HOSTS: hostsFile },
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

describe("odu ci protect --dry-run (black-box)", () => {
  it("enumerates explicit --platform flags with an empty hosts config (#52)", () => {
    const { res } = oduProtect(fixture("pass"), {}, BOTH_PLATFORMS);
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
    const { res } = oduProtect(fixture("pass"), "not json {{{", BOTH_PLATFORMS);
    expect(res.stderr).toBe("");
    expect(lines(res.stdout).length).toBe(4);
    expect(res.status).toBe(0);
  }, PROTECT_TIMEOUT);

  it("refuses a blank --platform value instead of emitting `recipe@` contexts", () => {
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
    expect(res.stderr).toContain(hostsFile);
  }, PROTECT_TIMEOUT);
});

const SLUG = "odu-e2e-fixture/absent-repo";

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

function fakeGh(callLog: string, cases: [string, string][]): string {
  return [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${callLog}'`,
    'case "$*" in',
    ...cases.map(([pattern, handler]) => `  ${pattern}) ${handler} ;;`),
    `  *) printf 'fake gh: unexpected call: %s\\n' "$*" >&2; exit 1 ;;`,
    "esac",
    "",
  ].join("\n");
}

function oduProtectWrite(opts: {
  branchRules: unknown;
  ruleset?: unknown;
  args?: string[];
}): {
  res: SpawnSyncReturns<string>;
  calls: string[];
  putBody: () => Record<string, unknown> | null;
  postBody: () => Record<string, unknown> | null;
} {
  const dir = fixture("pass");
  execFileSync("git", ["remote", "add", "origin", `https://github.com/${SLUG}`], {
    cwd: dir,
  });

  const gh = scratchDir("odu-e2e-gh-");
  created.push(gh);
  const at = (name: string): string => join(gh, name);
  writeFileSync(at("branch-rules.json"), JSON.stringify(opts.branchRules));
  writeFileSync(at("ruleset.json"), JSON.stringify(opts.ruleset ?? {}));
  writeFileSync(at("calls.txt"), "");

  useGh(
    fakeGh(at("calls.txt"), [
      ['*"--method PUT"*', `cat > '${at("put-body.json")}'; printf '{}\\n'`],
      [
        '*"--method POST"*',
        `cat > '${at("post-body.json")}'; printf '{"id":777,"name":"odu: required checks","target":"branch","enforcement":"active"}\\n'`,
      ],
      ['*"--jq .default_branch"*', `printf 'master\\n'`],
      ['*"/rules/branches/"*', `cat '${at("branch-rules.json")}'`],
      ['*"/rulesets/"*', `cat '${at("ruleset.json")}'`],
    ]),
  );

  const res = spawnSync(
    oduBin,
    ["ci", "protect", ...BOTH_PLATFORMS, ...(opts.args ?? [])],
    {
      cwd: dir,
      encoding: "utf-8",
      maxBuffer: BIG,
      env: hermeticEnv,
    },
  );
  const calls = lines(readFileSync(at("calls.txt"), "utf-8"));
  if (calls.length === 0) {
    const seam = hermeticEnv.ODU_GH_BIN ?? "(unset)";
    throw new Error(
      `e2e: protect made no gh call (exit ${res.status}). Either the ` +
        "$ODU_GH_BIN seam was bypassed, or protect refused before reaching " +
        `the forge.\n  seam: ${seam} (exists: ${existsSync(seam)})` +
        `\n  it said:\n${res.stderr}${res.stdout}`,
    );
  }
  const bodyOf = (file: string) => (): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(at(file), "utf-8"));
    } catch {
      return null;
    }
  };
  return {
    res,
    calls,
    putBody: bodyOf("put-body.json"),
    postBody: bodyOf("post-body.json"),
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

describe("odu ci protect (ruleset write path)", () => {
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
    expect(checks?.parameters?.required_status_checks).toEqual(
      expect.arrayContaining(CONTEXTS),
    );
    expect(
      (checks?.parameters?.required_status_checks as unknown[]).length,
    ).toBe(CONTEXTS.length);
    expect(res.stdout).toContain("master: PRs + green CI");
  }, PROTECT_TIMEOUT);

  it("never touches the classic branch-protection endpoint", () => {
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

  it("refuses a branch no ruleset covers, and names --create", () => {
    const { res, putBody, postBody } = oduProtectWrite({ branchRules: [] });
    expect(res.status).toBe(1);
    expect(putBody()).toBeNull();
    expect(postBody()).toBeNull();
    expect(res.stderr).toContain("no ruleset covering master");
    expect(res.stderr).toContain("--create");
  }, PROTECT_TIMEOUT);

  it("creates the ruleset under --create, requiring exactly odu's contexts", () => {
    const { res, postBody, putBody } = oduProtectWrite({
      branchRules: [],
      args: ["--create"],
    });
    expect(res.status).toBe(0);
    expect(putBody()).toBeNull();

    const body = postBody();
    expect(body?.enforcement).toBe("active");
    expect(body?.bypass_actors).toEqual([]);
    const rules = body?.rules as Rule[];
    expect(rules.map((r) => r.type)).toEqual(["required_status_checks"]);
    expect(rules[0]?.parameters?.required_status_checks).toEqual(
      expect.arrayContaining(CONTEXTS),
    );
    expect(body?.conditions).toEqual({
      ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
    });
    expect(res.stdout).toContain("nobody bypasses it");
  }, PROTECT_TIMEOUT);

  it("pins an explicitly named --branch instead of tracking the default", () => {
    const { res, postBody } = oduProtectWrite({
      branchRules: [],
      args: ["--create", "--branch", "release"],
    });
    expect(res.status).toBe(0);
    expect(postBody()?.conditions).toEqual({
      ref_name: { include: ["refs/heads/release"], exclude: [] },
    });
  }, PROTECT_TIMEOUT);

  it("updates rather than creates when --create meets an existing ruleset", () => {
    const { res, postBody, putBody } = oduProtectWrite({
      branchRules: RULES_ON_MASTER,
      ruleset: FIXTURE_RULESET,
      args: ["--create"],
    });
    expect(res.status).toBe(0);
    expect(postBody()).toBeNull();
    expect(putBody()).not.toBeNull();
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
