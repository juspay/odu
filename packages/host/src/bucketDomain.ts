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
        const rewritten = request.modify({
          url: `/cache/${encodeURIComponent(bucket.bucket)}`,
        });
        return Effect.provideService(app, HttpServerRequest.HttpServerRequest, rewritten);
      }

      const named = domains.bucketOf(path);
      if (named === bucket.bucket) return app;
      if (named !== null) return Effect.succeed(missing());
      return isReserved(path, domains.paths) ? app : Effect.succeed(missing());
    });
}
