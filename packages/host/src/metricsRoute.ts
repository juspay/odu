/**
 * `GET /metrics` — the scrape, on the host's own listener.
 *
 * **The host renders; the rows count.** Every number comes from a contributor a
 * row registered (`@odu/cordis/metrics`), so this route opens no database and
 * names no row. With nothing registered it answers a valid empty exposition:
 * "no rows mounted" is a state, not an error.
 *
 * **Never anonymous.** The deployment this is written for is public through a
 * Tailscale Funnel, where "it is only on the tailnet" stops being true the
 * moment the Funnel is on. The root token opens it, and so does a `metrics`
 * token — the credential a Prometheus holds, which can read this and nothing
 * else. A missing or unknown credential is 401 with `WWW-Authenticate`, which is
 * what a scraper's own error reporting understands.
 *
 * The path is RESERVED (`./reserved`'s `HOST_PATHS`), so a daemon with a door
 * does not answer a scrape with its sign-in page — that failure mode is how the
 * cache's push API once went missing, and the route and its claim are declared
 * together here for exactly that reason.
 */

import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { EXPOSITION_CONTENT_TYPE, scrape, type MetricsSources } from "@odu/cordis/metrics";
import { METRICS_PATH } from "@odu/cordis/metricsSurface";
import type { MetricsTokenStore } from "./metricsTokens";
import { rootTokenMatches } from "./metricsTokens";

/** `Authorization: Bearer <token>` → the token, or `""` for anything else.
 *  Basic auth is deliberately not read: a scraper sends a bearer, and a second
 *  accepted spelling is a second thing to get wrong. */
export function bearerOf(header: string | undefined): string {
  const raw = (header ?? "").trim();
  const space = raw.indexOf(" ");
  if (space === -1) return "";
  if (raw.slice(0, space).toLowerCase() !== "bearer") return "";
  return raw.slice(space + 1).trim();
}

export interface MetricsRouteOptions {
  /** The registry itself, not a thunk over it: it is made once per tenure and
   *  never replaced, and `contributors()` is already read per scrape — so a row
   *  that mounts after the listener is bound still answers the next one. */
  readonly sources: MetricsSources;
  /** The operator's root token, or `null` when none is configured. With no root
   *  token nothing can mint a metrics token either, so the route is shut — and
   *  says which variable opens it. */
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
