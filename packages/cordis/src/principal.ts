import { Context, Effect, Option, Schema } from "effect";
import { serviceTag } from "@olai/effect-cordis";
import { singleOwnerSlot } from "./slot";

export const RoleSchema = Schema.Literals(["owner", "admin", "member"]);
export type Role = typeof RoleSchema.Type;

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export const LocalPrincipalSchema = Schema.Struct({ kind: Schema.Literal("local") });

export const UserPrincipalSchema = Schema.Struct({
  kind: Schema.Literal("user"),
  login: Schema.String,
  role: RoleSchema,
});

export const PrincipalSchema = Schema.Union([LocalPrincipalSchema, UserPrincipalSchema]);
export type Principal = typeof PrincipalSchema.Type;

export const LOCAL_OWNER: Principal = { kind: "local" };

export function may(principal: Principal, floor: Role): boolean {
  return principal.kind === "local" || RANK[principal.role] >= RANK[floor];
}

/**
 * `principal` is `null` when the upgrade carried no valid session and a
 * resolver is mounted. `live()` answers whether the session behind it still
 * exists. `ended` completes once, at that moment.
 */
export interface Admission {
  /** Who this connection acts for, or `null` for a connection with no session. */
  readonly principal: Principal | null;
  /** Is the session behind this connection still one? */
  readonly live: () => boolean;
  /** Completes when the session ends. Never, for a connection that has none to
   *  lose. */
  readonly ended: Effect.Effect<void>;
}

export class CurrentPrincipal extends Context.Service<CurrentPrincipal, Admission>()(
  "odu/CurrentPrincipal",
) {}

export const LOCAL_ADMISSION: Admission = {
  principal: LOCAL_OWNER,
  live: () => true,
  ended: Effect.never,
};

export const NOBODY_ADMISSION: Admission = {
  principal: null,
  live: () => false,
  ended: Effect.void,
};

export class NoPrincipal extends Error {
  readonly _tag = "NoPrincipal";
  constructor() {
    super(
      "odu: this connection carries no principal — every verb but the identity " +
        "reads is refused on a connection without a session",
    );
  }
}

export const admissionOf: Effect.Effect<Admission> = Effect.map(
  Effect.serviceOption(CurrentPrincipal),
  (held) => Option.getOrElse(held, () => LOCAL_ADMISSION),
);

export const principalOf: Effect.Effect<Principal> = Effect.flatMap(
  admissionOf,
  (admission) =>
    admission.principal === null
      ? Effect.die(new NoPrincipal())
      : Effect.succeed(admission.principal),
);

export interface Lease {
  readonly principal: Principal;
  /** Follow this lease. `end` runs exactly once, at the end of the session or
   *  of the lease, whichever comes first; it runs IMMEDIATELY for a lease that
   *  has already ended. Returns the withdrawal. */
  watch(end: () => void): () => void;
  /** The connection is gone. Idempotent, and it does not run the watchers. */
  release(): void;
}

export function makeLease(
  principal: Principal,
  onRelease?: () => void,
): { readonly lease: Lease; readonly end: () => void } {
  const watchers = new Set<() => void>();
  let ended = false;
  const finish = (): void => {
    if (ended) return;
    ended = true;
    const all = [...watchers];
    watchers.clear();
    for (const watcher of all) watcher();
    onRelease?.();
  };
  return {
    lease: {
      principal,
      watch(end) {
        if (ended) {
          end();
          return () => {};
        }
        watchers.add(end);
        return () => {
          watchers.delete(end);
        };
      },
      release() {
        watchers.clear();
        ended = true;
        onRelease?.();
      },
    },
    end: finish,
  };
}

export function admissionFor(lease: Lease | null): Admission {
  if (lease === null) return NOBODY_ADMISSION;
  let live = true;
  const waiters = new Set<() => void>();
  lease.watch(() => {
    live = false;
    for (const wake of [...waiters]) wake();
    waiters.clear();
  });
  return {
    principal: lease.principal,
    live: () => live,
    ended: Effect.callback<void>((resume) => {
      if (!live) {
        resume(Effect.void);
        return Effect.void;
      }
      const wake = (): void => resume(Effect.void);
      waiters.add(wake);
      return Effect.sync(() => {
        waiters.delete(wake);
      });
    }),
  };
}

/** A resolver answers `null` for a credential it does not recognise. */
export interface PrincipalResolver {
  /** The lease this websocket upgrade carries, or `null` for no session. */
  acquire(headers: Readonly<Record<string, string | undefined>>): Lease | null;
  /** The principal this `Authorization` header names, or `null`. */
  authorize(authorization: string | undefined): Principal | null;
}

/** A single-owner registration: the first resolver installs, a second is
 *  REFUSED and installs nothing, and the withdrawal that `register` returns
 *  removes only the resolver that installed it. */
export interface PrincipalBroker {
  /** Install a resolver. Returns its withdrawal. Throws
   *  {@link PrincipalClaimRefused} if one is already installed. */
  register(resolver: PrincipalResolver): () => void;
  /** The lease a websocket upgrade carries — the local owner's when no resolver
   *  is installed and this daemon has no door; `null` (nobody) when it has one. */
  acquire(headers: Readonly<Record<string, string | undefined>>): Lease | null;
  /** The principal a Bearer credential names — the local owner's or nobody, by
   *  the same rule. */
  authorize(authorization: string | undefined): Principal | null;
  /** Is an identity provider mounted? A RUNNING fact — false while the door's
   *  row is starting, stopping, or has failed. */
  mounted(): boolean;
  /** DOES THIS DAEMON HAVE A DOOR? A BOOT fact: true when the host read the
   *  door's configuration, whatever the row is doing right now. The gate asks
   *  THIS one — a door whose row is down must refuse, not fall open. */
  hasDoor(): boolean;
}

export class PrincipalClaimRefused extends Error {
  readonly _tag = "PrincipalClaimRefused";
  constructor() {
    super(
      "odu: a principal resolver is already installed on this daemon — exactly " +
        "one row may decide who is on a connection",
    );
  }
}

export const PrincipalBroker = serviceTag<PrincipalBroker>("odu:principal");

export function localBroker(options: { readonly door?: boolean } = {}): PrincipalBroker {
  const door = options.door === true;
  const slot = singleOwnerSlot<PrincipalResolver>(() => new PrincipalClaimRefused());
  return {
    register: (next) => slot.claim(next),
    acquire(headers) {
      const resolver = slot.held();
      if (resolver !== null) return resolver.acquire(headers);
      return door ? null : makeLease(LOCAL_OWNER).lease;
    },
    authorize(authorization) {
      const resolver = slot.held();
      if (resolver !== null) return resolver.authorize(authorization);
      return door ? null : LOCAL_OWNER;
    },
    mounted: () => slot.held() !== null,
    hasDoor: () => door,
  };
}

export function requestAdmission(principal: Principal): Admission {
  return { principal, live: () => true, ended: Effect.never };
}
