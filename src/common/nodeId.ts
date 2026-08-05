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
  return id.endsWith(`@${platform}`);
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
