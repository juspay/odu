import type { ServedGeneration } from "@kolu/surface/expose";
import type { Layer } from "effect";
import {
  reportSurfaceAppEvent,
  type ServeSurfaceAppOptions,
  type SurfaceAppConnection,
  type SurfaceAppHttpMiddleware,
} from "@kolu/surface-app/serve";
import type { UpgradeHeadersSource } from "@kolu/surface-app/upgrade-headers";

type ServeRoutes = NonNullable<ServeSurfaceAppOptions["routes"]>;

export interface ServingParts<Svc = never, H extends string = never> {
  /** The served generation, read at EVERY accept: the rooted runtime's served
   *  set moves when the control sibling mounts, and a snapshot taken at bind
   *  would serve a roster that no longer matches the handlers. */
  live: () => ServedGeneration;
  /** The built browser bundle. NOT optional: `serveSurfaceApp` treats a missing
   *  `clientDist` as "no static route" and a nonexistent one as a 404 — it will
   *  not fail for you — so the packaged contract is asserted by the lifecycle
   *  before this is read. */
  dist: string;
  /** The app's own routes, merged alongside the shell. MERGED, not ordered:
   *  `HttpRouter` ranks by specificity, so a literal `/mcp` route beats the
   *  shell's `GET /*` catch-all either way round.
   */
  routes?: ServeRoutes;
  allowedOrigins: ReadonlyArray<string>;
  host: string;
  port: number;
  upgradeHeaders?: UpgradeHeadersSource<H>;
  services?: (connection: SurfaceAppConnection<H>) => Layer.Layer<Svc>;
  middleware?: SurfaceAppHttpMiddleware;
}

const MANIFEST: NonNullable<ServeSurfaceAppOptions["manifest"]> = {
  name: "odu",
  themeColor: "#0a0d0c",
  icons: [],
};

export function servingOptions<Svc = never, H extends string = never>(
  parts: ServingParts<Svc, H>,
): ServeSurfaceAppOptions<Svc, H> {
  return {
    live: parts.live,
    clientDist: parts.dist,
    manifest: MANIFEST,
    host: parts.host,
    port: parts.port,
    allowedOrigins: parts.allowedOrigins,
    ...(parts.routes === undefined ? {} : { routes: parts.routes }),
    ...(parts.upgradeHeaders === undefined
      ? {}
      : { upgradeHeaders: parts.upgradeHeaders }),
    ...(parts.services === undefined ? {} : { services: parts.services }),
    ...(parts.middleware === undefined ? {} : { middleware: parts.middleware }),
    onEvent: reportSurfaceAppEvent,
  };
}
