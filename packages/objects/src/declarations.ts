/**
 * DECLARED STORES — a declarations file and its credentials files, parsed once
 * into values.
 *
 * The declarations are JSON, one entry per named store:
 *
 * ```json
 * { "r2": { "kind": "s3", "endpoint": "https://<account>.r2.cloudflarestorage.com",
 *           "bucket": "odu", "region": "auto", "credentialsFile": "/run/…/r2" } }
 * ```
 *
 * and each `credentialsFile` is `KEY=value` lines — `AWS_ACCESS_KEY_ID`,
 * `AWS_SECRET_ACCESS_KEY`, optionally `AWS_SESSION_TOKEN` — the shape an
 * `EnvironmentFile`, an agenix secret or an R2 key export already has.
 *
 * The parser takes the declarations' TEXT and a reader for the credentials
 * files, so where the declarations come from (an environment variable, a test)
 * is the caller's. A refusal is a value naming what is wrong and never carries
 * a credential.
 */

import type { S3Target } from "./s3sign";

/** One declared S3-compatible store, credentials read. */
export interface S3Declaration {
  readonly kind: "s3";
  readonly target: S3Target;
}

/** The declared stores by name. */
export type StoreDeclarations = ReadonlyMap<string, S3Declaration>;

/** Why the declarations could not be used. Each names what happened; none
 *  carries a credential. */
export type DeclarationRefusal =
  | { kind: "malformed"; file: string; reason: string }
  | { kind: "bad_store"; store: string; reason: string }
  | { kind: "reserved_name"; store: string }
  | { kind: "missing_credentials"; store: string; file: string; reason: string };

export type DeclarationsParse =
  | { kind: "declared"; stores: StoreDeclarations }
  | { kind: "refused"; refusal: DeclarationRefusal };

/** A store name is a bucket-name-shaped label: it is spelled in a UI and in
 *  configuration attribute names. */
const STORE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** `KEY=value` lines; `#` starts a comment. */
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
 * THE DECLARATIONS in `text` (read from `file`, which names it in a refusal),
 * each store's credentials read through `readFile`. `reserved` are names the
 * caller keeps for stores of its own.
 */
export function parseStoreDeclarations(
  declarations: { file: string; text: string },
  options: { readFile: (path: string) => string; reserved?: ReadonlySet<string> },
): DeclarationsParse {
  const { file } = declarations;
  let parsed: unknown;
  try {
    parsed = JSON.parse(declarations.text);
  } catch (err) {
    return { kind: "refused", refusal: { kind: "malformed", file, reason: (err as Error).message } };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "refused", refusal: { kind: "malformed", file, reason: "it is not an object of stores" } };
  }
  const stores = new Map<string, S3Declaration>();
  for (const [name, raw] of Object.entries(parsed)) {
    if (options.reserved?.has(name)) return { kind: "refused", refusal: { kind: "reserved_name", store: name } };
    const bad = (reason: string): DeclarationsParse => ({
      kind: "refused",
      refusal: { kind: "bad_store", store: name, reason },
    });
    if (!STORE_NAME.test(name)) return bad("a store name is lowercase letters, digits and dashes");
    const entry = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (entry["kind"] !== "s3") return bad(`kind is ${JSON.stringify(entry["kind"])}, and the one kind is "s3"`);
    for (const field of ["endpoint", "bucket", "region", "credentialsFile"] as const) {
      if (!nonEmpty(entry[field])) return bad(`${field} is missing`);
    }
    const spelled = entry["endpoint"] as string;
    let endpoint: URL;
    try {
      endpoint = new URL(spelled);
    } catch {
      return bad(`endpoint ${spelled} is not a URL`);
    }
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
      return bad(`endpoint ${spelled} is not an http(s) URL`);
    }
    if (endpoint.search !== "" || endpoint.hash !== "") {
      return bad(`endpoint ${spelled} has a query or fragment, and an S3 endpoint has neither`);
    }
    const credentialsFile = entry["credentialsFile"] as string;
    let credentials: ReturnType<typeof parseCredentials>;
    try {
      credentials = parseCredentials(options.readFile(credentialsFile));
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
  return { kind: "declared", stores };
}
