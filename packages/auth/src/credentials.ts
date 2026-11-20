import {
  credentialsPath as sharedCredentialsPath,
  normalizeOrigin,
  readCredentials as sharedReadCredentials,
  saveCredential as sharedSaveCredential,
} from "@odu/credentials";

export const TOKEN_ENV = "ODU_TOKEN";

const STORE = "auth";

export function authCredentialsPath(env: Record<string, string | undefined>): string {
  return sharedCredentialsPath(env, STORE);
}

const readCredentials = (env: Record<string, string | undefined>) =>
  sharedReadCredentials(env, STORE);

export async function saveAuthToken(
  env: Record<string, string | undefined>,
  origin: string,
  token: string,
): Promise<string> {
  return sharedSaveCredential(env, STORE, origin, token);
}

export async function readAuthToken(
  env: Record<string, string | undefined>,
  origin: string,
): Promise<string | null> {
  const fromEnv = env[TOKEN_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const entries = await readCredentials(env);
  return entries[normalizeOrigin(origin)] ?? null;
}

/** The headers a dial presents for an origin — empty when this machine holds no credential for it. */
export async function authorizationHeaders(
  env: Record<string, string | undefined>,
  origin: string,
): Promise<Record<string, string>> {
  const token = await readAuthToken(env, origin);
  return token === null ? {} : { authorization: `Bearer ${token}` };
}
