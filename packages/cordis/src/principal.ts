/**
 * WHO IS ON THIS CONNECTION — the host's question, in the vocabulary its rows
 * read.
 *
 * The host owns the listener, so it owns "who is on it"; a row owns sign-in,
 * sessions and tokens, because that is a feature with a surface, a server, a
 * CLI and a face. The two meet HERE: the host provides a `PrincipalBroker`, a
 * row that knows how to sign somebody in registers a RESOLVER on it, and every
 * verb reads the answer through `CurrentPrincipal`.
 *
 * ## Three values, and why they are three
 *
 *   - {@link Principal} is WHAT a verb acts for: the machine's own owner
 *     (`local`), or a signed-in person with a role.
 *   - {@link Admission} is WHAT A CONNECTION IS: a principal, or `null` when
 *     the connection carries no session, plus the fact that the session behind
 *     it may END. The lease is acquired at the upgrade, so the connection must
 *     be able to learn that it ended without asking anybody.
 *   - {@link PrincipalBroker} is the host's single-owner registration key: a
 *     resolver installs itself in `apply` and withdraws in its finalizer, and
 *     with none registered every connection is the local owner — which is
 *     exactly what loopback mode is today.
 *
 * **The absence behaviour is stated, not implied.** No resolver ⇒ every
 * connection is `local`, every Bearer is the local owner, and nothing refuses.
 * That is the loopback mode preserved by construction rather than by a flag,
 * and it is why the existing unit, CLI and browser suites need no edit.
 *
 * **A refused connection has no principal.** It is not a third role: the gate
 * in front of the served handlers refuses every member except the few that
 * must answer without a session (the daemon's identity, and the auth row's own
 * `whoami`). A verb that asks anyway dies, loudly, because reaching it means
 * the gate was bypassed.
 *
 * This module names no row and no `@odu/*` package — it is the shared
 * vocabulary, and both sides must be able to open it.
 */

import { Context, Effect, Option, Schema } from "effect";
import { serviceTag } from "@olai/effect-cordis";

// ── the principal ───────────────────────────────────────────────────────────

/** The three roles, and the order is the authority: an owner administers an
 *  admin's work. Carried as a TYPE here and nothing more — what a `member` may
 *  do is `ci`'s rule, what an `admin` may do is `cache`'s. */
export const RoleSchema = Schema.Literals(["owner", "admin", "member"]);
export type Role = typeof RoleSchema.Type;

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

/** The machine's own owner — what a connection is when no identity provider is
 *  mounted. Not an administrator, and not "anonymous": this is the person who
 *  started the daemon on their own loopback. */
export const LocalPrincipalSchema = Schema.Struct({ kind: Schema.Literal("local") });

/** A signed-in person, with the role this daemon granted them. */
export const UserPrincipalSchema = Schema.Struct({
  kind: Schema.Literal("user"),
  login: Schema.String,
  role: RoleSchema,
});

/** WHO A VERB ACTS FOR. Discriminated on `kind`, so a `Schema.Union` and not a
 *  `Schema.TaggedUnion` — the wire spelling is fixed by the auth surface's
 *  `whoami` answer. */
export const PrincipalSchema = Schema.Union([LocalPrincipalSchema, UserPrincipalSchema]);
export type Principal = typeof PrincipalSchema.Type;

/** The one principal that exists when nobody signed in. */
export const LOCAL_OWNER: Principal = { kind: "local" };

/**
 * MAY THIS PRINCIPAL DO SOMETHING THAT NEEDS `floor`?
 *
 * The local owner passes every floor: with no identity provider mounted there
 * is nobody else the daemon could be protecting itself from, and this is the
 * rule that keeps loopback mode byte-for-byte what it was. A signed-in person
 * must hold the role or better.
 */
export function may(principal: Principal, floor: Role): boolean {
  return principal.kind === "local" || RANK[principal.role] >= RANK[floor];
}

// ── the admission ───────────────────────────────────────────────────────────

/**
 * WHAT ONE CONNECTION IS, for as long as it lasts.
 *
 * `principal` is `null` when the upgrade carried no valid session and a
 * resolver is mounted — the gate refuses such a connection everything but the
 * identity reads. `live()` answers whether the session behind it still exists,
 * so a call placed after logout, expiry or revocation is refused rather than
 * served on a session that is gone. `ended` completes once, at that moment, and
 * is what a streaming member watches so a subscription stops pushing to a
 * connection whose session has ended — the socket itself is kolu's to hold,
 * and no public seam lets odu close it (see PLAN.md's correction).
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

/** The service a verb reads. Absent (a unit test, an in-process dispatch that
 *  has not provided one) means the loopback owner. */
export class CurrentPrincipal extends Context.Service<CurrentPrincipal, Admission>()(
  "odu/CurrentPrincipal",
) {}

/** What the LOCAL connection is: admitted as the owner, with nothing to end. */
export const LOCAL_ADMISSION: Admission = {
  principal: LOCAL_OWNER,
  live: () => true,
  ended: Effect.never,
};

/** A connection that carried no session. The gate in front of the handlers is
 *  what makes this safe; this value only says what it is. */
export const NOBODY_ADMISSION: Admission = {
  principal: null,
  live: () => false,
  ended: Effect.void,
};

/** Raised when a refused connection's verb ran anyway. A DEFECT, not a
 *  refusal: the gate exists so this is unreachable, and a sentence on the
 *  error channel would invite a caller to handle it. */
export class NoPrincipal extends Error {
  readonly _tag = "NoPrincipal";
  constructor() {
    super(
      "odu: this connection carries no principal — every verb but the identity " +
        "reads is refused on a connection without a session",
    );
  }
}

/** The admission this call runs under. Absent context is the local owner. */
export const admissionOf: Effect.Effect<Admission> = Effect.map(
  Effect.serviceOption(CurrentPrincipal),
  (held) => Option.getOrElse(held, () => LOCAL_ADMISSION),
);

/** Who this call acts for. Dies on a refused connection — see {@link NoPrincipal}. */
export const principalOf: Effect.Effect<Principal> = Effect.flatMap(
  admissionOf,
  (admission) =>
    admission.principal === null
      ? Effect.die(new NoPrincipal())
      : Effect.succeed(admission.principal),
);

// ── the lease ───────────────────────────────────────────────────────────────

/**
 * ONE CONNECTION'S HOLD ON ONE SESSION.
 *
 * Acquired at the upgrade and released in the same step (the host wraps both in
 * `Effect.acquireRelease`), so an interrupted bind cannot leave a lease with no
 * owner. {@link Lease.watch} is how the connection learns that the session
 * ENDED — logout, expiry, revocation — and it is a push, never a poll: there is
 * no revocation list to look at.
 */
export interface Lease {
  readonly principal: Principal;
  /** Follow this lease. `end` runs exactly once, at the end of the session or
   *  of the lease, whichever comes first; it runs IMMEDIATELY for a lease that
   *  has already ended. Returns the withdrawal. */
  watch(end: () => void): () => void;
  /** The connection is gone. Idempotent, and it does not run the watchers. */
  release(): void;
}

/** A lease and the resolver's handle on it: `end` is what the SESSION's owner
 *  calls when the session stops existing. */
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

/** The admission a lease's connection runs under: live until the lease ends. */
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

// ── the broker ──────────────────────────────────────────────────────────────

/**
 * What a row that knows how to sign somebody in implements.
 *
 * Both doors are here because they are one decision — "who does this credential
 * name" — read at two places: a websocket upgrade carries a session COOKIE and
 * gets a LEASE, and an HTTP request (the MCP door) carries a BEARER token and
 * gets a principal for that one request. A resolver answers `null` for a
 * credential it does not recognise, which is the gate's cue to refuse.
 */
export interface PrincipalResolver {
  /** The lease this websocket upgrade carries, or `null` for no session. */
  acquire(headers: Readonly<Record<string, string | undefined>>): Lease | null;
  /** The principal this `Authorization` header names, or `null`. */
  authorize(authorization: string | undefined): Principal | null;
}

/**
 * THE HOST'S BROKER, always present.
 *
 * A single-owner registration: the first resolver installs, a second is REFUSED
 * and installs nothing, and the withdrawal that `register` returns removes only
 * the resolver that installed it — so a row that unloads cannot clear a
 * successor's registration.
 */
export interface PrincipalBroker {
  /** Install a resolver. Returns its withdrawal. Throws
   *  {@link PrincipalClaimRefused} if one is already installed. */
  register(resolver: PrincipalResolver): () => void;
  /** The lease a websocket upgrade carries — the local owner's when no resolver
   *  is installed. */
  acquire(headers: Readonly<Record<string, string | undefined>>): Lease | null;
  /** The principal a Bearer credential names — the local owner's when no
   *  resolver is installed. */
  authorize(authorization: string | undefined): Principal | null;
  /** Is an identity provider mounted? The gate's one question about mode. */
  mounted(): boolean;
}

/** A second resolver claimed the broker. A distinct class so a row's `apply`
 *  can fail with a sentence rather than a message match. */
export class PrincipalClaimRefused extends Error {
  readonly _tag = "PrincipalClaimRefused";
  constructor() {
    super(
      "odu: a principal resolver is already installed on this daemon — exactly " +
        "one row may decide who is on a connection",
    );
  }
}

/** The host's broker. ONE per daemon, made by whoever owns the tenure. */
export const PrincipalBroker = serviceTag<PrincipalBroker>("odu:principal");

/** A broker with no resolver: every connection is the local owner, which is
 *  loopback mode. Made once per daemon by the host. */
export function localBroker(): PrincipalBroker {
  // A CLAIM, not the resolver: two registrations of the SAME resolver object
  // are still two claims, and a withdrawal that compared values could clear a
  // successor's slot. The token is what a withdrawal compares.
  let installed: { readonly resolver: PrincipalResolver } | null = null;
  return {
    register(next) {
      if (installed !== null) throw new PrincipalClaimRefused();
      const claim = { resolver: next };
      installed = claim;
      return () => {
        if (installed === claim) installed = null;
      };
    },
    acquire(headers) {
      return installed === null
        ? makeLease(LOCAL_OWNER).lease
        : installed.resolver.acquire(headers);
    },
    authorize(authorization) {
      return installed === null ? LOCAL_OWNER : installed.resolver.authorize(authorization);
    },
    mounted: () => installed !== null,
  };
}
