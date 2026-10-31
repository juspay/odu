/**
 * THE WORLDS A SCENARIO CAN DECLARE, and the one flow they share.
 *
 * Three, by tag:
 *
 * | tag | the service it gets |
 * | --- | --- |
 * | none | today's loopback daemon: no `ODU_GITHUB_*`, every caller its owner |
 * | `@anonymous` | a daemon WITH a door (`ODU_GITHUB_*` pointed at the stub), and a browser that never signed in |
 * | `@signed-in:owner\|admin\|member` | the same daemon, a session completed through the stub, and the login granted that role first |
 *
 * The two cannot be one daemon: configured means the door exists, and an
 * untagged scenario asserts the page as it is without one. So a worker starts
 * both, lazily, and a scenario is handed the one its tags named.
 *
 * **Signing in is what a person does.** The browser goes to `/auth/github`; the
 * stub authorises at once (it stands for a person who has already consented);
 * the callback exchanges the code, reads the login, checks the allow-list and
 * sets the session cookie; the browser lands on the board. Nothing here types a
 * cookie or calls the surface — the point is that the link works.
 */

import type { Identity, OduWorld } from "./world.ts";

export type { Identity };

/** The login the stub claims by default. */
export const STUB_LOGIN = "odu-e2e";

/** The allow-list every door world starts with: the stub's account is an active
 *  member of this organisation. */
export const STUB_ALLOW = "org:juspay";

/** The App's credentials — the stub does not care what they are, and a test
 *  that made them meaningful would be testing itself. */
export const STUB_CLIENT_ID = "stub-client-id";
export const STUB_CLIENT_SECRET = "stub-client-secret";

/** What a scenario's tags say its world is. */
export function identityOf(tags: readonly { readonly name: string }[]): Identity {
  const named = tags.map((tag) => tag.name);
  const signedIn = named.find((name) => name.startsWith("@signed-in:"));
  if (signedIn !== undefined) {
    const role = signedIn.slice("@signed-in:".length);
    if (role === "owner" || role === "admin" || role === "member") {
      return { kind: "signed-in", role };
    }
    throw new Error(
      `web-acceptance: ${signedIn} names no role — use @signed-in:owner|admin|member`,
    );
  }
  if (named.includes("@anonymous")) return { kind: "anonymous" };
  return { kind: "loopback" };
}

/** The environment a DOOR world's daemon is started with. */
export function doorEnv(opts: {
  readonly origin: string;
  readonly stubOrigin: string;
  readonly secretFile: string;
  readonly allow?: string;
}): NodeJS.ProcessEnv {
  return {
    // THE TERMINATOR NAMES THE PUBLIC ORIGIN: here the "proxy" is nothing, and
    // the callback URL is the daemon's own loopback address.
    ODU_PUBLIC_ORIGIN: opts.origin,
    ODU_GITHUB_CLIENT_ID: STUB_CLIENT_ID,
    ODU_GITHUB_CLIENT_SECRET_FILE: opts.secretFile,
    ODU_GITHUB_ALLOW: opts.allow ?? STUB_ALLOW,
    ODU_GITHUB_ORIGIN: opts.stubOrigin,
    ODU_GITHUB_API: opts.stubOrigin,
  };
}

/**
 * COMPLETE A SIGN-IN THE WAY A PERSON DOES.
 *
 * The redirects are followed by the browser (GitHub → the stub → this daemon's
 * callback → the board), so what lands is a page the server chose to serve, with
 * a cookie the server set. A refused login lands on the refusal PAGE instead,
 * which is why this settles on "the navigation finished" rather than on the
 * board.
 */
export async function signIn(world: OduWorld): Promise<void> {
  await world.page.goto(new URL("/auth/github", world.service.origin).href, {
    waitUntil: "domcontentloaded",
  });
}
