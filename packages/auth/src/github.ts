/**
 * GITHUB, as little of it as this row needs — the GitHub APP's
 * authorisation-code flow, and the membership question an allow-list asks.
 *
 * **An App, not an OAuth App.** Same flow and same endpoints; what differs is
 * what a token can SEE. The App's permissions are the scope, so the
 * authorisation URL carries no `scope` parameter, and an old App asking for
 * `read:org` would be asking for something the organisation may refuse
 * separately. The App is installed on the org, which is what makes the
 * per-person membership reads on `/user/memberships/orgs/<org>` answer.
 *
 * **An expiring token is refused, not stored.** GitHub Apps can be configured
 * to expire user tokens after eight hours; this release does not store refresh
 * tokens, so holding one would be a session that dies in the middle of a work
 * day. The token response says so in `expires_in`/`refresh_token`, and the
 * sign-in is refused with a sentence naming the App setting to turn off.
 *
 * **Membership, in PR 2's shape.** The allow-list is checked with the
 * PERSON's token: `/user/memberships/orgs/<org>` for `org:`, and
 * `/orgs/<org>/teams/<slug>/memberships/<login>` for `team:`. That is what an
 * installed App with Organization → Members read can ask. PR 4 syncs
 * membership server-side from the installation token, so a removal in GitHub
 * becomes a removal in odu without waiting for the next sign-in.
 *
 * Everything network-shaped takes `fetch` as an argument: the e2e stub is a
 * tiny HTTP server pointed at with `ODU_GITHUB_ORIGIN`/`ODU_GITHUB_API`, and a
 * unit test is a fake.
 */

import { readFileSync } from "node:fs";

export interface GithubConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** `org:<name>`, `team:<org>/<slug>`, or a login — comma-separated. Kept as
   *  the SPEC rather than a parsed list, so a sentence can quote what the
   *  operator wrote. */
  readonly allow: string;
  /** Where a person authorises: `https://github.com`, or an enterprise host. */
  readonly origin: string;
  /** Where the API answers: `https://api.github.com`. */
  readonly api: string;
  /** Where THIS daemon is reached from a browser — the callback's origin. */
  readonly publicOrigin: string;
}

/** What the environment came to: nothing (the row is not mounted), a config, or
 *  a refusal to state. */
export type GithubConfigReading =
  | { readonly kind: "absent" }
  | { readonly kind: "config"; readonly config: GithubConfig }
  | { readonly kind: "refused"; readonly message: string };

const CLIENT_ID = "ODU_GITHUB_CLIENT_ID";
const CLIENT_SECRET_FILE = "ODU_GITHUB_CLIENT_SECRET_FILE";
const ALLOW = "ODU_GITHUB_ALLOW";
const ORIGIN = "ODU_GITHUB_ORIGIN";
const API = "ODU_GITHUB_API";

const filled = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
};

/**
 * READ THE ENVIRONMENT — the host's one environment read for this row.
 *
 * ABSENT means all three of client id, secret file and allow-list are unset:
 * that is the loopback deployment, and the row is not mounted. A PARTIAL set is
 * a refusal naming what is missing, because a daemon that silently stopped
 * asking for sign-in because one variable was misspelled would be a door that
 * looks shut and is not.
 */
export function readGithubConfig(
  env: Record<string, string | undefined>,
  origins: { readonly publicOrigin: string | null; readonly boundOrigin: string },
  readFile: (path: string) => string = (path) => readFileSync(path, "utf-8"),
): GithubConfigReading {
  const clientId = filled(env[CLIENT_ID]);
  const secretFile = filled(env[CLIENT_SECRET_FILE]);
  const allowText = filled(env[ALLOW]);
  if (clientId === null && secretFile === null && allowText === null) {
    return { kind: "absent" };
  }
  const missing = [
    ...(clientId === null ? [CLIENT_ID] : []),
    ...(secretFile === null ? [CLIENT_SECRET_FILE] : []),
    ...(allowText === null ? [ALLOW] : []),
  ];
  if (missing.length > 0) {
    return {
      kind: "refused",
      message:
        `odu: sign-in is half configured — ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} unset. Set all three, or none ` +
        "(none means this daemon has no door and every caller is its owner).",
    };
  }
  let clientSecret: string;
  try {
    clientSecret = readFile(secretFile as string).trim();
  } catch (err) {
    return {
      kind: "refused",
      message: `odu: cannot read $${CLIENT_SECRET_FILE}=${secretFile as string} — ${String(err)}`,
    };
  }
  if (clientSecret === "") {
    return {
      kind: "refused",
      message: `odu: $${CLIENT_SECRET_FILE}=${secretFile as string} is empty`,
    };
  }
  const allow = readAllow(allowText as string);
  if (!allow.ok) {
    return { kind: "refused", message: `odu: $${ALLOW} ${allow.message}` };
  }
  return {
    kind: "config",
    config: {
      clientId: clientId as string,
      clientSecret,
      allow: allowText as string,
      origin: filled(env[ORIGIN]) ?? "https://github.com",
      api: filled(env[API]) ?? "https://api.github.com",
      publicOrigin: origins.publicOrigin ?? origins.boundOrigin,
    },
  };
}

// ── the allow-list ──────────────────────────────────────────────────────────

export type AllowRule =
  | { readonly kind: "org"; readonly org: string }
  | { readonly kind: "team"; readonly org: string; readonly slug: string }
  | { readonly kind: "login"; readonly login: string };

/**
 * `org:<name>`, `team:<org>/<slug>`, or a GitHub login, comma-separated
 * anywhere.
 *
 * THE GRAMMAR IS ENFORCED, and a malformed entry is a REFUSAL naming it rather
 * than a rule that quietly matches nobody. `team:juspay` (no slug), `org:`
 * (empty) and a typo for `org:juspay` would all otherwise become a login no
 * GitHub account will ever have — an allow-list that locks everybody out with
 * nothing in the log to say why.
 *
 * GitHub's own grammar is the check: an organisation or login is
 * `[A-Za-z0-9][A-Za-z0-9-]{0,38}`, a team slug adds dots and underscores.
 */
export type AllowReading =
  | { readonly ok: true; readonly rules: ReadonlyArray<AllowRule> }
  | { readonly ok: false; readonly message: string };

const ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function readAllow(spec: string): AllowReading {
  const rules: AllowRule[] = [];
  for (const raw of spec.split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const lower = entry.toLowerCase();
    if (lower.startsWith("org:")) {
      const org = entry.slice("org:".length).trim();
      if (!ORG.test(org)) {
        return {
          ok: false,
          message: `"${entry}" is not an organisation rule — write \`org:<name>\` (GitHub's own name grammar: letters, digits, dashes)`,
        };
      }
      rules.push({ kind: "org", org });
      continue;
    }
    if (lower.startsWith("team:")) {
      const body = entry.slice("team:".length).trim();
      const parts = body.split("/");
      const org = parts[0]?.trim() ?? "";
      const slug = parts[1]?.trim() ?? "";
      if (parts.length !== 2 || !ORG.test(org) || !SLUG.test(slug)) {
        return {
          ok: false,
          message: `"${entry}" is not a team rule — write \`team:<org>/<slug>\``,
        };
      }
      rules.push({ kind: "team", org, slug });
      continue;
    }
    if (!LOGIN.test(entry)) {
      return {
        ok: false,
        message: `"${entry}" is not a GitHub login, an \`org:<name>\`, or a \`team:<org>/<slug>\``,
      };
    }
    rules.push({ kind: "login", login: entry });
  }
  if (rules.length === 0) {
    return { ok: false, message: "names nobody — write `org:<name>`, `team:<org>/<slug>` or a comma-separated list of logins" };
  }
  return { ok: true, rules };
}

/** `readAllow`, for a caller that has already reported a refusal. */
export function parseAllow(spec: string): AllowRule[] {
  const reading = readAllow(spec);
  return reading.ok ? [...reading.rules] : [];
}

/** The same rules, for a sentence a person reads on a refused sign-in. */
export function describeAllow(spec: string): string {
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .join(", ");
}

// ── the flow ────────────────────────────────────────────────────────────────

/** Where the callback lands — the URL registered on the App. */
export function callbackUrl(config: GithubConfig): string {
  return `${config.publicOrigin}/auth/github/callback`;
}

/**
 * WHERE A PERSON IS SENT TO AUTHORISE.
 *
 * NO `scope`: the App's permissions are the scope, and GitHub ignores a scope
 * it does not grant. `state` is the CSRF cookie's value, checked at the
 * callback.
 */
export function authorizeUrl(config: GithubConfig, state: string): string {
  const url = new URL("/login/oauth/authorize", config.origin);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", callbackUrl(config));
  url.searchParams.set("state", state);
  return url.toString();
}

export type Exchange =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly message: string };

interface TokenResponse {
  access_token?: unknown;
  error?: unknown;
  error_description?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
}

/**
 * THE AUTHORISATION CODE, EXCHANGED FOR A USER TOKEN.
 *
 * Refuses an EXPIRING token with a sentence naming the App setting — the
 * `expires_in`/`refresh_token` pair is GitHub saying the App was configured
 * with token expiry on, and this release has nowhere to keep a refresh token.
 */
export async function exchangeCode(
  config: GithubConfig,
  code: string,
  request: typeof fetch = fetch,
): Promise<Exchange> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: callbackUrl(config),
  });
  let response: Response;
  try {
    response = await request(new URL("/login/oauth/access_token", config.origin).toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  } catch (err) {
    return { ok: false, message: `odu: GitHub could not be reached — ${String(err)}` };
  }
  let payload: TokenResponse;
  try {
    payload = (await response.json()) as TokenResponse;
  } catch {
    return {
      ok: false,
      message: `odu: GitHub answered the token exchange with ${response.status} and no JSON`,
    };
  }
  if (payload.error !== undefined) {
    const described =
      typeof payload.error_description === "string"
        ? payload.error_description
        : String(payload.error);
    return { ok: false, message: `odu: GitHub refused the sign-in — ${described}` };
  }
  if (payload.expires_in !== undefined || payload.refresh_token !== undefined) {
    return {
      ok: false,
      message:
        "odu: this GitHub App issues EXPIRING user tokens, and this release " +
        "does not store refresh tokens — turn \"Expire user authorization " +
        "tokens\" OFF in the App's settings and sign in again",
    };
  }
  if (typeof payload.access_token !== "string" || payload.access_token === "") {
    return { ok: false, message: "odu: GitHub answered the token exchange with no token" };
  }
  return { ok: true, token: payload.access_token };
}

export type UserReading =
  | { readonly ok: true; readonly login: string }
  | { readonly ok: false; readonly message: string };

/** The person behind a token. */
export async function fetchLogin(
  config: GithubConfig,
  token: string,
  request: typeof fetch = fetch,
): Promise<UserReading> {
  let response: Response;
  try {
    response = await request(new URL("/user", config.api).toString(), {
      headers: apiHeaders(token),
    });
  } catch (err) {
    return { ok: false, message: `odu: GitHub could not be reached — ${String(err)}` };
  }
  if (!response.ok) {
    return {
      ok: false,
      message: `odu: GitHub answered /user with ${response.status} — the token may be expired or the App misconfigured`,
    };
  }
  const payload = (await response.json()) as { login?: unknown };
  if (typeof payload.login !== "string" || payload.login === "") {
    return { ok: false, message: "odu: GitHub answered /user with no login" };
  }
  return { ok: true, login: payload.login };
}

function apiHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    // GitHub refuses a request with no User-Agent.
    "user-agent": "odu",
    "x-github-api-version": "2022-11-28",
  };
}

export type Membership =
  | { readonly ok: true; readonly rule: AllowRule }
  | { readonly ok: false; readonly message: string };

/**
 * MAY THIS LOGIN ENTER, and by which rule?
 *
 * Rules are tried in the order written, and the first match answers. Any
 * campaign-length call is a per-sign-in cost, not a per-request one.
 */
export async function membership(
  config: GithubConfig,
  token: string,
  login: string,
  request: typeof fetch = fetch,
): Promise<Membership> {
  const rules = parseAllow(config.allow);
  if (rules.length === 0) {
    return {
      ok: false,
      message: `odu: $${ALLOW} names nobody, so nobody may sign in`,
    };
  }
  let lastFailure = "";
  for (const rule of rules) {
    if (rule.kind === "login") {
      if (rule.login.toLowerCase() === login.toLowerCase()) return { ok: true, rule };
      continue;
    }
    if (rule.kind === "org") {
      const response = await ask(
        new URL(`/user/memberships/orgs/${encodeURIComponent(rule.org)}`, config.api).toString(),
        token,
        request,
      );
      if (response.kind === "member") return { ok: true, rule };
      lastFailure = response.kind === "no" ? lastFailure : response.message;
      continue;
    }
    const response = await ask(
      new URL(
        `/orgs/${encodeURIComponent(rule.org)}/teams/${encodeURIComponent(rule.slug)}/memberships/${encodeURIComponent(login)}`,
        config.api,
      ).toString(),
      token,
      request,
    );
    if (response.kind === "member") return { ok: true, rule };
    lastFailure = response.kind === "no" ? lastFailure : response.message;
  }
  return {
    ok: false,
    message:
      lastFailure !== ""
        ? lastFailure
        : `odu: ${login} is not in this daemon's allow-list (${describeAllow(config.allow)})`,
  };
}

/** A membership probe's three outcomes: in, out, or GitHub said something we
 *  cannot read as either (and that is worth a sentence). */
type Probe =
  | { readonly kind: "member" }
  | { readonly kind: "no" }
  | { readonly kind: "error"; readonly message: string };

async function ask(url: string, token: string, request: typeof fetch): Promise<Probe> {
  let response: Response;
  try {
    response = await request(url, { headers: apiHeaders(token) });
  } catch (err) {
    return { kind: "error", message: `odu: GitHub could not be reached — ${String(err)}` };
  }
  if (response.status === 404) return { kind: "no" };
  if (!response.ok) {
    return {
      kind: "error",
      message:
        `odu: GitHub answered ${response.status} for a membership check — the ` +
        "App needs Organization → Members: read permission, and must be " +
        "installed on the organisation",
    };
  }
  const payload = (await response.json()) as { state?: unknown };
  return payload.state === "active" ? { kind: "member" } : { kind: "no" };
}
