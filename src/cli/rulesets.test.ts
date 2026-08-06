/**
 * The ruleset decisions `odu protect` writes through. Every case here is one
 * the classic-protection code could not even express: it had a single endpoint
 * and no notion of *which* protection object owned a branch's checks.
 */

import { describe, expect, it } from "bun:test";
import {
  BranchRulesSchema,
  chooseRuleset,
  type Rule,
  requireContexts,
  RulesetSchema,
  updateBody,
} from "./rulesets";

/** A `rules/branches/{branch}` entry. */
const branchRule = (
  type: string,
  rulesetId: number,
  source?: { sourceType: string; source: string },
): unknown => ({
  type,
  ruleset_id: rulesetId,
  ...(source === undefined
    ? {}
    : { ruleset_source_type: source.sourceType, ruleset_source: source.source }),
});

const parseRules = (items: unknown[]) => BranchRulesSchema.parse(items);

describe("chooseRuleset", () => {
  it("refuses an unruled branch rather than inventing a ruleset", () => {
    // GitHub answers 200 with `[]` for both an unruled branch and one that
    // does not exist, so this is the shape protect actually meets.
    expect(chooseRuleset(parseRules([]))).toEqual({ kind: "none" });
  });

  it("picks the one ruleset covering the branch, checks rule or not", () => {
    // A ruleset governing the branch with only a pull_request rule is still
    // the home for a required_status_checks rule protect adds.
    expect(chooseRuleset(parseRules([branchRule("pull_request", 7)]))).toEqual({
      kind: "ruleset",
      id: 7,
    });
  });

  it("collapses a ruleset's many rules to one candidate", () => {
    const rules = parseRules([
      branchRule("deletion", 20468764),
      branchRule("non_fast_forward", 20468764),
      branchRule("pull_request", 20468764),
      branchRule("required_status_checks", 20468764),
    ]);
    expect(chooseRuleset(rules)).toEqual({ kind: "ruleset", id: 20468764 });
  });

  it("prefers the ruleset that already owns the checks over a bare neighbour", () => {
    // Two rulesets cover the branch but only one requires checks — that one
    // owns them. Adding a second checks rule elsewhere would make GitHub
    // require the union and block on whatever the first still lists.
    const rules = parseRules([
      branchRule("deletion", 1),
      branchRule("required_status_checks", 2),
      branchRule("pull_request", 2),
    ]);
    expect(chooseRuleset(rules)).toEqual({ kind: "ruleset", id: 2 });
  });

  it("refuses when two rulesets both require checks, naming both", () => {
    const rules = parseRules([
      branchRule("required_status_checks", 9),
      branchRule("required_status_checks", 4),
    ]);
    expect(chooseRuleset(rules)).toEqual({ kind: "ambiguous", ids: [4, 9] });
  });

  it("refuses when two bare rulesets cover the branch and neither is the home", () => {
    const rules = parseRules([
      branchRule("deletion", 3),
      branchRule("pull_request", 5),
    ]);
    expect(chooseRuleset(rules)).toEqual({ kind: "ambiguous", ids: [3, 5] });
  });

  it("refuses an org-owned ruleset the repo endpoint cannot write", () => {
    const rules = parseRules([
      branchRule("required_status_checks", 12, {
        sourceType: "Organization",
        source: "juspay",
      }),
    ]);
    expect(chooseRuleset(rules)).toEqual({
      kind: "foreign",
      id: 12,
      sourceType: "Organization",
      source: "juspay",
    });
  });

  it("treats an unlabelled source as the repo's own", () => {
    // `ruleset_source_type` is absent on some responses; defaulting to
    // Organization would refuse every ordinary repo.
    expect(chooseRuleset(parseRules([branchRule("deletion", 8)]))).toEqual({
      kind: "ruleset",
      id: 8,
    });
  });
});

describe("requireContexts", () => {
  const checksRule = (contexts: string[], extra: object = {}): Rule => ({
    type: "required_status_checks",
    parameters: {
      strict_required_status_checks_policy: false,
      ...extra,
      required_status_checks: contexts.map((context) => ({ context })),
    },
  });

  it("replaces the required contexts wholesale", () => {
    // The stale GitHub Actions contexts that outlive a move to odu are exactly
    // what must not survive: they block merges on checks nothing posts.
    const rules = [
      checksRule(["build-and-test (ubuntu-latest)"]),
    ];
    expect(requireContexts(rules, ["alpha@x86_64-linux"])).toEqual([
      checksRule(["alpha@x86_64-linux"]),
    ]);
  });

  it("appends a checks rule to a ruleset that had none", () => {
    const rules: Rule[] = [{ type: "deletion" }];
    expect(requireContexts(rules, ["alpha@x86_64-linux"])).toEqual([
      { type: "deletion" },
      checksRule(["alpha@x86_64-linux"]),
    ]);
  });

  it("leaves every other rule byte-for-byte intact", () => {
    // The write replaces the whole rules array, so an unmodelled rule that
    // does not round-trip is a rule silently deleted from the repo's policy.
    const pullRequest: Rule = {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 2,
        allowed_merge_methods: ["squash"],
        dismissal_restriction: { enabled: false, allowed_actors: [] },
      },
    };
    const out = requireContexts([pullRequest, checksRule([])], ["beta@p"]);
    expect(out[0]).toEqual(pullRequest);
  });

  it("carries the operator's enforcement policy across the rewrite", () => {
    // odu owns which checks are required; strictness and the create exemption
    // are the operator's, and resetting them would be protect changing policy
    // it was never asked about.
    const rules: Rule[] = [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: true,
          required_status_checks: [{ context: "old" }],
        },
      },
    ];
    const [out] = requireContexts(rules, ["alpha@p"]);
    expect(out?.parameters).toEqual({
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: true,
      required_status_checks: [{ context: "alpha@p" }],
    });
  });

  it("starts a fresh rule non-strict, the setting classic protection was pinned to", () => {
    const [out] = requireContexts([], ["alpha@p"]);
    expect(out?.parameters?.strict_required_status_checks_policy).toBe(false);
  });

  it("requires nothing when the DAG produces no contexts", () => {
    const [out] = requireContexts([checksRule(["stale"])], []);
    expect(out?.parameters?.required_status_checks).toEqual([]);
  });
});

describe("updateBody", () => {
  // Verbatim from `GET /repos/juspay/olai/rulesets/20468764`, trimmed to the
  // fields the write echoes — the shape that made `odu protect` 404.
  const ruleset = RulesetSchema.parse({
    id: 20468764,
    name: "master: PRs + green CI",
    target: "branch",
    source_type: "Repository",
    source: "juspay/olai",
    enforcement: "active",
    conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } },
    bypass_actors: [
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
    ],
    rules: [
      { type: "deletion" },
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
  });

  it("echoes back the ruleset's identity, conditions and bypass actors", () => {
    // A PUT that omitted these would leave them to whatever an absent key means
    // on the day; a dropped bypass actor locks maintainers out of the branch.
    const body: Record<string, unknown> = JSON.parse(
      updateBody(ruleset, ["alpha@x86_64-linux"]),
    );
    expect(body.name).toBe("master: PRs + green CI");
    expect(body.target).toBe("branch");
    expect(body.enforcement).toBe("active");
    expect(body.conditions).toEqual({
      ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] },
    });
    expect(body.bypass_actors).toEqual([
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
    ]);
  });

  it("swaps the Actions contexts for odu's and keeps the other rules", () => {
    const body = JSON.parse(
      updateBody(ruleset, ["alpha@x86_64-linux", "beta@aarch64-darwin"]),
    ) as { rules: Rule[] };
    expect(body.rules.map((r) => r.type)).toEqual([
      "deletion",
      "required_status_checks",
    ]);
    expect(body.rules[1]?.parameters?.required_status_checks).toEqual([
      { context: "alpha@x86_64-linux" },
      { context: "beta@aarch64-darwin" },
    ]);
  });
});
