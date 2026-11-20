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

export type BucketRouting =
  | { readonly kind: "page"; readonly bucket: string }
  | { readonly kind: "passthrough" }
  | { readonly kind: "notMine" };

export function bucketRouting(
  host: string,
  path: string,
  domains: BucketDomains,
): BucketRouting {
  const named = domains.current().find((one) => one.domain === host);
  if (named === undefined) return { kind: "passthrough" };
  if (path === "" || path === "/") return { kind: "page", bucket: named.bucket };
  const owner = domains.bucketOf(path);
  if (owner === named.bucket) return { kind: "passthrough" };
  if (owner !== null) return { kind: "notMine" };
  return isReserved(path, domains.paths)
    ? { kind: "passthrough" }
    : { kind: "notMine" };
}

export function bucketDomainGate(
  facts: () => BucketDomains | undefined,
): SurfaceAppHttpMiddleware {
  return <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      const domains = facts();
      if (domains === undefined) return app;
      const path = request.url.split("?")[0] ?? request.url;
      const routing = bucketRouting(hostOf(request.headers["host"]), path, domains);
      switch (routing.kind) {
        case "passthrough":
          return app;
        case "notMine":
          return Effect.succeed(missing());
        case "page":
          return Effect.provideService(
            app,
            HttpServerRequest.HttpServerRequest,
            request.modify({ url: `/cache/${encodeURIComponent(routing.bucket)}` }),
          );
      }
    });
}
