import { type Principal, PrincipalSchema, RoleSchema } from "@odu/cordis/principal";
import type { RowAgent, RowFacts } from "@odu/cordis/services";
import { defineSurface } from "@kolu/surface/define";
import type { ExposeMap } from "@kolu/surface/expose";
import { Schema } from "effect";

export const AUTH_KEY = "auth";

/**
 * THIS ROW'S OWN CONTRACT VERSION, `major.minor`. The rule is the host's: the MINOR when the
 * surface only grows, the MAJOR when something a reader uses changes.
 * `contract.test.ts` pins it to a fingerprint of the surface.
 */
export const AUTH_CONTRACT_VERSION = "2.4";

/** THE SIGN-IN PAGE'S WORDS, once — the server-rendered page (`./routes`) and
 *  the browser's own copy (`./face`) say the same three things, and a page an
 *  operator meets before JavaScript must not read differently from the one a
 *  tab draws a moment later. `title` is the heading AND the tab. */
export const SIGN_IN_COPY = {
  title: "Sign in to odu",
  hint: "This server answers only to people its operator has allowed in.",
  action: "Sign in with GitHub",
} as const;

export const AUTH_SIGN_IN_PATH = "/auth/github";
/** Registered on the App, byte for byte. */
export const AUTH_CALLBACK_PATH = "/auth/github/callback";
export const AUTH_SIGN_OUT_PATH = "/auth/signout";

export const AnonymousSchema = Schema.Struct({ kind: Schema.Literal("anonymous") });
export type Anonymous = typeof AnonymousSchema.Type;

export const WhoSchema = Schema.Union([AnonymousSchema, PrincipalSchema]);
export type Who = typeof WhoSchema.Type;

export const AuthSessionSchema = Schema.Struct({
  id: Schema.String,
  created: Schema.Number,
  lastSeen: Schema.Number,
  expires: Schema.Number,
  agent: Schema.NullOr(Schema.String),
});
export type AuthSession = typeof AuthSessionSchema.Type;

export const AuthTokenSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  created: Schema.Number,
  lastUsed: Schema.NullOr(Schema.Number),
  expires: Schema.NullOr(Schema.Number),
  revoked: Schema.Boolean,
});
export type AuthToken = typeof AuthTokenSchema.Type;

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

const WhoamiOutputSchema = Schema.Struct({ who: WhoSchema });

const TokenCreateInputSchema = Schema.Struct({
  /** Checked by the ROW (non-empty), not the schema — see `GrantInputSchema`. */
  name: Schema.String,
  /** Absent means the token does not expire. */
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
   *  ignored otherwise. */
  rootToken: Schema.String,
});
const GrantOutputSchema = Schema.Struct({
  login: Schema.String,
  role: RoleSchema,
});

export const AuthPersonSchema = Schema.Struct({
  login: Schema.String,
  role: RoleSchema,
  granted: Schema.Boolean,
  /** The latest activity of any of their sessions; null for a grant made to
   *  somebody who has not signed in yet. */
  lastSeen: Schema.NullOr(Schema.Number),
});
export type AuthPerson = typeof AuthPersonSchema.Type;

const GrantListOutputSchema = Schema.Struct({ people: Schema.Array(AuthPersonSchema) });

/**
 * **Names are `row_noun_verb`, like every row.** The framework derives a tool
 * name as `<sibling>_<namespace>_<verb>` and a wire tag as
 * `surface/<sibling>/<namespace>/<verb>`, so a verb with no noun between them
 * cannot exist.
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

/** THE TAGS A CONNECTION WITH NO SESSION MAY STILL ASK. Every other tag stays shut. */
export const AUTH_ANONYMOUS_TAGS: Readonly<Record<string, true>> = {
  "surface/auth/user/whoami": true,
  "surface/auth/user/grant": true,
};

export const ODU_AUTH_MCP_INSTRUCTIONS = [
  "The auth verbs are this daemon's door, as their own row — they exist ONLY",
  "on a daemon with a door, which is exactly the daemon that serves them.",
  "`auth_user_whoami` answers who this connection is: a `user` with a role, or",
  "`anonymous` when the connection has no session (that is a page before it",
  "signs in, not an error). `odu surface auth user_whoami` prints that same",
  "answer in a terminal, and the profile page shows it in a browser.",
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

export const DEFAULT_ROLE = "member";

export const AUTH_ROW: RowFacts = {
  name: AUTH_KEY,
  key: AUTH_KEY,
  agent: AUTH_AGENT,
  contract: AUTH_CONTRACT_VERSION,
};
