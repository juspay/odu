/**
 * THIS MACHINE'S TOKEN FILES, in one place.
 *
 * Two rows keep a token per origin — the cache's bucket credentials and the
 * auth row's personal tokens — and they are the same file shape: a JSON object
 * keyed by ORIGIN, so a laptop can be pointed at the pod and at a local daemon
 * at once and `--origin` picks the right token rather than the only one.
 *
 * The shape is `gh`'s and `docker`'s, and it was written out twice: once for
 * `odu cache push`, once for `odu auth login`. The second copy was correct by
 * the comment "the same shape", which is how the two spellings of `.netrc`
 * drifted before. So the layout, the 0600 mode and the per-origin rule live
 * here, `store` is the only word a row supplies, and a row cannot get them
 * wrong without changing this file.
 *
 * CLI-side only: the two rows' `cli.ts` modules import it (they are what run
 * `odu cache login` and `odu auth login`). No row's surface, server or face
 * does, and the browser cannot.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The environment, named loosely — `process.env` is assignable and a test can
 *  hand over three fields. */
export interface CredentialEnv {
  readonly XDG_CONFIG_HOME?: string | undefined;
  readonly HOME?: string | undefined;
  /** The index signature is what makes `process.env` assignable here — named
   *  fields alone are structurally incompatible with `ProcessEnv`, and the
   *  alternative is a cast at every call site. */
  readonly [other: string]: string | undefined;
}

/** `$XDG_CONFIG_HOME`, else `~/.config` — the base every store shares. */
function configBase(env: CredentialEnv): string {
  const config = env.XDG_CONFIG_HOME?.trim();
  if (config !== undefined && config !== "") return config;
  const home = env.HOME?.trim();
  return join(home !== undefined && home !== "" ? home : homedir(), ".config");
}

/** `~/.config/odu/<store>/credentials` — one entry per origin, 0600. */
export function credentialsPath(env: CredentialEnv, store: string): string {
  return join(configBase(env), "odu", store, "credentials");
}

/** `/`-trimmed, so a token saved by one spelling is found by the other.
 *
 *  A loop, not `replace(/\/+$/)`: an origin is library input, and the
 *  expression backtracks quadratically over a long run of slashes (CodeQL, and
 *  the finding is right even where the input is a user's own `--origin`). */
export function normalizeOrigin(origin: string): string {
  let end = origin.length;
  while (end > 0 && origin[end - 1] === "/") end--;
  return origin.slice(0, end);
}

/** The map as it is on disk; an absent or unreadable file is EMPTY, because CI
 *  sets the token in the environment and never logs in. */
export async function readCredentials(
  env: CredentialEnv,
  store: string,
): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(credentialsPath(env, store), "utf8"));
    if (parsed === null || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/** Save a token for an origin, replacing the one there. Answers the path it
 *  wrote, for the message the command prints. */
export async function saveCredential(
  env: CredentialEnv,
  store: string,
  origin: string,
  token: string,
): Promise<string> {
  const path = credentialsPath(env, store);
  const entries = await readCredentials(env, store);
  entries[normalizeOrigin(origin)] = token;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  // `writeFile`'s mode is only honoured on create; an existing file keeps
  // whatever it had, and a world-readable token file is the one mistake this
  // must not make.
  await chmod(path, 0o600);
  return path;
}
