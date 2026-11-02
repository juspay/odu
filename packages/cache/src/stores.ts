/**
 * THE STORES A DAEMON DECLARED — read once, parsed once, held as values.
 *
 * The operator declares named stores (`services.odu.cache.stores.<name>` in
 * the module, which writes them to the JSON file `$ODU_CACHE_STORES` names);
 * `local`, the disk under the state directory, is always there and cannot be
 * redeclared. A bucket names one store at creation, and from then on the cache
 * row holds `ObjectStore` values by name and nothing else.
 *
 * Two steps, and the line between them is who may fail:
 *
 * - {@link readCacheStores} is the row's ONE environment read, called by the
 *   host at boot (the cloudflare row's shape). It parses the declarations and
 *   reads each store's credentials file, and a refusal — an unreadable file, a
 *   store with no credentials, a redeclared `local` — is a typed value the host
 *   prints before anything serves.
 * - {@link objectStores} turns the declarations into `ObjectStore` values. It
 *   cannot fail: every fact it needs was proved by the read.
 *
 * **Credentials are config, never data.** They are read from the operator's
 * file into the declaration and handed to the store; they are not written to
 * the database, not published on the surface (the `stores` cell carries a name
 * and a kind), and no refusal or log line prints them.
 */

import { readFileSync } from "node:fs";
import { diskObjectStore, type ObjectStore, s3ObjectStore } from "./objectStore";
import type { S3Target } from "./s3sign";
import { type CacheStore, LOCAL_STORE } from "./surface";

/** The variable naming the declarations file. */
export const STORES_FILE = "ODU_CACHE_STORES";

/** One declared S3-compatible store, credentials read. */
export interface S3Declaration {
  readonly kind: "s3";
  readonly target: S3Target;
}

/** The declared stores by name; `local` is implied and never in it. */
export type StoreDeclarations = ReadonlyMap<string, S3Declaration>;

/** Why the declarations could not be used. Each names what happened; none
 *  carries a credential. */
export type StoreConfigRefusal =
  | { kind: "unreadable"; file: string; reason: string }
  | { kind: "malformed"; file: string; reason: string }
  | { kind: "bad_store"; store: string; reason: string }
  | { kind: "reserved_name"; store: string }
  | { kind: "missing_credentials"; store: string; file: string; reason: string };

export type StoresReading =
  | { kind: "config"; stores: StoreDeclarations }
  | { kind: "refused"; refusal: StoreConfigRefusal };

/** The sentence a refusal is printed as. */
export function storeConfigMessage(refusal: StoreConfigRefusal): string {
  switch (refusal.kind) {
    case "unreadable":
      return `odu: ${STORES_FILE} names ${refusal.file}, which could not be read: ${refusal.reason}`;
    case "malformed":
      return `odu: ${STORES_FILE} names ${refusal.file}, which is not a store declaration: ${refusal.reason}`;
    case "bad_store":
      return `odu: the cache store "${refusal.store}" is not usable: ${refusal.reason}`;
    case "reserved_name":
      return (
        `odu: the cache store "${refusal.store}" is declared, but "${LOCAL_STORE}" is the ` +
        "daemon's own disk and is always there — give the declared store another name"
      );
    case "missing_credentials":
      return (
        `odu: the cache store "${refusal.store}" has no credentials: ${refusal.file} ${refusal.reason}`
      );
  }
}

/** A store name is a bucket-name-shaped label: it is spelled in the UI and in
 *  the module's attribute names. */
const STORE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * The credentials file: `KEY=value` lines, the shape an `EnvironmentFile`, an
 * agenix secret or a Garage/R2 key export already has. `#` starts a comment.
 */
function parseCredentials(
  text: string,
): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | string {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at === -1) continue;
    values.set(trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim().replace(/^(["'])(.*)\1$/, "$2"));
  }
  const accessKeyId = values.get("AWS_ACCESS_KEY_ID");
  const secretAccessKey = values.get("AWS_SECRET_ACCESS_KEY");
  if (!nonEmpty(accessKeyId) || !nonEmpty(secretAccessKey)) {
    return "has no AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY lines";
  }
  const sessionToken = values.get("AWS_SESSION_TOKEN");
  return { accessKeyId, secretAccessKey, ...(nonEmpty(sessionToken) ? { sessionToken } : {}) };
}

/**
 * THE DECLARATIONS, from the file `$ODU_CACHE_STORES` names — or none, when it
 * is unset. The file is JSON, one entry per store:
 *
 * ```json
 * { "r2": { "kind": "s3", "endpoint": "https://<account>.r2.cloudflarestorage.com",
 *           "bucket": "odu", "region": "auto", "credentialsFile": "/run/…/r2" } }
 * ```
 */
export function readCacheStores(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf-8"),
): StoresReading {
  const file = env[STORES_FILE]?.trim();
  if (file === undefined || file === "") return { kind: "config", stores: new Map() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(file));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      kind: "refused",
      refusal: err instanceof SyntaxError ? { kind: "malformed", file, reason } : { kind: "unreadable", file, reason },
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "refused", refusal: { kind: "malformed", file, reason: "it is not an object of stores" } };
  }
  const stores = new Map<string, S3Declaration>();
  for (const [name, raw] of Object.entries(parsed)) {
    if (name === LOCAL_STORE) return { kind: "refused", refusal: { kind: "reserved_name", store: name } };
    const bad = (reason: string): StoresReading => ({
      kind: "refused",
      refusal: { kind: "bad_store", store: name, reason },
    });
    if (!STORE_NAME.test(name)) return bad("a store name is lowercase letters, digits and dashes");
    const entry = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (entry["kind"] !== "s3") return bad(`kind is ${JSON.stringify(entry["kind"])}, and the one kind is "s3"`);
    for (const field of ["endpoint", "bucket", "region", "credentialsFile"] as const) {
      if (!nonEmpty(entry[field])) return bad(`${field} is missing`);
    }
    const endpoint = entry["endpoint"] as string;
    try {
      new URL(endpoint);
    } catch {
      return bad(`endpoint ${endpoint} is not a URL`);
    }
    const credentialsFile = entry["credentialsFile"] as string;
    let credentials: ReturnType<typeof parseCredentials>;
    try {
      credentials = parseCredentials(readFile(credentialsFile));
    } catch (err) {
      return {
        kind: "refused",
        refusal: {
          kind: "missing_credentials",
          store: name,
          file: credentialsFile,
          reason: `could not be read: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    if (typeof credentials === "string") {
      return {
        kind: "refused",
        refusal: { kind: "missing_credentials", store: name, file: credentialsFile, reason: credentials },
      };
    }
    stores.set(name, {
      kind: "s3",
      target: {
        endpoint,
        bucket: entry["bucket"] as string,
        region: entry["region"] as string,
        ...credentials,
      },
    });
  }
  return { kind: "config", stores };
}

/** The stores as values, `local` first: what the cache row holds. */
export function objectStores(
  declared: StoreDeclarations,
  dir: string,
): ReadonlyMap<string, ObjectStore> {
  return new Map<string, ObjectStore>([
    [LOCAL_STORE, diskObjectStore({ dir })],
    ...[...declared].map(([name, declaration]) => [name, s3ObjectStore({ target: declaration.target })] as const),
  ]);
}

/** What the `stores` cell publishes: names and kinds, nothing else. */
export function storeFacts(declared: StoreDeclarations): CacheStore[] {
  return [
    { name: LOCAL_STORE, kind: "local" },
    ...[...declared].map(([name, declaration]) => ({ name, kind: declaration.kind })),
  ];
}
