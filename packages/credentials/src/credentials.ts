import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CredentialEnv {
  readonly XDG_CONFIG_HOME?: string | undefined;
  readonly HOME?: string | undefined;
  /** The index signature is what makes `process.env` assignable here — named
   *  fields alone are structurally incompatible with `ProcessEnv`, and the
   *  alternative is a cast at every call site. */
  readonly [other: string]: string | undefined;
}

function configBase(env: CredentialEnv): string {
  const config = env.XDG_CONFIG_HOME?.trim();
  if (config !== undefined && config !== "") return config;
  const home = env.HOME?.trim();
  return join(home !== undefined && home !== "" ? home : homedir(), ".config");
}

export function credentialsPath(env: CredentialEnv, store: string): string {
  return join(configBase(env), "odu", store, "credentials");
}

export function normalizeOrigin(origin: string): string {
  let end = origin.length;
  while (end > 0 && origin[end - 1] === "/") end--;
  return origin.slice(0, end);
}

/** The map as it is on disk; an absent or unreadable file is EMPTY. */
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

/** Save a token for an origin, replacing the one there. Answers the path it wrote. */
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
  // whatever it had.
  await chmod(path, 0o600);
  return path;
}
