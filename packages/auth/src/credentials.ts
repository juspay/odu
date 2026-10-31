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

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** `$ODU_TOKEN` — a personal access token for the command line and agents. */
export const TOKEN_ENV = "ODU_TOKEN";

export function authCredentialsPath(env: Record<string, string | undefined>): string {
  const config = env.XDG_CONFIG_HOME?.trim();
  const home = env.HOME?.trim();
  const base =
    config !== undefined && config !== ""
      ? config
      : join(home !== undefined && home !== "" ? home : homedir(), ".config");
  return join(base, "odu", "auth", "credentials");
}

/** `/`-trimmed, so a token saved by one spelling is found by the other. */
export function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

async function readCredentials(env: Record<string, string | undefined>): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(authCredentialsPath(env), "utf8"));
    if (parsed === null || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    // Absent is the ordinary case: CI sets `$ODU_TOKEN` and never logs in.
    return {};
  }
}

/** Save a token for an origin. Answers the path it wrote. */
export async function saveAuthToken(
  env: Record<string, string | undefined>,
  origin: string,
  token: string,
): Promise<string> {
  const path = authCredentialsPath(env);
  const entries = await readCredentials(env);
  entries[normalizeOrigin(origin)] = token;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  // `writeFile`'s mode only applies on create; an existing file keeps its own,
  // and a world-readable token file is the one mistake this must not make.
  await chmod(path, 0o600);
  return path;
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
