import { Effect } from "effect";
import { may, principalOf, type Principal } from "@odu/cordis/principal";
import type { CacheOutcome } from "./cache";
import { CacheRefused } from "./surface";

const roleSeal: unique symbol = Symbol("odu:cache/role");

export type Authority =
  | { readonly kind: "root"; readonly rootToken: string }
  | { readonly kind: "role"; readonly login: string; readonly [roleSeal]: true };

export function roleAuthority(login: string): Authority {
  return { kind: "role", login, [roleSeal]: true };
}

export function mintedByThisRow(authority: Authority): boolean {
  return authority.kind === "role" && roleSeal in authority && authority[roleSeal] === true;
}

export interface CacheGate {
  answer<A, B>(
    work: () => Promise<CacheOutcome<A>>,
    map: (value: A) => B,
  ): Effect.Effect<B, CacheRefused>;
  admin<A, B>(
    input: { rootToken: string },
    work: (authority: Authority) => Promise<CacheOutcome<A>>,
    map: (value: A) => B,
  ): Effect.Effect<B, CacheRefused>;
  member<A, B>(
    input: { rootToken: string },
    work: (authority: Authority) => Promise<CacheOutcome<A>>,
    map: (value: A) => B,
  ): Effect.Effect<B, CacheRefused>;
}

export function cacheGate(): CacheGate {
  const answer = <A, B>(
    work: () => Promise<CacheOutcome<A>>,
    map: (value: A) => B,
  ): Effect.Effect<B, CacheRefused> =>
    Effect.flatMap(Effect.promise(work), (outcome) =>
      outcome.ok
        ? Effect.succeed(map(outcome.value))
        : Effect.fail(new CacheRefused({ code: outcome.code, message: outcome.message })),
    );

  const authorityOf = (principal: Principal, input: { rootToken: string }): Authority =>
    principal.kind === "user"
      ? roleAuthority(principal.login)
      : { kind: "root", rootToken: input.rootToken };

  return {
    answer,
    admin: (input, work, map) =>
      Effect.flatMap(principalOf, (principal) => {
        if (principal.kind === "user" && !may(principal, "admin")) {
          return Effect.fail(
            new CacheRefused({
              code: "not_permitted",
              message:
                `odu: administering a bucket needs an admin — ${principal.login} ` +
                `is a ${principal.role}`,
            }),
          );
        }
        return answer(() => work(authorityOf(principal, input)), map);
      }),
    member: (input, work, map) =>
      Effect.flatMap(principalOf, (principal) =>
        answer(() => work(authorityOf(principal, input)), map),
      ),
  };
}
