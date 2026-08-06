/**
 * The fan-in node id: `<namepath>@<platform>`. This is the one primitive that
 * joins lane-local state, fan-in state, GitHub contexts, log paths, and CLI
 * selectors, so its wire format (the `@` separator) lives here rather than
 * being re-derived at every consumer.
 *
 * Invariant: the namepath never leads with `@`, so `lastIndexOf("@")` with an
 * `at > 0` guard splits unambiguously. A lane-local id (no `@`) is the
 * asymmetric edge case — it defaults platform to "unknown".
 */
export function fanId(namepath: string, platform: string): string {
  return `${namepath}@${platform}`;
}

export function splitFanId(id: string): { namepath: string; platform: string } {
  const at = id.lastIndexOf("@");
  if (at > 0) {
    return { namepath: id.slice(0, at), platform: id.slice(at + 1) };
  }
  return { namepath: id, platform: "unknown" };
}

export function onPlatform(id: string, platform: string): boolean {
  // Platform is the field after the last `@` (see splitFanId), not a free
  // suffix of the whole id — so a namepath that itself contains `@` cannot
  // make an unrelated platform string match.
  return splitFanId(id).platform === platform;
}

/** Coordinator / lane bookkeeping namepath fanned as `_ci-setup@<platform>`.
 *  One spelling for run.ts, runner.ts, and CLI `@platform` exclusion. */
export const SETUP_NAMEPATH = "_ci-setup";

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
