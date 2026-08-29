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
 */

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
