/**
 * THE DECLARED STORES — read once, refused with a fact, and held as values.
 *
 * The parse is driven with an in-memory `readFile`, so every refusal is a case
 * here rather than a daemon that would not start. The two cache-level rules —
 * `bucket.create` refuses a store nobody declared, and a bucket whose store
 * went away refuses the mount — run against a real cache.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createCache, mountRefusalMessage } from "./cache";
import { readCacheStores, storeConfigMessage, storeFacts } from "./stores";
import { asRoot } from "./testlib";

const R2 = {
  kind: "s3",
  endpoint: "https://acct.r2.cloudflarestorage.com",
  bucket: "odu",
  region: "auto",
  credentialsFile: "/run/credentials/odu-web.service/store-r2",
};
const CREDENTIALS = "# R2\nAWS_ACCESS_KEY_ID=abc\nAWS_SECRET_ACCESS_KEY='s3cr3t'\n";

const files = (map: Record<string, string>) => (path: string): string => {
  const text = map[path];
  if (text === undefined) throw new Error(`ENOENT: ${path}`);
  return text;
};

const read = (declared: unknown, credentials: Record<string, string> = { [R2.credentialsFile]: CREDENTIALS }) =>
  readCacheStores({ ODU_CACHE_STORES: "/etc/odu/stores.json" }, files({
    "/etc/odu/stores.json": JSON.stringify(declared),
    ...credentials,
  }));

describe("reading the declarations", () => {
  it("is no stores at all when nothing is declared", () => {
    expect(readCacheStores({})).toEqual({ kind: "config", stores: new Map() });
  });

  it("parses a store and its credentials file", () => {
    const reading = read({ r2: R2 });
    expect(reading.kind).toBe("config");
    if (reading.kind !== "config") return;
    expect(reading.stores.get("r2")).toEqual({
      kind: "s3",
      target: {
        endpoint: R2.endpoint,
        bucket: "odu",
        region: "auto",
        accessKeyId: "abc",
        secretAccessKey: "s3cr3t",
      },
    });
    // WHAT THE BOARD IS TOLD: names and kinds, never an endpoint or a key.
    expect(storeFacts(reading.stores)).toEqual([
      { name: "local", kind: "local" },
      { name: "r2", kind: "s3" },
    ]);
  });

  it("refuses each broken declaration with what is wrong, and never prints a secret", () => {
    const cases = [
      [{ local: R2 }, { kind: "reserved_name", store: "local" }],
      [{ R2: R2 }, { kind: "bad_store", store: "R2" }],
      [{ r2: { ...R2, kind: "gcs" } }, { kind: "bad_store", store: "r2" }],
      [{ r2: { ...R2, endpoint: "" } }, { kind: "bad_store", store: "r2", reason: "endpoint is missing" }],
      [{ r2: { ...R2, endpoint: "not a url" } }, { kind: "bad_store", store: "r2" }],
      [[], { kind: "malformed" }],
    ] as const;
    for (const [declared, refusal] of cases) {
      const reading = read(declared);
      expect({ declared, reading }).toMatchObject({ declared, reading: { kind: "refused", refusal } });
    }
    const unreadable = read({ r2: R2 }, {});
    expect(unreadable).toMatchObject({
      kind: "refused",
      refusal: { kind: "missing_credentials", store: "r2", file: R2.credentialsFile },
    });
    const empty = read({ r2: R2 }, { [R2.credentialsFile]: "AWS_ACCESS_KEY_ID=abc\n" });
    expect(empty).toMatchObject({ kind: "refused", refusal: { kind: "missing_credentials", store: "r2" } });
    if (empty.kind === "refused") expect(storeConfigMessage(empty.refusal)).not.toContain("abc");
    expect(readCacheStores({ ODU_CACHE_STORES: "/nope" }, files({}))).toMatchObject({
      kind: "refused",
      refusal: { kind: "unreadable", file: "/nope" },
    });
  });
});

describe("a bucket's store", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "odu-stores-"));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
  const create = { name: "main", public: true, retentionDays: 30, upstreamKeys: [] };

  it("is local unless named, and a name nobody declared is refused", async () => {
    const cache = createCache({ stateRoot: scratch, rootToken: "root" });
    expect(await cache.admin.create({ ...asRoot("root"), ...create })).toMatchObject({
      ok: true,
      value: { store: "local" },
    });
    expect(await cache.admin.create({ ...asRoot("root"), ...create, name: "far", store: "r2" })).toMatchObject({
      ok: false,
      code: "unknown_store",
    });
    await cache.close();
  });

  it("refuses the mount when a bucket's store is no longer declared, naming both", async () => {
    const { diskObjectStore } = await import("./objectStore");
    const declared = createCache({
      stateRoot: scratch,
      rootToken: "root",
      stores: new Map([["nas", diskObjectStore({ dir: join(scratch, "nas") })]]),
    });
    expect(await declared.admin.create({ ...asRoot("root"), ...create, store: "nas" })).toMatchObject({ ok: true });
    expect(await declared.boot()).toMatchObject({ ok: true });
    await declared.close();

    const forgotten = createCache({ stateRoot: scratch, rootToken: "root" });
    const booted = await forgotten.boot();
    expect(booted).toEqual({
      ok: false,
      refusal: { kind: "undeclared_store", bucket: "main", store: "nas", declared: ["local"] },
    });
    if (!booted.ok) expect(mountRefusalMessage(booted.refusal)).toContain('the store "nas"');
    await forgotten.close();
  });
});
