import {
  type ClaimedRoutes,
  SERVICE_DOOR_PATH,
  SERVICE_ROWS_PATH,
} from "@odu/cordis/services";
import { METRICS_PATH } from "@odu/cordis/metricsSurface";

export type RouteClaim =
  | { readonly kind: "exact"; readonly path: string }
  | { readonly kind: "walk"; readonly prefix: string }
  | { readonly kind: "regex"; readonly pattern: RegExp };

export function routeClaim(spec: string): RouteClaim {
  if (spec.startsWith("~")) return { kind: "regex", pattern: new RegExp(spec.slice(1)) };
  if (spec.endsWith("*")) return { kind: "walk", prefix: spec.slice(0, -1) };
  return { kind: "exact", path: spec };
}

export const HOST_PATHS: ReadonlyArray<string> = [
  SERVICE_DOOR_PATH,
  SERVICE_ROWS_PATH,
  METRICS_PATH,
  "/assets/*",
  "/sw.js",
  "/manifest.webmanifest",
];

export function reservedClaims(rows: ReadonlyArray<ClaimedRoutes>): ReadonlyArray<RouteClaim> {
  return [...HOST_PATHS, ...rows.flatMap((row) => row.paths)].map(routeClaim);
}

const parsed = new WeakMap<ReadonlyArray<string>, ReadonlyArray<RouteClaim>>();

export function claimsOf(specs: ReadonlyArray<string>): ReadonlyArray<RouteClaim> {
  const already = parsed.get(specs);
  if (already !== undefined) return already;
  const claims = specs.map(routeClaim);
  parsed.set(specs, claims);
  return claims;
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
