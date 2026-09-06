/**
 * GitHub **rulesets** — where a repo declares which status checks a branch
 * requires.
 *
 * `odu protect` used to PATCH classic branch protection
 * (`/branches/{b}/protection/required_status_checks`). That endpoint sees only
 * the legacy protection object, so against a branch governed by a ruleset it
 * answers `Branch not protected (HTTP 404)` — even though the branch reports
 * `protected: true` and blocks merges on stale contexts (juspay/olai). Classic
 * protection is not something odu targets; rulesets are.
 *
 * This module is the volatile half — GitHub's wire shapes, and which ruleset
 * owns a branch's checks. `protect.ts` keeps the odu-owned half (which contexts
 * a run posts) and does the I/O, so a future move of GitHub's protection
 * vocabulary lands here alone.
 */

import { Effect, Result, Schema } from "effect";

/** The rule type odu writes. Every other rule in a ruleset is passed through
 *  untouched. */
const CHECKS_RULE = "required_status_checks";

/** One entry of `GET /repos/{owner}/{repo}/rules/branches/{branch}` — the rules
 *  in force on a branch, each tagged with the ruleset it came from. Only the
 *  fields the choice turns on are modelled; a rule's `parameters` are read from
 *  the ruleset itself, not from here. `ruleset_source_type` is absent on some
 *  responses, and a repo-owned ruleset is the only kind the repo-scoped write
 *  endpoint can reach, so that is the default the choice then re-checks.
 *
 *  Effect Schema, like every other wire shape in this repo (src/common/spec.ts
 *  states the zod→Effect mapping this file follows): `.default(v)` is
 *  `withDecodingDefaultKey`, which substitutes for an ABSENT key only. Every
 *  value here is decoded straight out of `JSON.parse` of a `gh api` body, where
 *  a present-but-`undefined` key cannot occur, so the stricter reading costs
 *  nothing. */
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

/** One rule inside `GET /repos/{owner}/{repo}/rulesets/{id}`. `parameters` stays
 *  an opaque bag: odu rewrites exactly one key of one rule type, and every
 *  unmodelled rule has to survive the read-modify-write byte-for-byte. */
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
 *  `none` — no ruleset covers the branch at all, so there is nothing to require
 *  checks on. `ambiguous` — several rulesets require checks and GitHub enforces
 *  the union, so writing one would leave the others' contexts required and
 *  blocking. `foreign` — an org- or enterprise-owned ruleset, which the
 *  repo-scoped endpoint cannot write. */
export type RulesetChoice =
  | { kind: "ruleset"; id: number }
  | { kind: "none" }
  | { kind: "ambiguous"; ids: number[] }
  | { kind: "foreign"; id: number; sourceType: string; source: string };

/**
 * Pick the ruleset that owns a branch's required checks.
 *
 * A ruleset that already has a `required_status_checks` rule is where the
 * checks live, so it wins outright; only when none does is "the one ruleset
 * covering this branch" the right home for a fresh rule. Anything other than a
 * single repo-owned winner is refused rather than guessed at — protection that
 * silently lands on the wrong ruleset blocks merges on contexts no run posts,
 * which is the failure this whole module exists to stop.
 */
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
 * `contexts` — appended if the ruleset had no such rule yet.
 *
 * The rule's policy fields (`strict_required_status_checks_policy`,
 * `do_not_enforce_on_create`) are carried over rather than reasserted, and
 * every other rule is untouched: odu owns *which* checks are required, the
 * operator owns *how* they are enforced. A rule created from nothing has no
 * policy to carry, and GitHub requires the strict flag, so it starts
 * non-strict — the setting classic protection was pinned to.
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

/** The name odu gives a ruleset it creates. Self-identifying, so a maintainer
 *  meeting it under Settings → Rules can tell what made it and what maintains
 *  it. Stable: protect finds it again by coverage, not by name, but a renamed
 *  one would read as somebody else's. */
export const CREATED_RULESET_NAME = "odu: required checks";

/**
 * Body for `POST /repos/{owner}/{repo}/rulesets` — the ruleset `--create` makes
 * for a branch no ruleset covers.
 *
 * It holds exactly one rule. `pull_request`, `deletion` and the rest are the
 * repo's own policy, and a `protect` that quietly decided reviews were required
 * would be answering a question nobody asked it. What is left is nearly all
 * derived: the conditions are the branch protect was pointed at, the rule is the
 * contexts it already computed, and `active` is the only enforcement under which
 * requiring a check means anything (`evaluate` is a dry run, which `--dry-run`
 * already covers).
 *
 * `bypass_actors` is empty, so nobody — admins included — is exempt. That is the
 * conservative end: granting a bypass is a permission decision, easy to add
 * later under Settings → Rules and impossible to take back unnoticed. A branch
 * asked for `~DEFAULT_BRANCH` follows a later rename, which is what "protect the
 * default branch" meant; an explicitly named one is pinned literally, because
 * naming it is the operator saying which branch they meant.
 */
export function createBody(opts: {
  branch: string;
  /** The branch came from the repo's default, not from `--branch`. */
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

/** The id of a just-created ruleset, for the report. A create that succeeded but
 *  answered something unmodelled is still a create, so this is `null` rather
 *  than an error — the id is a nicety, not the outcome. */
export function rulesetId(raw: string): number | null {
  try {
    const decoded = decodeRuleset(JSON.parse(raw) as unknown);
    return Result.isSuccess(decoded) ? decoded.success.id : null;
  } catch {
    return null;
  }
}

/** Built once at module scope, as everywhere else a schema meets a decoder in
 *  this repo (packages/run-history/src/legacy/ledger.ts) — the decoder is derived from the
 *  schema, not from the value. */
const decodeRuleset = Schema.decodeUnknownResult(RulesetSchema);

/**
 * Body for `PUT /repos/{owner}/{repo}/rulesets/{id}` that changes only the
 * required contexts.
 *
 * There is no endpoint for one rule, and the PUT replaces `rules` wholesale, so
 * the write is a full read-modify-write: every field the read returned goes
 * back out. Sending only `rules` would leave the ruleset's name, conditions and
 * bypass actors to whatever an omitted key means on the day — and a dropped
 * bypass actor locks maintainers out of their own branch.
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
