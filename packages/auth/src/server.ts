/**
 * THE AUTH ROW, AS A ROW — the resolver the host's broker holds, the surface's
 * implementation, and the database behind both.
 *
 * ## What this row owns, and what it registers
 *
 * It owns sign-in: the GitHub App's flow, the sessions a browser carries, the
 * personal tokens a CLI or an agent carries, and the grants that decide a
 * person's role. It does NOT own the listener — the host does, which is why the
 * host's `PrincipalBroker` is a contract this row REGISTERS ON rather than
 * something it provides:
 *
 *   - `apply` opens the database, builds the resolver, registers it on the
 *     broker, mounts the surface beside the runs and the cache, and adds the
 *     three OAuth routes.
 *   - The finalizers run in reverse and the order is the safe one: the sweep
 *     stops, the mount drops, the resolver withdraws, the database closes. A
 *     connection still holding a lease when the database closed would read a
 *     torn-down table; a resolver withdrawn while the mount stands is the ask
 *     it was built for.
 *
 * ## Sessions are leases, and the row is what ends them
 *
 * `acquire` answers a LEASE per connection; the lease is what a connection
 * watches. Logging out, revoking a token, a role change and the expiry sweep
 * all call the resolver's own `end`, which fires every watcher — so a connection
 * that loses its session answers nothing more and its open subscriptions are
 * interrupted. There is no revocation list anybody polls.
 *
 * ## Where the secrets live
 *
 * A session row is stored by the SHA-256 of its cookie value and a token by the
 * SHA-256 of its secret, so the database is not a bag of credentials. The
 * cookie's value and the token's plaintext exist only in the answers that
 * minted them.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { Effect } from "effect";
import { definePlugin } from "@olai/effect-cordis";
import type { ImplementSurfaceDeps } from "@kolu/surface/server";
import type { Logger } from "@kolu/surface-daemon";
import type { Role } from "@odu/cordis/principal";
import {
  admissionOf,
  makeLease,
  PrincipalBroker as PrincipalBrokerTag,
  type Lease,
  type Principal,
  type PrincipalBroker,
  type PrincipalResolver,
} from "@odu/cordis/principal";
import {
  Bundle,
  Log,
  RootToken,
  Routes,
  StateDir,
} from "@odu/cordis/services";
import { openAuthRepo, type AuthRepo, type SessionRow, type TokenRow } from "./db";
import { normalizeLogin, type GithubConfig } from "./github";
import { authRoutes } from "./routes";
import {
  AUTH_KEY,
  AuthRefused,
  DEFAULT_ROLE,
  oduAuthSurface,
  type AuthSession,
  type AuthToken,
  type Who,
} from "./surface";

type AuthSpec = (typeof oduAuthSurface)["spec"];
export type AuthSurfaceDeps = ImplementSurfaceDeps<AuthSpec>;

/** The cookie a browser's session rides. */
export const SESSION_COOKIE = "odu_session";

/** How long a sign-in lasts, measured FROM THE SIGN-IN to its expiry.
 *
 *  Using a session records `lastSeen` and does NOT extend it: a session has one
 *  end, so "signed in on Monday" is a session in four weeks and not a session
 *  that a tab left open keeps alive forever. The cookie's own `max-age` is this
 *  same number (`./routes`), so a browser drops it when the row does. */
export const SESSION_DAYS = 30;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** The value of one cookie out of a `Cookie:` header. */
export function cookieValue(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== name) continue;
    const value = part.slice(at + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

/** The token out of an `Authorization:` header, or null.
 *
 *  Parsed by index rather than by expression: the header is attacker-controlled,
 *  and `^Bearer\s+(.+)$` backtracks quadratically over a run of spaces (CodeQL
 *  said so, correctly). This walk is linear whatever the header holds. */
export function bearerValue(header: string | undefined): string | null {
  if (header === undefined) return null;
  const trimmed = header.trim();
  const scheme = "bearer";
  if (trimmed.length <= scheme.length) return null;
  if (trimmed.slice(0, scheme.length).toLowerCase() !== scheme) return null;
  let at = scheme.length;
  while (at < trimmed.length && isSpace(trimmed[at] as string)) at++;
  // At least one space between the scheme and the token, and a token after it.
  if (at === scheme.length) return null;
  const token = trimmed.slice(at);
  return token === "" ? null : token;
}

/** The whitespace a header's field-content may carry between two words — the
 *  RFC's OWS plus the line folds a proxy may have removed. */
function isSpace(character: string): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}

export interface AuthServerOptions {
  readonly config: GithubConfig;
  readonly repo: AuthRepo;
  /** `$ODU_ROOT_TOKEN`, or null. The bootstrap of the first owner, and nothing
   *  else. */
  readonly rootToken: string | null;
  readonly now?: () => number;
  readonly log?: Pick<Logger, "warn">;
}

export interface AuthServer {
  readonly surface: typeof oduAuthSurface;
  readonly deps: AuthSurfaceDeps;
  readonly resolver: PrincipalResolver;
  /** Create a session for a sign-in and answer the cookie's own value. */
  signIn(input: { readonly login: string; readonly agent: string | null }): {
    readonly cookie: string;
    readonly session: SessionRow;
  };
  /** End the session a cookie names — sign-out. Answers whether there was one. */
  signOut(cookie: string | null): boolean;
  /** End every lease a login holds, without touching its sessions. A role
   *  change takes effect at the next connection. */
  endLogin(login: string): void;
  /** End expired sessions, and every lease still open on one. */
  sweep(): void;
  closeDatabase(): void;
}

interface Held {
  readonly login: string;
  readonly session: string | null;
  readonly token: string | null;
  end(): void;
}

const tokenView = (row: TokenRow): AuthToken => ({
  id: row.id,
  name: row.name,
  created: row.created,
  lastUsed: row.lastUsed,
  expires: row.expires,
  revoked: row.revoked,
});

const sessionView = (row: SessionRow): AuthSession => ({
  id: row.id,
  created: row.created,
  lastSeen: row.lastSeen,
  expires: row.expires,
  agent: row.agent,
});

const anonymous: Who = { kind: "anonymous" };

const unauthenticated = (): AuthRefused =>
  new AuthRefused({
    code: "unauthenticated",
    message: "odu: this connection has no session — sign in to this daemon first",
  });

const notPermitted = (what: string): AuthRefused =>
  new AuthRefused({ code: "not_permitted", message: `odu: ${what}` });

export function authServer(opts: AuthServerOptions): AuthServer {
  const { repo, config } = opts;
  const now = opts.now ?? Date.now;
  /** Every connection's lease, so a session can end them all at once. */
  const held = new Set<Held>();

  const principalFor = (login: string): Principal => ({
    kind: "user",
    login,
    role: repo.grant(login)?.role ?? DEFAULT_ROLE,
  });

  const endWhere = (match: (entry: Held) => boolean): void => {
    for (const entry of [...held]) if (match(entry)) entry.end();
  };

  /** End every open connection a login holds — a role change takes effect at
   *  the next connection, and a signed-out or revoked one at once. */
  const endLogin = (login: string): void => {
    endWhere((entry) => entry.login === login);
  };

  /** One connection's hold on one session — the shared lease machine
   *  (`@odu/cordis/principal`'s {@link makeLease}), plus the row's registry so a
   *  logout, a revocation, a role change or the sweep can end it. `request`
   *  never returns the same lease twice, and `watch` fires exactly once. */
  const hold = (owner: { login: string; session?: string; token?: string }): Lease => {
    let entry: Held | null = null;
    const mine = makeLease(principalFor(owner.login), () => {
      if (entry !== null) held.delete(entry);
    });
    entry = {
      login: owner.login,
      session: owner.session ?? null,
      token: owner.token ?? null,
      end: mine.end,
    };
    held.add(entry);
    return {
      principal: mine.lease.principal,
      watch: mine.lease.watch,
      release: () => {
        if (entry !== null) held.delete(entry);
        mine.lease.release();
      },
    };
  };

  const liveSession = (hash: string): SessionRow | null => {
    const row = repo.session(hash);
    if (row === null) return null;
    if (row.expires <= now()) {
      repo.deleteSession(row.id);
      endWhere((entry) => entry.session === row.id);
      return null;
    }
    repo.touchSession(row.id, now());
    return row;
  };

  const liveToken = (hash: string): TokenRow | null => {
    const row = repo.tokenByHash(hash);
    if (row === null || row.revoked) return null;
    if (row.expires !== null && row.expires <= now()) return null;
    repo.touchToken(row.id, now());
    return row;
  };

  const resolver: PrincipalResolver = {
    acquire(headers) {
      const cookie = cookieValue(headers["cookie"], SESSION_COOKIE);
      if (cookie !== null) {
        const row = liveSession(sha256(cookie));
        if (row !== null) return hold({ login: row.login, session: row.id });
      }
      // The CLI and the MCP bridge carry a personal token on the upgrade; the
      // provisioned header allowlist is what lets it arrive at all.
      const token = bearerValue(headers["authorization"]);
      if (token !== null) {
        const row = liveToken(sha256(token));
        if (row !== null) return hold({ login: row.login, token: row.id });
      }
      return null;
    },
    authorize(authorization) {
      const token = bearerValue(authorization);
      if (token === null) return null;
      const row = liveToken(sha256(token));
      return row === null ? null : principalFor(row.login);
    },
  };

  /** The caller's login, or a refusal. A `local` principal is not a person and
   *  has no tokens or sessions of its own — this row is not mounted in loopback
   *  mode at all. */
  const signedIn = (): Effect.Effect<{ login: string; role: Role }, AuthRefused> =>
    Effect.flatMap(admissionOf, (admission) => {
      const who = admission.principal;
      if (who === null || who.kind !== "user") return Effect.fail(unauthenticated());
      return Effect.succeed({ login: who.login, role: who.role });
    });

  /** The root token, compared without leaking its length or contents. */
  const rootTokenMatches = (offered: string): boolean =>
    opts.rootToken !== null &&
    timingSafeEqual(Buffer.from(sha256(offered)), Buffer.from(sha256(opts.rootToken)));

  /** The owners this daemon already has. One is enough to make the root token's
   *  job done — it bootstraps the FIRST owner and nothing else. */
  const owners = (): ReadonlyArray<string> =>
    repo.grants().filter((grant) => grant.role === "owner").map((grant) => grant.login);

  const deps: AuthSurfaceDeps = {
    procedures: {
      user: {
        whoami: () =>
          Effect.map(admissionOf, (admission) => ({
            who: admission.principal ?? anonymous,
          })),
        grant: ({ input }) =>
          Effect.flatMap(admissionOf, (admission) => {
            const who = admission.principal;
            if (who === null) {
              if (!rootTokenMatches(input.rootToken)) {
                return Effect.fail(
                  notPermitted(
                    "granting a role needs a signed-in owner — or, on a daemon with " +
                      "no owner yet, the operator's root token ($ODU_ROOT_TOKEN)",
                  ),
                );
              }
              // THE ROOT TOKEN'S ONE JOB, exactly once. It creates the first
              // owner; after that every grant is an owner's, which is what makes
              // it a bootstrap rather than a second administrator.
              const existing = owners();
              if (existing.length > 0) {
                return Effect.fail(
                  notPermitted(
                    `this daemon already has an owner (${existing.join(", ")}) — the ` +
                      "root token only bootstraps the first one; sign in as an owner " +
                      "to grant roles",
                  ),
                );
              }
              if (input.role !== "owner") {
                return Effect.fail(
                  notPermitted(
                    `the root token bootstraps the first OWNER and nothing else — ` +
                      `sign in as that owner to grant "${input.role}"`,
                  ),
                );
              }
            } else if (who.kind === "user" && who.role !== "owner") {
              return Effect.fail(
                notPermitted(`granting a role is an owner's verb — ${who.login} is a ${who.role}`),
              );
            }
            const login = normalizeLogin(input.login);
            repo.setGrant({ login, role: input.role, created: now() });
            // The role is read at the upgrade, so a change takes effect at the
            // NEXT connection: the open ones are ended, the clients redial, and
            // each arrives with the role it now has.
            endLogin(login);
            return Effect.succeed({ login, role: input.role });
          }),
      },

      token: {
        create: ({ input }) =>
          Effect.flatMap(signedIn(), ({ login }) => {
            const token = `odu_${randomBytes(32).toString("base64url")}`;
            const row: TokenRow = {
              id: randomBytes(9).toString("hex"),
              hash: sha256(token),
              login,
              name: input.name,
              created: now(),
              lastUsed: null,
              expires: null,
              revoked: false,
            };
            repo.putToken(row);
            return Effect.succeed({ token, facts: tokenView(row) });
          }),
        list: () =>
          Effect.flatMap(signedIn(), ({ login }) =>
            Effect.succeed({ tokens: repo.tokens(login).map(tokenView) }),
          ),
        revoke: ({ input }) =>
          Effect.flatMap(signedIn(), ({ login }) => {
            if (!repo.tokens(login).some((row) => row.id === input.id)) {
              return Effect.fail(
                new AuthRefused({
                  code: "unknown",
                  message: `odu: no token "${input.id}" of yours`,
                }),
              );
            }
            const revoked = repo.revokeToken(input.id);
            // A revocation takes effect NOW: every connection that token opened
            // stops answering, and its open subscriptions are interrupted.
            endWhere((entry) => entry.token === input.id);
            return Effect.succeed({ id: input.id, revoked });
          }),
      },

      session: {
        list: () =>
          Effect.flatMap(signedIn(), ({ login }) =>
            Effect.succeed({ sessions: repo.sessions(login).map(sessionView) }),
          ),
        end: ({ input }) =>
          Effect.flatMap(signedIn(), ({ login }) => {
            if (!repo.sessions(login).some((row) => row.id === input.id)) {
              return Effect.fail(
                new AuthRefused({
                  code: "unknown",
                  message: `odu: no session "${input.id}" of yours`,
                }),
              );
            }
            repo.deleteSession(input.id);
            endWhere((entry) => entry.session === input.id);
            return Effect.succeed({ id: input.id, ended: true });
          }),
      },
    },
  };

  const signIn: AuthServer["signIn"] = ({ login, agent }) => {
    const cookie = randomBytes(32).toString("base64url");
    const at = now();
    const session: SessionRow = {
      id: sha256(cookie),
      login,
      created: at,
      lastSeen: at,
      expires: at + SESSION_DAYS * 24 * 60 * 60 * 1000,
      agent,
    };
    repo.putSession(session);
    return { cookie, session };
  };

  return {
    surface: oduAuthSurface,
    deps,
    resolver,
    signIn,
    signOut(cookie) {
      if (cookie === null) return false;
      const hash = sha256(cookie);
      const row = repo.session(hash);
      if (row === null) return false;
      repo.deleteSession(hash);
      endWhere((entry) => entry.session === hash);
      return true;
    },
    endLogin(login) {
      endWhere((entry) => entry.login === login);
    },
    sweep() {
      for (const row of repo.expiredSessions(now())) {
        repo.deleteSession(row.id);
        endWhere((entry) => entry.session === row.id);
      }
    },
    closeDatabase() {
      for (const entry of [...held]) entry.end();
      held.clear();
      repo.close();
    },
  };
}

// ── the row ─────────────────────────────────────────────────────────────────

/** How often an expired session is noticed. A minute is invisible to a person
 *  and cheap for the database; expiry is also checked on every use, so this only
 *  decides how fast an IDLE connection stops being one. */
const SWEEP_MS = 60_000;

/**
 * THE ROW AS A PLUGIN.
 *
 * `config` is passed in rather than read here: the host is the one place that
 * reads an environment, and a row that read its own would be a second one.
 */
export const authRow = (config: GithubConfig) =>
  definePlugin({
    name: AUTH_KEY,
    needs: [Bundle, Routes, StateDir, Log, RootToken, PrincipalBrokerTag],
    apply: Effect.gen(function* () {
      const bundle = yield* Bundle;
      const routes = yield* Routes;
      const stateDir = yield* StateDir;
      const log = yield* Log;
      const rootToken = yield* RootToken;
      const broker: PrincipalBroker = yield* PrincipalBrokerTag;

      // ACQUIRE, THEN ARRANGE THE RELEASE — one pair at a time, in this order,
      // so a failure ANYWHERE below unwinds everything above it. That is what
      // makes "a refused second claim installs nothing" true at the ROW and not
      // only at the broker: the mount, the routes and the database all come
      // after the claim, and the claim's own refusal throws with the database's
      // release already registered.
      //
      // Finalizers run in REVERSE, so they run: stop the sweep, withdraw the
      // routes, drop the mount, withdraw the resolver, close the database.
      const repo = openAuthRepo(join(stateDir, "auth", "auth.sqlite"));
      // The server owns the last word on its database — it ends every lease
      // still held before closing it — so the release names the server once it
      // exists, and the bare database only if the server itself never did.
      let server: AuthServer | null = null;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (server === null) repo.close();
          else server.closeDatabase();
        }),
      );

      const auth = authServer({ config, repo, rootToken, log });
      server = auth;
      // THE CLAIM. A second resolver is refused by the broker and installs
      // nothing; this row failing here is the sentence that says two rows
      // decided they own the door.
      const withdraw = broker.register(auth.resolver);
      yield* Effect.addFinalizer(() => Effect.sync(withdraw));

      const mounted = bundle.mount(AUTH_KEY, auth.surface, auth.deps);
      yield* Effect.addFinalizer(() => Effect.promise(() => mounted.drop()));

      const deregister = routes.add(authRoutes({ config, server: auth, log }));
      yield* Effect.addFinalizer(() => Effect.sync(deregister));

      const sweep = setInterval(() => auth.sweep(), SWEEP_MS);
      sweep.unref?.();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          clearInterval(sweep);
        }),
      );

      log.info(
        { origin: config.origin, publicOrigin: config.publicOrigin, allow: config.allow },
        "odu web: the auth row is serving — this daemon has a door",
      );
    }),
  });

/** Re-exported for the composition root's roster, so it names one door. */
export { AUTH_AGENT, AUTH_ANONYMOUS_TAGS, AUTH_KEY } from "./surface";

/** The environment reader and its outcome, for the host that mounts this row:
 *  the HOST reads the environment, and this is the row's own grammar for it. */
export { readGithubConfig, type GithubConfig, type GithubConfigReading } from "./github";

/** The page the HOST's middleware renders for an anonymous browser — the door's
 *  look, owned by the door, rendered without the bundle. */
export { signInPageHtml } from "./routes";
