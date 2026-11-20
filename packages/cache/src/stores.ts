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

export const STORES_FILE = "ODU_OBJECT_STORES";

export type { StoreDeclarations };

export type StoreConfigRefusal = { kind: "unreadable"; file: string; reason: string } | DeclarationRefusal;

export type StoresReading =
  | { kind: "config"; stores: StoreDeclarations }
  | { kind: "refused"; refusal: StoreConfigRefusal };

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

const RESERVED = new Set([LOCAL_STORE]);

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

export function objectStores(
  declared: StoreDeclarations,
  dir: string,
): ReadonlyMap<string, ObjectStore> {
  return new Map<string, ObjectStore>([
    [LOCAL_STORE, diskObjectStore({ dir })],
    ...[...declared].map(([name, declaration]) => [name, s3ObjectStore({ target: declaration.target })] as const),
  ]);
}

export function storeFacts(declared: StoreDeclarations): CacheStore[] {
  return [
    { name: LOCAL_STORE, kind: "local", default: true, publicUrl: null },
    ...[...declared].map(([name, declaration]) => ({
      name,
      kind: declaration.kind,
      default: false,
      publicUrl: declaration.target.publicUrl?.origin ?? null,
    })),
  ];
}

