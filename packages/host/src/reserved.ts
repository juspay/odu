import {
  type ClaimedRoutes,
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
