import { composedWire } from "@odu/cordis/compose";
import type { RowFacts } from "@odu/cordis/services";
import {
  CI_NEEDS,
  ifMounted,
  oduServiceSurface,
  type RowNeeds,
} from "@odu/service-client/surface";
import { CACHE_ROW } from "@odu/cache/surface";
import { AUTH_ROW } from "@odu/auth/surface";
import { CLOUDFLARE_ROW } from "@odu/cloudflare/surface";
import { METRICS_ROW } from "@odu/cordis/metricsSurface";
import { authorizationHeaders } from "@odu/auth/credentials";
import { connectOrStart } from "@odu/launch/webLauncher";
import type { ServiceConnection } from "@odu/service-client/dial";

export const SIBLING_ROWS: ReadonlyArray<RowFacts> = [
  CACHE_ROW,
  AUTH_ROW,
  CLOUDFLARE_ROW,
  METRICS_ROW,
];

export const SERVICE_SIBLINGS = Object.fromEntries(
  SIBLING_ROWS.map((row) => [row.key as string, row.agent.surface]),
);

export const SERVICE_WIRE_GROUP = composedWire(oduServiceSurface, SERVICE_SIBLINGS);

export const EVERY_ROW_NEEDS: RowNeeds = {
  ...CI_NEEDS,
  ...Object.fromEntries(SIBLING_ROWS.map((row) => [row.name, ifMounted(row.contract)])),
};

export function connectToService(
  origin: string | undefined,
  opts: { needs: RowNeeds; warned?: Set<string> },
): Promise<ServiceConnection> {
  return connectOrStart(origin, {
    group: SERVICE_WIRE_GROUP,
    authorization: (resolved) => authorizationHeaders(process.env, resolved),
    ...opts,
  });
}
