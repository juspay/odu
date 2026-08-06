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

import { z } from "zod";

/** The rule type odu writes. Every other rule in a ruleset is passed through
 *  untouched. */
const CHECKS_RULE = "required_status_checks";

/** One entry of `GET /repos/{owner}/{repo}/rules/branches/{branch}` — the rules
 *  in force on a branch, each tagged with the ruleset it came from. Only the
 *  fields the choice turns on are modelled; a rule's `parameters` are read from
 *  the ruleset itself, not from here. `ruleset_source_type` is absent on some
 *  responses, and a repo-owned ruleset is the only kind the repo-scoped write
 *  endpoint can reach, so that is the default the choice then re-checks. */
const BranchRuleSchema = z.object({
  type: z.string(),
  ruleset_id: z.number(),
  ruleset_source_type: z.string().default("Repository"),
  ruleset_source: z.string().default(""),
});
export type BranchRule = z.infer<typeof BranchRuleSchema>;
export const BranchRulesSchema = z.array(BranchRuleSchema);

/** One rule inside `GET /repos/{owner}/{repo}/rulesets/{id}`. `parameters` stays
 *  an opaque bag: odu rewrites exactly one key of one rule type, and every
 *  unmodelled rule has to survive the read-modify-write byte-for-byte. */
const RuleSchema = z.object({
  type: z.string(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

/** `GET /repos/{owner}/{repo}/rulesets/{id}` — read in full because the write
 *  echoes it back (see `updateBody`). */
export const RulesetSchema = z.object({
  id: z.number(),
  name: z.string(),
  target: z.string(),
  enforcement: z.string(),
  conditions: z.unknown().optional(),
  bypass_actors: z.array(z.unknown()).default([]),
  rules: z.array(RuleSchema).default([]),
});
export type Ruleset = z.infer<typeof RulesetSchema>;

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
