import type { Principal } from "@odu/cordis/principal";

export interface Caller {
  readonly hostsFile: string | null;
  readonly principal: Principal;
}

/**
 * Assemble the caller from a verb input.
 *
 * The three readings are kept, not flattened: absent becomes `null` (use the
 * service's own configuration), `""` stays `""` (the caller's shell had none),
 * and a path stays a path. The first two mean opposite things downstream, which
 * is why this is `?? null` and not `?? ""`.
 */
export function callerOf(
  input: {
    readonly hostsFile?: string | undefined;
  },
  principal: Principal,
): Caller {
  return { hostsFile: input.hostsFile ?? null, principal };
}

/**
 * `@local` and not `local`, because the field is one string space shared with
 * GitHub logins and it is DURABLE: every manifest already written spells its
 * answer, and the `ci` contract publishes it.
 */
export const LOCAL_ACTOR = "@local";

export function actorOf(principal: Principal): string {
  return principal.kind === "local" ? LOCAL_ACTOR : principal.login;
}
