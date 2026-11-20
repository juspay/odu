import {
  type ClaimedRoutes,
  type RouteClaim,
  routeClaim,
  SERVICE_DOOR_PATH,
  SERVICE_ROWS_PATH,
} from "@odu/cordis/services";
import { METRICS_PATH } from "@odu/cordis/metricsSurface";

export const HOST_PATHS: ReadonlyArray<string> = [
  SERVICE_DOOR_PATH,
  SERVICE_ROWS_PATH,
  METRICS_PATH,
  "/assets/*",
  "/sw.js",
  "/manifest.webmanifest",
];

const HOST_CLAIMS: ReadonlyArray<RouteClaim> = HOST_PATHS.map(routeClaim);

export function reservedClaims(rows: ReadonlyArray<ClaimedRoutes>): ReadonlyArray<RouteClaim> {
  return [...HOST_CLAIMS, ...rows.flatMap((row) => row.paths)];
}

export function isReserved(path: string, claims: ReadonlyArray<RouteClaim>): boolean {
  return claims.some((claim) => {
    switch (claim.kind) {
      case "regex":
        return claim.pattern.test(path);
      case "walk":
        return path.length > claim.prefix.length && path.startsWith(claim.prefix);
      case "exact":
        return path === claim.path;
    }
  });
}
