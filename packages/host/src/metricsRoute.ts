/**
 * The path is RESERVED (`./reserved`'s `HOST_PATHS`), so a daemon with a door
 * does not answer a scrape with its sign-in page — the route and its claim are
 * declared together here for exactly that reason.
 */

import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { EXPOSITION_CONTENT_TYPE, scrape, type MetricsSources } from "@odu/cordis/metrics";
import { METRICS_PATH } from "@odu/cordis/metricsSurface";
import type { MetricsTokenStore } from "./metricsTokens";
import { rootTokenMatches } from "./metricsTokens";

export function bearerOf(header: string | undefined): string {
  const raw = (header ?? "").trim();
  const space = raw.indexOf(" ");
  if (space === -1) return "";
  if (raw.slice(0, space).toLowerCase() !== "bearer") return "";
  return raw.slice(space + 1).trim();
}

export interface MetricsRouteOptions {
  readonly sources: MetricsSources;
  readonly rootToken: string | null;
  readonly tokens: MetricsTokenStore;
}

const REFUSAL =
  "odu: /metrics needs `Authorization: Bearer <token>` — the operator's " +
  "$ODU_ROOT_TOKEN, or a metrics token from `odu surface metrics token_mint`";

export function metricsRoute(options: MetricsRouteOptions) {
  return HttpRouter.add("GET", METRICS_PATH, () =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      const presented = bearerOf(request.headers["authorization"]);
      const admitted =
        presented !== "" &&
        (rootTokenMatches(options.rootToken, presented) || options.tokens.verify(presented));
      if (!admitted) {
        return Effect.succeed(
          HttpServerResponse.text(REFUSAL, {
            status: 401,
            headers: { "www-authenticate": 'Bearer realm="odu metrics"', "cache-control": "no-store" },
          }),
        );
      }
      return Effect.map(
        Effect.promise(() => scrape(options.sources)),
        (body) =>
          HttpServerResponse.text(body, {
            contentType: EXPOSITION_CONTENT_TYPE,
            headers: { "cache-control": "no-store" },
          }),
      );
    }),
  );
}
