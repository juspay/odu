/**
 * THE METRICS VERBS' HANDLERS — the host's own fragment, mounted on the composed
 * bundle beside the rows.
 *
 * The shape is `@odu/cordis/metricsSurface`'s (a row may not import the host, so
 * the surface lives in the vocabulary both sides share); the behaviour is here,
 * because the credential is the host's: it opens the host's route, and no row
 * issues it.
 *
 * **The authority rule is the cache row's, deliberately.** Administering a
 * daemon means the same thing whichever administrative verb you reach for: a
 * signed-in `admin` may, a signed-in `member` may not, and a caller with no
 * identity — which is every caller on a daemon with no door — presents the
 * operator's root token. Copying the rule rather than inventing a second one is
 * what makes "the root token administers this server" a sentence that stays
 * true.
 */

import { Effect } from "effect";
import type { ImplementSurfaceDeps } from "@kolu/surface/server";
import { may, principalOf } from "@odu/cordis/principal";
import { MetricsRefused, oduMetricsSurface } from "@odu/cordis/metricsSurface";
import { rootTokenMatches, type MetricsTokenStore } from "./metricsTokens";

export type MetricsSurfaceDeps = ImplementSurfaceDeps<(typeof oduMetricsSurface)["spec"]>;

/** A label nobody gave. Kept rather than refused: an unlabelled token is still
 *  listable and still revocable, which is what the id is for. */
const UNLABELLED = "unlabelled";

export function metricsFragment(options: {
  readonly tokens: MetricsTokenStore;
  readonly rootToken: string | null;
}): MetricsSurfaceDeps {
  /** One administrative call, with this fragment's authority rule applied
   *  first. The work is synchronous — a JSON file, not a database — so there is
   *  no promise to map, only a refusal to raise. */
  const admin = <A>(
    input: { rootToken: string },
    work: () => A | MetricsRefused,
  ): Effect.Effect<A, MetricsRefused> =>
    Effect.flatMap(principalOf, (principal) => {
      if (principal.kind === "user") {
        if (!may(principal, "admin")) {
          return Effect.fail(
            new MetricsRefused({
              code: "not_permitted",
              message:
                `odu: the metrics credential is an administrator's — ${principal.login} ` +
                `is a ${principal.role}`,
            }),
          );
        }
      } else if (!rootTokenMatches(options.rootToken, input.rootToken)) {
        return Effect.fail(
          new MetricsRefused({
            code: "no_root_token",
            message:
              options.rootToken === null
                ? "this service was started without a root token, so no metrics " +
                  "credential can be issued or read — set $ODU_ROOT_TOKEN and restart it"
                : "the root token does not match this service's $ODU_ROOT_TOKEN",
          }),
        );
      }
      const answer = work();
      return answer instanceof MetricsRefused ? Effect.fail(answer) : Effect.succeed(answer);
    });

  return {
    procedures: {
      token: {
        mint: ({ input }) =>
          admin(input, () => {
            const label = (input.label ?? "").trim();
            return options.tokens.mint(label === "" ? UNLABELLED : label);
          }),
        list: ({ input }) => admin(input, () => ({ tokens: options.tokens.list() })),
        revoke: ({ input }) =>
          admin(input, () =>
            options.tokens.revoke(input.id)
              ? { id: input.id, revoked: true }
              : new MetricsRefused({
                  code: "bad_input",
                  message: `odu: no metrics token "${input.id}" — \`odu surface metrics token_list\` names them`,
                }),
          ),
      },
    },
  };
}
