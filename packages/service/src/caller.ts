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

export const LOCAL_ACTOR = "@local";

export function actorOf(principal: Principal): string {
  return principal.kind === "local" ? LOCAL_ACTOR : principal.login;
}
