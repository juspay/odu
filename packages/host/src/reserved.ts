/**
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
 */

import {
  type ClaimedRoutes,
  SERVICE_DOOR_PATH,
  SERVICE_ROWS_PATH,
} from "@odu/cordis/services";
import { METRICS_PATH } from "@odu/cordis/metricsSurface";

export const HOST_PATHS: ReadonlyArray<string> = [
  SERVICE_DOOR_PATH,
  SERVICE_ROWS_PATH,
  // THE SCRAPE. Reserved, so a daemon with a door answers a Prometheus with an
  // exposition (or a 401 it can report) rather than with the sign-in page.
  METRICS_PATH,
  "/assets/*",
  "/sw.js",
  "/manifest.webmanifest",
];

export function reservedPaths(rows: ReadonlyArray<ClaimedRoutes>): ReadonlyArray<string> {
  return [...HOST_PATHS, ...rows.flatMap((row) => row.paths)];
}

export function isReserved(path: string, reserved: ReadonlyArray<string>): boolean {
  return reserved.some((one) => {
    if (one.startsWith("~")) return new RegExp(one.slice(1)).test(path);
    if (!one.endsWith("*")) return path === one;
    const prefix = one.slice(0, -1);
    return path.length > prefix.length && path.startsWith(prefix);
  });
}
