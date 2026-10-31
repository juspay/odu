/**
 * WHERE THIS MACHINE'S PERSONAL TOKENS LIVE — one per origin, the sibling of
 * the cache's bucket credentials and the same shape.
 *
 * `~/.config/odu/auth/credentials` is a JSON object keyed by ORIGIN, so a
 * laptop can be signed in to the pod and to a local daemon at once, and
 * `--origin` picks the right token rather than the only one. Mode 0600: a token
 * file that anyone can read is a token anyone can use.
 *
 * The order is the documented one: `--token` if given, then `$ODU_TOKEN`, then
 * the entry for the origin. CI sets the variable and never logs in, which is why
 * the variable beats the file — a machine's stored login must not shadow a
 * deliberate environment.
 *
 * This module is CLI-side and reads the filesystem; the ROW does not import it
 * and the browser cannot.
 */

import {
  credentialsPath as sharedCredentialsPath,
  normalizeOrigin,
  readCredentials as sharedReadCredentials,
  saveCredential as sharedSaveCredential,
} from "@odu/credentials";

/** `$ODU_TOKEN` — a personal access token for the command line and agents. */
export const TOKEN_ENV = "ODU_TOKEN";

/** THIS ROW'S STORE — the one word that differs from the cache's file. */
const STORE = "auth";

export function authCredentialsPath(env: Record<string, string | undefined>): string {
  return sharedCredentialsPath(env, STORE);
}

const readCredentials = (env: Record<string, string | undefined>) =>
  sharedReadCredentials(env, STORE);

/** Save a token for an origin. Answers the path it wrote. */
export async function saveAuthToken(
  env: Record<string, string | undefined>,
  origin: string,
  token: string,
): Promise<string> {
  return sharedSaveCredential(env, STORE, origin, token);
}

/** The token for an origin, in the documented order. */
export async function readAuthToken(
  env: Record<string, string | undefined>,
  origin: string,
): Promise<string | null> {
  const fromEnv = env[TOKEN_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const entries = await readCredentials(env);
  return entries[normalizeOrigin(origin)] ?? null;
}

/** The headers a dial presents for an origin — empty when this machine holds
 *  no credential for it, which is the ordinary loopback case. */
export async function authorizationHeaders(
  env: Record<string, string | undefined>,
  origin: string,
): Promise<Record<string, string>> {
  const token = await readAuthToken(env, origin);
  return token === null ? {} : { authorization: `Bearer ${token}` };
}
