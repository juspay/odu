/**
 * What odu DOES with a node id — as distinct from what one IS.
 *
 * The format itself (`<namepath>@<platform>`), the schema every member names it
 * by, and the folds a READER performs on it (`splitFanId`, `onPlatform`,
 * `isSetupNode`, `SETUP_NAMEPATH`) are wire vocabulary and live in
 * `@odu/run-client/nodeId`, where a downstream face reading the matrix gets
 * them without installing odu.
 *
 * What is left here is odu's own: the argv grammar its CLI parses selectors
 * with, and the DAG walk its rerun does over them. Neither is something a
 * reader of the surface reads — one is a command line, the other is what a
 * WRITER computes before it mutates.
 *
 * The selector folds below moved DOWN from `src/cli/introspect.ts`, and the
 * move is the point rather than tidying: "which nodes does this token mean,
 * and which of them are dependency-minimal roots" is a DOMAIN question, and
 * the retry policy asks it now as well as the CLI. Leaving it in a CLI module
 * would have made the engine import a face to answer it.
 */

import type { PipelineState } from "@odu/run-client/surface";
import { isSetupNode, onPlatform, splitFanId } from "@odu/run-client/nodeId";

/** Transitive dependents of `root` under a needs graph (root itself excluded).
 *  Shared by runner `rerun` reset and CLI multi-target root collapse so both
 *  close over the same DAG rule. */
export function transitiveDependents(
  order: readonly string[],
  needsOf: (id: string) => readonly string[],
  root: string,
): Set<string> {
  const out = new Set<string>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of order) {
      if (out.has(id)) continue;
      if (needsOf(id).some((d) => out.has(d))) {
        out.add(id);
        grew = true;
      }
    }
  }
  out.delete(root);
  return out;
}

/** Parse `@platform` sugar shared by `odu cancel` and `odu rerun`. Returns the
 *  platform name, or `null` when the token is not a valid `@plat` form
 *  (missing `@`, empty after `@`, or nested `@`). Non-`@` tokens return null
 *  so callers keep their own node/recipe branch. */
export function parseAtPlatform(selector: string): string | null {
  if (!selector.startsWith("@")) return null;
  const platform = selector.slice(1);
  if (platform === "" || platform.includes("@")) return null;
  return platform;
}

/** All live node ids matching a CLI token: exact id, `::token` / `::token@`
 *  suffix-ish forms, or full namepath. Shared by unique resolve (`logs`) and
 *  multi-match expand (`rerun` recipe-wide). */
export function matchNodeIds(state: PipelineState, token: string): string[] {
  if (state.nodes[token] !== undefined) return [token];
  return state.order.filter((id) => {
    if (id === token) return true;
    if (id.endsWith(`::${token}`) || id.includes(`::${token}@`)) return true;
    return splitFanId(id).namepath === token;
  });
}

/** Resolve a node argument against the live state: exact id, or unique
 *  suffix-ish match (`e2e@x86_64-linux` ≡ `ci::e2e@x86_64-linux`). */
export function resolveNodeId(state: PipelineState, token: string): string {
  const matches = matchNodeIds(state, token);
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  throw new Error(
    matches.length === 0
      ? `odu: no node matches "${token}" (try: ${state.order.join(", ")})`
      : `odu: "${token}" is ambiguous (${matches.join(", ")})`,
  );
}


/** Expand a rerun selector against live state into fan-in node ids:
 *  - `ci::unit@plat` — one node (exact id, or the unique `resolveNodeId` match)
 *  - `@plat` — recipe nodes on that platform lane (not `_ci-setup`)
 *  - `unit` / `ci::unit` — that recipe on every lane (multi-match is the point)
 *
 *  Mirrors `odu cancel`'s node / `@platform` sugar and adds the bare-recipe
 *  form cancel doesn't need (cancel has `lane.cancel`; rerun is only per-node). */
export function resolveRerunTargets(
  state: PipelineState,
  selector: string,
): string[] {
  const platform = parseAtPlatform(selector);
  if (platform !== null) {
    // Recipe nodes on the lane only — not `_ci-setup@plat` (see isSetupNode).
    const ids = state.order.filter(
      (id) => onPlatform(id, platform) && !isSetupNode(id),
    );
    if (ids.length === 0) {
      throw new Error(`odu: no nodes on platform "${platform}"`);
    }
    return ids;
  }
  if (selector.startsWith("@")) {
    throw new Error(
      `odu: not a node id, @platform, or recipe: ${selector}`,
    );
  }

  // Multi-match is intentional for recipe-wide rerun — not an ambiguity error.
  const matches = matchNodeIds(state, selector);
  if (matches.length === 0) {
    throw new Error(
      `odu: no node matches "${selector}" (try: ${state.order.join(", ")})`,
    );
  }
  return matches;
}

/** Collapse multi-target rerun to dependency-minimal roots so a dependent that
 *  is already in another selected root's transitive `needs` closure is not
 *  issued its own `node.rerun` (each call resets id + dependents via the same
 *  `transitiveDependents` rule the runner uses). Closures are computed once
 *  per target. */
export function minimalRerunRoots(
  state: PipelineState,
  targets: string[],
): string[] {
  const needsOf = (id: string): readonly string[] =>
    state.nodes[id]?.needs ?? [];
  const coveredBy = new Map<string, Set<string>>();
  for (const t of targets) {
    coveredBy.set(t, transitiveDependents(state.order, needsOf, t));
  }
  return targets.filter((id) => {
    for (const other of targets) {
      if (other === id) continue;
      if (coveredBy.get(other)?.has(id) === true) return false;
    }
    return true;
  });
}
