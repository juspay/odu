/**
 * THE DOOR'S THREE HTTP ROUTES — sign in, the callback GitHub sends a person
 * back to, and sign out.
 *
 * They are routes rather than surface verbs because two of them are a BROWSER
 * NAVIGATION: a link to GitHub is a GET, and GitHub's redirect lands in an
 * address bar. The session it writes is a cookie, and a cookie is only settable
 * on an ordinary HTTP response.
 *
 * ## The state cookie, and why it is signed
 *
 * `state` is CSRF protection: the value the browser carries to GitHub must come
 * back unchanged, and it must be one this daemon minted. The nonce travels in
 * the query and the HMAC (keyed by the App's client secret — server-held, never
 * on a page) travels in an HttpOnly cookie; the callback requires both to agree.
 * A forged callback has neither the secret nor a browser's cookie.
 *
 * ## What a refused sign-in sees
 *
 * A PAGE, with the reason in it. A person whose GitHub account is not in
 * `ODU_GITHUB_ALLOW`, or whose App issues expiring tokens, has to learn that
 * from the thing they clicked — not from a daemon log they cannot read.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Logger } from "@kolu/surface-daemon";
import type { RowRoutes } from "@odu/cordis/services";
import {
  authorizeUrl,
  exchangeCode,
  fetchLogin,
  membership,
  type GithubConfig,
} from "./github";
import { SESSION_COOKIE, type AuthServer } from "./server";
import {
  AUTH_CALLBACK_PATH,
  AUTH_SIGN_IN_PATH,
  AUTH_SIGN_OUT_PATH,
} from "./surface";

/** The three paths, declared in the browser-safe contract because the sign-in
 *  page renders two of them. */
export {
  AUTH_CALLBACK_PATH,
  AUTH_SIGN_IN_PATH,
  AUTH_SIGN_OUT_PATH,
} from "./surface";

/** The CSRF nonce's cookie. HttpOnly, same-site, ten minutes. */
export const STATE_COOKIE = "odu_oauth_state";

const STATE_MINUTES = 10;

export interface AuthRoutesOptions {
  readonly config: GithubConfig;
  readonly server: AuthServer;
  readonly log: Pick<Logger, "warn">;
  /** Injected by a test; the stub is reached through the config's origins. */
  readonly request?: typeof fetch;
  readonly now?: () => number;
}

/** `nonce.mac` — the nonce is the query value, the mac proves this daemon made
 *  it. */
function signedState(secret: string): string {
  const nonce = randomBytes(24).toString("base64url");
  const mac = createHmac("sha256", secret).update(nonce).digest("base64url");
  return `${nonce}.${mac}`;
}

function stateIsOurs(secret: string, value: string): boolean {
  const at = value.lastIndexOf(".");
  if (at <= 0) return false;
  const nonce = value.slice(0, at);
  const offered = Buffer.from(value.slice(at + 1));
  const expected = Buffer.from(
    createHmac("sha256", secret).update(nonce).digest("base64url"),
  );
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

/** The one HTML escape this file needs: a refusal quotes GitHub and a login. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** A refusal a person reads, with the way back to try again. */
function refusalPage(status: number, message: string): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.text(
    `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>odu — sign-in refused</title></head>
  <body>
    <main>
      <h1>Sign-in refused</h1>
      <p>${escapeHtml(message)}</p>
      <p><a href="${AUTH_SIGN_IN_PATH}">Try again</a></p>
    </main>
  </body>
</html>`,
    { status, contentType: "text/html; charset=utf-8" },
  );
}

/** Set one cookie on a response, synchronously — the router's handlers answer
 *  with a response value. */
function withCookie(
  response: HttpServerResponse.HttpServerResponse,
  name: string,
  value: string,
  options: { readonly secure: boolean; readonly maxAge: `${number} minutes` },
): HttpServerResponse.HttpServerResponse {
  return Effect.runSync(
    HttpServerResponse.setCookie(name, value, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: options.secure,
      maxAge: options.maxAge,
    })(response),
  );
}

export function authRoutes(opts: AuthRoutesOptions): RowRoutes {
  const { config, server } = opts;
  const request = opts.request ?? fetch;
  const secure = config.publicOrigin.startsWith("https://");

  const signIn = HttpRouter.add("GET", AUTH_SIGN_IN_PATH, () =>
    Effect.sync(() => {
      const state = signedState(config.clientSecret);
      const response = HttpServerResponse.redirect(authorizeUrl(config, state), { status: 302 });
      return withCookie(response, STATE_COOKIE, state, {
        secure,
        maxAge: `${STATE_MINUTES} minutes`,
      });
    }),
  );

  const callback = HttpRouter.add("GET", AUTH_CALLBACK_PATH, (incoming: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const url = new URL(incoming.url, "http://odu.invalid");
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const carried = incoming.cookies[STATE_COOKIE] ?? null;
      if (state === null || state === "" || carried === null) {
        return refusalPage(
          400,
          "This looks like a callback odu did not start — begin again from the sign-in page.",
        );
      }
      if (state !== carried || !stateIsOurs(config.clientSecret, state)) {
        return refusalPage(
          400,
          "The sign-in state did not match this browser's cookie — begin again from the sign-in page.",
        );
      }
      if (code === null || code === "") {
        return refusalPage(400, "GitHub sent no authorization code — begin again.");
      }

      const exchanged = yield* Effect.promise(() => exchangeCode(config, code, request));
      if (!exchanged.ok) return refusalPage(403, exchanged.message);

      const user = yield* Effect.promise(() => fetchLogin(config, exchanged.token, request));
      if (!user.ok) return refusalPage(403, user.message);

      const entitled = yield* Effect.promise(() =>
        membership(config, exchanged.token, user.login, request),
      );
      if (!entitled.ok) {
        opts.log.warn({ login: user.login }, "odu web: a sign-in was refused by the allow-list");
        return refusalPage(
          403,
          `${user.login} is not allowed to sign in to this odu daemon. ${entitled.message}`,
        );
      }

      const session = server.signIn({
        login: user.login,
        agent: incoming.headers["user-agent"] ?? null,
      });
      opts.log.warn({ login: user.login }, "odu web: a person signed in");
      const response = HttpServerResponse.redirect("/", { status: 302 });
      const withSession = withCookie(response, SESSION_COOKIE, session.cookie, {
        secure,
        maxAge: `${30 * 24 * 60} minutes`,
      });
      // The nonce is spent.
      return withCookie(withSession, STATE_COOKIE, "", { secure, maxAge: "0 minutes" });
    }),
  );

  const signOut = HttpRouter.add("POST", AUTH_SIGN_OUT_PATH, (incoming: HttpServerRequest.HttpServerRequest) =>
    Effect.sync(() => {
      const cookie = incoming.cookies[SESSION_COOKIE] ?? null;
      const ended = server.signOut(cookie);
      if (cookie !== null) {
        opts.log.warn({ ended }, "odu web: a person signed out");
      }
      const response = HttpServerResponse.redirect("/", { status: 302 });
      return withCookie(response, SESSION_COOKIE, "", { secure, maxAge: "0 minutes" });
    }),
  );

  return Layer.merge(signIn, Layer.merge(callback, signOut));
}
