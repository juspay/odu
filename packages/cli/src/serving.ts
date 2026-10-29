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
import {
  reportSurfaceAppEvent,
  type ServeSurfaceAppOptions,
} from "@kolu/surface-app/serve";

type ServeOptions = ServeSurfaceAppOptions;
type ServeRoutes = NonNullable<ServeOptions["routes"]>;

/** The parts a listener is built from. Each is supplied by the composition
 *  root; nothing here reads an environment or spawns anything. */
export interface ServingParts {
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
   *  shell's `GET /*` catch-all either way round. */
  routes: ServeRoutes;
  /** Browser origins allowed beyond same-origin. Same-origin is always
   *  allowed; anything else must be named. The gate runs on the RAW
   *  pre-upgrade socket, so a cross-site page never gets a connection. */
  allowedOrigins: ReadonlyArray<string>;
  host: string;
  port: number;
}

/** The shell's fixed identity: what every odu board installs as. */
const MANIFEST: NonNullable<ServeOptions["manifest"]> = {
  name: "odu",
  themeColor: "#1f6feb",
  icons: [],
};

/** The options `serveSurfaceApp` takes, from the parts above. */
export function servingOptions(parts: ServingParts): ServeOptions {
  return {
    live: parts.live,
    clientDist: parts.dist,
    manifest: MANIFEST,
    host: parts.host,
    port: parts.port,
    allowedOrigins: parts.allowedOrigins,
    routes: parts.routes,
    onEvent: reportSurfaceAppEvent,
  };
}
