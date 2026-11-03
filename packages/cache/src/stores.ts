/**
 * THE STORES A DAEMON DECLARED — read once, parsed once, held as values.
 *
 * The operator declares named stores (`services.odu.cache.stores.<name>` in
 * the module, which writes them to the JSON file `$ODU_OBJECT_STORES` names);
 * `local`, the disk under the state directory, is always there and cannot be
 * redeclared. A bucket names one store at creation, and from then on the cache
 * row holds `ObjectStore` values by name and nothing else.
 *
 * Two steps, and the line between them is who may fail:
 *
 * - {@link readCacheStores} is the row's ONE environment read, called by the
 *   host at boot (the cloudflare row's shape). It reads the declarations file
 *   and hands it to `@odu/objects`'s parser, which reads each store's
 *   credentials file; a refusal — an unreadable file, a
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
import {
  type DeclarationRefusal,
  diskObjectStore,
  type ObjectStore,
  parseStoreDeclarations,
  s3ObjectStore,
  type StoreDeclarations,
} from "@odu/objects";
import { type CacheStore, LOCAL_STORE } from "./surface";

/** The variable naming the declarations file. */
export const STORES_FILE = "ODU_OBJECT_STORES";

/** The declared stores by name; `local` is implied and never in it. */
export type { StoreDeclarations };

/** Why the declarations could not be used: the file named by the variable
 *  could not be read, or what it says was refused by the parser. None carries
 *  a credential. */
export type StoreConfigRefusal = { kind: "unreadable"; file: string; reason: string } | DeclarationRefusal;

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

/** `local` is the cache's own; a declaration may not take its name. */
const RESERVED = new Set([LOCAL_STORE]);

/**
 * THE DECLARATIONS, from the file `$ODU_OBJECT_STORES` names — or none, when it
 * is unset. Reading that file is this row's; parsing it and each store's
 * credentials file is `@odu/objects`'s.
 */
export function readCacheStores(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf-8"),
): StoresReading {
  const file = env[STORES_FILE]?.trim();
  if (file === undefined || file === "") return { kind: "config", stores: new Map() };
  let text: string;
  try {
    text = readFile(file);
  } catch (err) {
    return {
      kind: "refused",
      refusal: { kind: "unreadable", file, reason: err instanceof Error ? err.message : String(err) },
    };
  }
  const parsed = parseStoreDeclarations({ file, text }, { readFile, reserved: RESERVED });
  return parsed.kind === "declared" ? { kind: "config", stores: parsed.stores } : parsed;
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

/** What the `stores` cell publishes: names, kinds and the public URL the
 *  operator bound to the store. Never an endpoint and never a credential —
 *  those are the operator's configuration, and nothing on the wire needs
 *  them. The public URL IS published, because it is the address every client
 *  of a store-fronted bucket is handed anyway (PLAN 2.8). */
export function storeFacts(declared: StoreDeclarations): CacheStore[] {
  return [
    { name: LOCAL_STORE, kind: "local", default: true, publicUrl: null },
    ...[...declared].map(([name, declaration]) => ({
      name,
      kind: declaration.kind,
      default: false,
      // THE ORIGIN, NOT THE HREF: the parser refused a path, a query and a
      // fragment, so the origin is the whole of the URL — and every caller
      // joins `/<bucket>` onto it, where `https://cache.example.org//kolu`
      // would be a key nobody wrote.
      publicUrl: declaration.target.publicUrl?.origin ?? null,
    })),
  ];
}

/** The stores whose objects the world can read without odu: those the
 *  operator bound a domain to. The cache refuses a PRIVATE bucket on one of
 *  them, because the binding covers every prefix in the store. */
export function frontedStores(declared: StoreDeclarations): Set<string> {
  return new Set([...declared].flatMap(([name, d]) => (d.target.publicUrl === undefined ? [] : [name])));
}

/** Each declared store's endpoint — what a presigned URL is built from, and
 *  therefore an address the CLIENT must be able to dial (PLAN 2.8). */
export function storeEndpoints(declared: StoreDeclarations): { name: string; endpoint: URL }[] {
  return [...declared].map(([name, declaration]) => ({ name, endpoint: declaration.target.endpoint }));
}
