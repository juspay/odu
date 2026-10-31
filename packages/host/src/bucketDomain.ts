/**
 * A BUCKET'S OWN NAME SERVES ONLY THE BUCKET.
 *
 * A Cloudflare Tunnel forwards EVERY path of `cache.kolu.dev` to the daemon, so
 * whatever answers there must be chosen by `Host`, before routing: the board,
 * `/mcp`, `/auth` and `/rpc/ws` must not be reachable on a name a client was
 * told is a substituter, and a world-readable bucket page must not become a
 * door to the control plane.
 *
 * The gate is the host's mechanism (it owns the listener and the middleware
 * seam), and the FACTS are the cache row's (`BucketDomains`: which names, which
 * bucket, which paths). `/` is rewritten to the bucket's own page route, so the
 * page is still rendered by the row that owns it; a path the row claims passes
 * through; a path for ANOTHER bucket is the row's 404; everything else is the
 * row's 404 without entering the router.
 *
 * It runs OUTSIDE the door gate: an anonymous visitor to a bucket name must see
 * the bucket's page, not the server's sign-in form.
 */

import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { SurfaceAppHttpMiddleware } from "@kolu/surface-app/serve";
import type { BucketDomains } from "@odu/cordis/services";
import { isReserved } from "./reserved";

const missing = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text("no such cache path\n", {
    status: 404,
    contentType: "text/plain; charset=utf-8",
  });

/** `host:port` → `host`, lowercased: the spelling `BucketDomains` stores. */
const hostOf = (header: string | undefined): string => {
  const raw = (header ?? "").trim().toLowerCase();
  const colon = raw.indexOf(":");
  return colon === -1 ? raw : raw.slice(0, colon);
};

export function bucketDomainGate(
  facts: () => BucketDomains | undefined,
): SurfaceAppHttpMiddleware {
  return <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      const domains = facts();
      if (domains === undefined) return app;
      const host = hostOf(request.headers["host"]);
      const bucket = domains.current().find((one) => one.domain === host);
      if (bucket === undefined) return app;

      const path = request.url.split("?")[0] ?? request.url;
      if (path === "" || path === "/") {
        // THE BUCKET'S PAGE, RENDERED BY THE ROW: the gate only moves the
        // request to the route that already owns it.
        const rewritten = request.modify({
          url: `/cache/${encodeURIComponent(bucket.bucket)}`,
        });
        return Effect.provideService(app, HttpServerRequest.HttpServerRequest, rewritten);
      }

      // THE GRAMMAR IS THE ROW'S: `bucketOf` is part of the fact this gate was
      // handed, so the cache's mount and push paths are spelled once.
      const named = domains.bucketOf(path);
      if (named === bucket.bucket) return app;
      if (named !== null) return Effect.succeed(missing());
      return isReserved(path, domains.paths) ? app : Effect.succeed(missing());
    });
}
