import type { Principal } from "@odu/cordis/principal";

export interface Caller {
  readonly hostsFile: string | null;
  readonly principal: Principal;
}

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
