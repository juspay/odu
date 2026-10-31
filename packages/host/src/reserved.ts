/**
 * THE DOOR GATE'S RESERVED SET — composed, never spelled twice.
 *
 * The gate must know before it runs a request whether the path is a route or
 * the shell (see `./principal`'s `doorGate`: the seam can skip a handler, not
 * rewrite its answer). That set has two owners, and this file only joins them:
 *
 *   - the HOST'S OWN routes, below — the door fact, and what
 *     `serveSurfaceApp` serves beside the shell (assets, worker, manifest).
 *     The agent endpoint is not here: the gate is handed it as `mcpPath` and
 *     answers it before it consults this set;
 *   - every ROW'S claim, registered with its layer (`ClaimedRoutes`), so the
 *     paths arrive with the routes they describe.
 *
 * A list the host kept for the rows' routes was how the cache's push API
 * (`/_odu/v1/…`) went missing: an anonymous `odu cache push` met the sign-in
 * page and failed to parse it. Anything unclaimed is still the shell — the
 * fail-closed direction is unchanged.
 */

import { type ClaimedRoutes, SERVICE_DOOR_PATH } from "@odu/cordis/services";

/** The paths the HOST'S listener answers itself. `*` means a walk — one or
 *  more characters after the prefix. */
export const HOST_PATHS: ReadonlyArray<string> = [
  SERVICE_DOOR_PATH,
  "/assets/*",
  "/sw.js",
  "/manifest.webmanifest",
];

/** The host's paths and every registered row's claim, in one list. */
export function reservedPaths(rows: ReadonlyArray<ClaimedRoutes>): ReadonlyArray<string> {
  return [...HOST_PATHS, ...rows.flatMap((row) => row.paths)];
}

/**
 * Does a path belong to a route odu itself composed? Three claim forms:
 *
 *   - exact (`/nix-cache-info`);
 *   - a WALK, ending in `*` — one or more characters after the prefix, so
 *     `/cache/` itself is not the cache's (and the shell answering it is the
 *     shell answering a typo);
 *   - a REGEX, beginning `~`, for a path that cannot be spelled as a prefix.
 *     The cache's bucket-domain narinfo (a 32-character base32 hash, then
 *     `.narinfo`) is the case: a prefix claim would take every one-segment
 *     path the shell owns.
 *
 * Claim entries are odu's own, written beside the routes; a regex here is not
 * user input.
 */
export function isReserved(path: string, reserved: ReadonlyArray<string>): boolean {
  return reserved.some((one) => {
    if (one.startsWith("~")) return new RegExp(one.slice(1)).test(path);
    if (!one.endsWith("*")) return path === one;
    const prefix = one.slice(0, -1);
    return path.length > prefix.length && path.startsWith(prefix);
  });
}
