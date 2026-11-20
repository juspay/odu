import { Effect, Result, Schema } from "effect";

const CHECKS_RULE = "required_status_checks";

/** One entry of `GET /repos/{owner}/{repo}/rules/branches/{branch}`.
 *  `ruleset_source_type` is absent on some responses, and a repo-owned ruleset
 *  is the only kind the repo-scoped write endpoint can reach, so that is the
 *  default the choice then re-checks. */
const BranchRuleSchema = Schema.Struct({
  type: Schema.String,
  ruleset_id: Schema.Number,
  ruleset_source_type: Schema.String.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("Repository")),
  ),
  ruleset_source: Schema.String.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("")),
  ),
});
export type BranchRule = typeof BranchRuleSchema.Type;
export const BranchRulesSchema = Schema.Array(BranchRuleSchema);

const RuleSchema = Schema.Struct({
  type: Schema.String,
  parameters: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type Rule = typeof RuleSchema.Type;

/** `GET /repos/{owner}/{repo}/rulesets/{id}` — read in full because the write
 *  echoes it back (see `updateBody`). */
export const RulesetSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  target: Schema.String,
  enforcement: Schema.String,
  conditions: Schema.optionalKey(Schema.Unknown),
  bypass_actors: Schema.Array(Schema.Unknown).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed<readonly unknown[]>([])),
  ),
  rules: Schema.Array(RuleSchema).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed<readonly Rule[]>([])),
  ),
});
export type Ruleset = typeof RulesetSchema.Type;

/** Which ruleset `protect` should write the contexts into.
 *
 *  `ambiguous` — several rulesets require checks and GitHub enforces the
 *  union, so writing one would leave the others' contexts required and
 *  blocking. `foreign` — an org- or enterprise-owned ruleset, which the
 *  repo-scoped endpoint cannot write. */
export type RulesetChoice =
  | { kind: "ruleset"; id: number }
  | { kind: "none" }
  | { kind: "ambiguous"; ids: number[] }
  | { kind: "foreign"; id: number; sourceType: string; source: string };

export function chooseRuleset(rules: readonly BranchRule[]): RulesetChoice {
  const byId = new Map<number, { rule: BranchRule; hasChecks: boolean }>();
  for (const rule of rules) {
    const seen = byId.get(rule.ruleset_id);
    byId.set(rule.ruleset_id, {
      rule: seen?.rule ?? rule,
      hasChecks: (seen?.hasChecks ?? false) || rule.type === CHECKS_RULE,
    });
  }
  const covering = [...byId.values()];
  const owners = covering.filter((c) => c.hasChecks);
  const candidates = owners.length > 0 ? owners : covering;

  const only = candidates[0];
  if (only === undefined) return { kind: "none" };
  if (candidates.length > 1) {
    return {
      kind: "ambiguous",
      ids: candidates.map((c) => c.rule.ruleset_id).sort((a, b) => a - b),
    };
  }
  if (only.rule.ruleset_source_type !== "Repository") {
    return {
      kind: "foreign",
      id: only.rule.ruleset_id,
      sourceType: only.rule.ruleset_source_type,
      source: only.rule.ruleset_source,
    };
  }
  return { kind: "ruleset", id: only.rule.ruleset_id };
}

/**
 * The ruleset's rules with its `required_status_checks` rule requiring exactly
 * `contexts`.
 *
 * GitHub requires the strict flag, so a rule created from nothing starts
 * non-strict.
 */
export function requireContexts(
  rules: readonly Rule[],
  contexts: readonly string[],
): Rule[] {
  const existing = rules.find((rule) => rule.type === CHECKS_RULE);
  const rewritten: Rule = {
    type: CHECKS_RULE,
    parameters: {
      strict_required_status_checks_policy: false,
      ...(existing?.parameters ?? {}),
      required_status_checks: contexts.map((context) => ({ context })),
    },
  };
  if (existing === undefined) return [...rules, rewritten];
  return rules.map((rule) => (rule.type === CHECKS_RULE ? rewritten : rule));
}

export const CREATED_RULESET_NAME = "odu: required checks";

/**
 * Body for `POST /repos/{owner}/{repo}/rulesets`.
 *
 * A branch asked for `~DEFAULT_BRANCH` follows a later rename; an explicitly
 * named one is pinned literally.
 */
export function createBody(opts: {
  branch: string;
  isDefault: boolean;
  contexts: readonly string[];
}): string {
  return JSON.stringify({
    name: CREATED_RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: {
        include: [opts.isDefault ? "~DEFAULT_BRANCH" : `refs/heads/${opts.branch}`],
        exclude: [],
      },
    },
    bypass_actors: [],
    rules: requireContexts([], opts.contexts),
  });
}

export function rulesetId(raw: string): number | null {
  try {
    const decoded = decodeRuleset(JSON.parse(raw) as unknown);
    return Result.isSuccess(decoded) ? decoded.success.id : null;
  } catch {
    return null;
  }
}

const decodeRuleset = Schema.decodeUnknownResult(RulesetSchema);

/**
 * Body for `PUT /repos/{owner}/{repo}/rulesets/{id}`.
 *
 * There is no endpoint for one rule, and the PUT replaces `rules` wholesale, so
 * the write is a full read-modify-write: every field the read returned goes
 * back out.
 */
export function updateBody(
  ruleset: Ruleset,
  contexts: readonly string[],
): string {
  return JSON.stringify({
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    conditions: ruleset.conditions,
    bypass_actors: ruleset.bypass_actors,
    rules: requireContexts(ruleset.rules, contexts),
  });
}
