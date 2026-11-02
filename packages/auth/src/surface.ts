/**
 * THE AUTH ROW'S CONTRACT — who is asking, and the three things a person can do
 * about it.
 *
 * This is the browser-safe half: the shapes, the verbs, the tagged refusal and
 * what an agent is told. `./server` implements it, `./cli` projects it as argv,
 * `./face` renders it, and none of those are reachable from here — so a board
 * can hold an auth client without holding a database, a GitHub client or a
 * secret.
 *
 * ## The verbs, and who may call each
 *
 * | verb | rule |
 * | --- | --- |
 * | `whoami` | anyone the gate lets through, anonymous included — it is how a page learns it is anonymous |
 * | `token.create` | a signed-in person, for themselves |
 * | `token.list`, `token.revoke` | a signed-in person, for their own tokens |
 * | `session.list`, `session.end` | a signed-in person, for their own sessions |
 * | `grant` | an `owner` — or the ROOT token, which is its one job: bootstrapping the first owner |
 * | `grant.list` | an `owner` — who is in, and the role each holds |
 *
 * **`grant` is why the anonymous gate list exists.** A fresh daemon has no
 * owner, so `odu auth grant <login> owner` is made with the operator's root
 * token and NO session at all. The host's gate refuses such a connection every
 * member except the tags in {@link AUTH_ANONYMOUS_TAGS}; the handler then
 * decides on its own.
 */

import { type Principal, PrincipalSchema, RoleSchema } from "@odu/cordis/principal";
import type { RowAgent } from "@odu/cordis/services";
import { defineSurface } from "@kolu/surface/define";
import type { ExposeMap } from "@kolu/surface/expose";
import { Schema } from "effect";

/** The word this row is served under — the sibling segment on the wire, the
 *  subcommand in argv, and the word the browser folds its health under. */
export const AUTH_KEY = "auth";

/**
 * THIS ROW'S OWN CONTRACT VERSION, `major.minor` — the door's surface below and
 * nothing served beside it. The host publishes it on the identity cell's `rows`
 * and a client that reads the door is admitted against it; one that does not is
 * never refused because it moved. The rule is the host's: the MINOR when the
 * surface only grows, the MAJOR when something a reader uses changes.
 * `contract.test.ts` pins it to a fingerprint of the surface.
 *
 * 2.4: where the composed wire stood when each row took a version of its own.
 */
export const AUTH_CONTRACT_VERSION = "2.4";

/** THE DOOR AND NOTHING ELSE — what `odu auth …` declares, in the shape
 *  `admitService` takes. Required: there is nothing to do without a door. */
export const AUTH_NEEDS = { [AUTH_KEY]: AUTH_CONTRACT_VERSION } as const;

/** THE SIGN-IN PAGE'S WORDS, once — the server-rendered page (`./routes`) and
 *  the browser's own copy (`./face`) say the same three things, and a page an
 *  operator meets before JavaScript must not read differently from the one a
 *  tab draws a moment later. `title` is the heading AND the tab: spelling it
 *  once is what keeps a document called "Sign in to odu · odu". */
export const SIGN_IN_COPY = {
  title: "Sign in to odu",
  hint: "This server answers only to people its operator has allowed in.",
  action: "Sign in with GitHub",
} as const;

/** Where a person starts a sign-in — the link the sign-in page renders. */
export const AUTH_SIGN_IN_PATH = "/auth/github";
/** Where GitHub sends them back. Registered on the App, byte for byte. */
export const AUTH_CALLBACK_PATH = "/auth/github/callback";
/** Where the header's "sign out" posts. A form, so the HttpOnly cookie is the
 *  server's to clear. */
export const AUTH_SIGN_OUT_PATH = "/auth/signout";

// ── who ─────────────────────────────────────────────────────────────────────

/** A page with no session. Not a role and not a principal: it is the ABSENCE
 *  of one, answered so a browser can show a sign-in form instead of an empty
 *  board. */
export const AnonymousSchema = Schema.Struct({ kind: Schema.Literal("anonymous") });
export type Anonymous = typeof AnonymousSchema.Type;

/** What `whoami` answers: the connection's principal, or nobody. */
export const WhoSchema = Schema.Union([AnonymousSchema, PrincipalSchema]);
export type Who = typeof WhoSchema.Type;

// ── sessions and tokens ─────────────────────────────────────────────────────

/** One session, as its owner sees it. The ID is the session's own opaque
 *  handle — a hash of the cookie's value, so listing it reveals nothing a
 *  holder of the cookie could use. */
export const AuthSessionSchema = Schema.Struct({
  id: Schema.String,
  /** When the browser first signed in. */
  created: Schema.Number,
  /** The last request any of its connections served. */
  lastSeen: Schema.Number,
  /** When it stops being a session, signed in or not. */
  expires: Schema.Number,
  /** What the browser said it was, when it said anything. */
  agent: Schema.NullOr(Schema.String),
});
export type AuthSession = typeof AuthSessionSchema.Type;

/** One personal access token, as its owner sees it. The plaintext appears
 *  exactly once, in the answer that minted it — the row keeps a hash. */
export const AuthTokenSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  created: Schema.Number,
  lastUsed: Schema.NullOr(Schema.Number),
  expires: Schema.NullOr(Schema.Number),
  revoked: Schema.Boolean,
});
export type AuthToken = typeof AuthTokenSchema.Type;

// ── the refusal ─────────────────────────────────────────────────────────────

/**
 * Why the auth row declined.
 *
 * Its own class for the reason `CacheRefused` is: a refusal raised here decodes
 * without the runs' contract, so the sign-in face can branch on it.
 */
export const AuthRefusalCodeSchema = Schema.Literals([
  /** This connection has no session, and the verb needs one. */
  "unauthenticated",
  /** Signed in, and not allowed: a `member` asking an owner's verb. */
  "not_permitted",
  /** No such token, or no such session (already ended, or never yours). */
  "unknown",
  /** A grant naming something that is not a login, or a role that is not one. */
  "bad_input",
  /** GitHub would not complete the sign-in, and the reason is written for a
   *  person — an expiring token, a refused membership, a failed exchange. */
  "github_refused",
]);
export type AuthRefusalCode = typeof AuthRefusalCodeSchema.Type;

export class AuthRefused extends Schema.TaggedError<AuthRefused>("@odu/auth/AuthRefused")(
  "AuthRefused",
  {
    code: AuthRefusalCodeSchema,
    message: Schema.String,
  },
) {}

const REFUSES = AuthRefused;

// ── inputs and outputs ──────────────────────────────────────────────────────

const WhoamiOutputSchema = Schema.Struct({ who: WhoSchema });

const TokenCreateInputSchema = Schema.Struct({
  /** Checked by the ROW (non-empty), not the schema — see `GrantInputSchema`. */
  name: Schema.String,
  /** Absent means the token does not expire. The FACES default to ninety days
   *  and make "never" a visible choice, so a person never gets one by silence. */
  expiresDays: Schema.optionalKey(Schema.Int),
});
const TokenCreateOutputSchema = Schema.Struct({
  /** Shown ONCE. The row keeps a hash. */
  token: Schema.String,
  facts: AuthTokenSchema,
});
const TokenListOutputSchema = Schema.Struct({ tokens: Schema.Array(AuthTokenSchema) });
const TokenRevokeInputSchema = Schema.Struct({ id: Schema.String });
const TokenRevokeOutputSchema = Schema.Struct({ id: Schema.String, revoked: Schema.Boolean });

const SessionListOutputSchema = Schema.Struct({ sessions: Schema.Array(AuthSessionSchema) });
const SessionEndInputSchema = Schema.Struct({ id: Schema.String });
const SessionEndOutputSchema = Schema.Struct({ id: Schema.String, ended: Schema.Boolean });

const GrantInputSchema = Schema.Struct({
  /** Checked by the ROW (non-empty), not the schema: a schema check dies before
   *  the row can say why, and the people page sends the field as typed. */
  login: Schema.String,
  role: RoleSchema,
  /** The operator's bootstrap. Compared only when the caller has no session;
   *  ignored otherwise, because a signed-in owner already carries authority. */
  rootToken: Schema.String,
});
const GrantOutputSchema = Schema.Struct({
  login: Schema.String,
  role: RoleSchema,
});

/**
 * ONE PERSON WHO IS IN, as an owner sees them on the people page.
 *
 * Two sources, folded: the GRANTS (a role somebody set) and the logins that
 * have EVER signed in — the row's durable `person` record, which sign-out and
 * expiry do not touch (GitHub let them through; with no grant they hold
 * {@link DEFAULT_ROLE}). The second set is why this is not just the grant
 * table — a person allowed in and never granted anything is exactly who an
 * owner opens this page to promote.
 */
export const AuthPersonSchema = Schema.Struct({
  login: Schema.String,
  role: RoleSchema,
  /** False when the role is the default, never granted. */
  granted: Schema.Boolean,
  /** The latest activity of any of their sessions; null for a grant made to
   *  somebody who has not signed in yet. */
  lastSeen: Schema.NullOr(Schema.Number),
});
export type AuthPerson = typeof AuthPersonSchema.Type;

const GrantListOutputSchema = Schema.Struct({ people: Schema.Array(AuthPersonSchema) });

// ── the surface ─────────────────────────────────────────────────────────────

/**
 * Sign-in, as one row.
 *
 * **Names are `row_noun_verb`, like every row.** The framework derives a tool
 * name as `<sibling>_<namespace>_<verb>` and a wire tag as
 * `surface/<sibling>/<namespace>/<verb>`, so a verb with no noun between them
 * cannot exist — `auth_whoami` would need a flat procedure the surface model
 * does not have. The nouns chosen here are the SUBJECT: `user` for who you are
 * and what you may do, `token` for a personal token, `session` for a signed-in
 * browser. The argv face keeps the brief's names exactly (`odu auth whoami`,
 * `odu auth token create`, …) because it is hand-written grammar, not a
 * derivation.
 *
 * No collections and no cells: a session list is read when the profile page
 * opens, and a page that kept a live subscription to its own tokens would be a
 * page that updates when somebody else revokes one — which is `whoami`'s job on
 * the next call, not a subscription's.
 */
export const oduAuthSurface = defineSurface({
  procedures: {
    user: {
      // NO `input`, not `Schema.Struct({})`: the framework's no-input form is a
      // `Void` payload. An EMPTY STRUCT is not the same thing to a projection —
      // an MCP host sends a tool with no declared inputs no arguments at all,
      // and decoding `undefined` against a struct is "Expected object | array",
      // which is how `auth_user_whoami` answered every agent as a TOOL ERROR.
      whoami: { output: WhoamiOutputSchema, error: REFUSES },
      grant: { input: GrantInputSchema, output: GrantOutputSchema, error: REFUSES },
    },
    // `grant.list` and not `user.list`: its subject is the ROLE TABLE (who holds
    // what), which is what `user.grant` writes — the people page reads the one
    // and calls the other.
    grant: {
      list: { output: GrantListOutputSchema, error: REFUSES },
    },
    token: {
      create: { input: TokenCreateInputSchema, output: TokenCreateOutputSchema, error: REFUSES },
      list: { output: TokenListOutputSchema, error: REFUSES },
      revoke: { input: TokenRevokeInputSchema, output: TokenRevokeOutputSchema, error: REFUSES },
    },
    session: {
      list: { output: SessionListOutputSchema, error: REFUSES },
      end: { input: SessionEndInputSchema, output: SessionEndOutputSchema, error: REFUSES },
    },
  },
});

export type OduAuthSurface = typeof oduAuthSurface;

// ── what a browser and an agent may reach ───────────────────────────────────

/**
 * WHAT AN AGENT MAY REACH, and what each verb is called.
 *
 * `grant` is a tool: an agent asked to bootstrap a deployment is the case this
 * row exists for, and it carries the same rule a person's call does. `mutates`
 * is the framework's safety default (an unannotated procedure is treated as
 * mutating so an MCP host confirms it), spelled per entry.
 */
export const ODU_AUTH_EXPOSE = {
  "user.whoami": { tool: { mutates: false } },
  "user.grant": { tool: { mutates: true } },
  "grant.list": { tool: { mutates: false } },
  "token.create": { tool: { mutates: true } },
  "token.list": { tool: { mutates: false } },
  "token.revoke": { tool: { mutates: true } },
  "session.list": { tool: { mutates: false } },
  "session.end": { tool: { mutates: true } },
} as const satisfies ExposeMap<(typeof oduAuthSurface)["spec"]>;

/** THE TAGS A CONNECTION WITH NO SESSION MAY STILL ASK.
 *
 * Two, and each is load-bearing: `whoami` is how an anonymous page learns it is
 * anonymous, and `grant` is how the first owner exists at all (the root token,
 * and nothing else, is what authorises it). Every other tag stays shut. */
export const AUTH_ANONYMOUS_TAGS: Readonly<Record<string, true>> = {
  "surface/auth/user/whoami": true,
  "surface/auth/user/grant": true,
};

/** What an agent is told about this row. */
export const ODU_AUTH_MCP_INSTRUCTIONS = [
  "The auth verbs are this daemon's door, as their own row — they exist ONLY",
  "on a daemon with a door, which is exactly the daemon that serves them.",
  "`auth_user_whoami` answers who this connection is: a `user` with a role, or",
  "`anonymous` when the connection has no session (that is a page before it",
  "signs in, not an error). `odu auth whoami` exits 1 on `anonymous` — the",
  "answer is printed, and the exit code says whether it is a person.",
  "`auth_token_create` mints a personal access token and answers it ONCE (only",
  "its hash is kept); `odu auth login <origin>` stores it, and every face then",
  "reaches this server with `--origin`. `auth_token_revoke` and",
  "`auth_session_end` end a credential everywhere at once — an open connection",
  "stops being served. `auth_user_grant` sets a login's role and is an owner's",
  "verb; on a daemon with no owner yet the operator's root token may set the",
  "FIRST owner with it, and that is that token's only job. `auth_grant_list`",
  "answers who is in — every grant and every login that has ever signed in,",
  "with the role each holds — and is an owner's verb too. A grant that would",
  "leave the daemon with no owner is refused.",
].join("\n");

export const AUTH_AGENT: RowAgent = {
  surface: oduAuthSurface,
  expose: ODU_AUTH_EXPOSE,
  instructions: ODU_AUTH_MCP_INSTRUCTIONS,
};

/** The role this daemon gives somebody who is allowed in but has never been
 *  granted anything. */
export const DEFAULT_ROLE = "member";
