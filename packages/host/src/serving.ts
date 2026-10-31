/**
 * WHAT THE LISTENER IS MADE OF — kolu's serving options, assembled from parts.
 *
 * `web.ts` is a LIFECYCLE: claim the gate, bind the listener, serve, tear down.
 * It used to also spell out what the listener is made of, inline at the bind —
 * the live surface, the built bundle, the manifest, the origin allowlist, the
 * `/mcp` routes — and those two jobs change for different reasons. A later PR
 * that adds a route layer, HTTP middleware, an upgrade-header allowlist or a
 * per-connection service stack is editing the SECOND job, and should not have to
 * do it in the middle of the gate-claim ordering that must not move.
 *
 * So the parts are named here and this is the one place they become an options
 * object. Adding a capability is adding a part — `middleware`, `upgradeHeaders`,
 * `services` — and the lifecycle does not notice.
 */

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

/** The parts a listener is built from. Each is supplied by the composition
 *  root; nothing here reads an environment or spawns anything. */
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
   *
   *  ABSENT when no row owns a route — which is what the rows' own composition
   *  answers when it has nothing to merge, rather than an empty layer standing
   *  for "no routes". */
  routes?: ServeRoutes;
  /** Browser origins allowed beyond same-origin. Same-origin is always
   *  allowed; anything else must be named. The gate runs on the RAW
   *  pre-upgrade socket, so a cross-site page never gets a connection. */
  allowedOrigins: ReadonlyArray<string>;
  host: string;
  port: number;
  /** The request headers a websocket connection is read under. odu names TWO —
   *  `cookie`, the session a sign-in wrote, and `authorization`, the personal
   *  token a CLI or an agent presents on the upgrade — and nothing else, so the
   *  rest of the upgrade's header bag is unreachable from the connection. */
  upgradeHeaders?: UpgradeHeadersSource<H>;
  /** Services ONE connection's handlers may require — the seam a per-connection
   *  fact rides, and where odu provides the connection's {@link
   *  CurrentPrincipal}. A layer, so the connection's lease is acquired and
   *  released with the connection's own scope. */
  services?: (connection: SurfaceAppConnection<H>) => Layer.Layer<Svc>;
  /** Wrap every HTTP request. odu uses it for both HTTP legs of the door: an
   *  anonymous MCP POST is `401`, and an anonymous browser asking for the shell
   *  meets the sign-in page the server renders. */
  middleware?: SurfaceAppHttpMiddleware;
}

/** The shell's fixed identity: what every odu board installs as. */
const MANIFEST: NonNullable<ServeSurfaceAppOptions["manifest"]> = {
  name: "odu",
  themeColor: "#1f6feb",
  icons: [],
};

/** The options `serveSurfaceApp` takes, from the parts above.
 *
 *  GENERIC over the header allowlist and the per-connection services so the
 *  composition root's own literal (`["cookie"]`) reaches the connection type:
 *  a widened `ReadonlyArray<string>` would make every read of
 *  `connection.headers` compile and answer `string | undefined` forever. */
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
