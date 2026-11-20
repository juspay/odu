import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { purgeBroker } from "@odu/cordis/services";
import { diskObjectStore, type ObjectStore, type S3Declaration, type StoreDeclarations } from "@odu/objects";
import { type Cache, createCache } from "./cache";
import { openCacheRepo } from "./db";
import { base32, storePathHash } from "./narinfo";
import { cacheServer, exposedBuckets, probePublicStores, probeStoreEndpoints } from "./server";
import { cacheInfoKey, narinfoKey, nixCacheInfo } from "./staging";
import { storeFacts } from "./stores";
import type { CacheBucket } from "./surface";
import { asRoot } from "./testlib";

const ROOT = "root-token";
const ORIGIN = "https://odu.example.org";
const PUBLIC_URL = "https://cache.example.com";

const R2: S3Declaration = {
  kind: "s3",
  target: {
    endpoint: new URL("https://acct.r2.cloudflarestorage.com"),
    bucket: "odu",
    region: "auto",
    accessKeyId: "abc",
    secretAccessKey: "s3cr3t",
    publicUrl: new URL(PUBLIC_URL),
  },
};

const PLAIN: S3Declaration = { kind: "s3", target: { ...R2.target, publicUrl: undefined } };

const declaring = (store: S3Declaration): StoreDeclarations => new Map([["r2", store]]);

let scratch: string;
const trash: Cache[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "odu-store-reads-"));
});
afterEach(async () => {
  await Promise.all(trash.splice(0).map((cache) => cache.close()));
  rmSync(scratch, { recursive: true, force: true });
});

function daemon(declared: StoreDeclarations): {
  cache: Cache;
  published: Map<string, CacheBucket>;
  publish: () => void;
} {
  const cache = createCache({
    stateRoot: scratch,
    rootToken: ROOT,
    publicOrigin: ORIGIN,
    stores: new Map<string, ObjectStore>([
      ["local", diskObjectStore({ dir: join(scratch, "cache") })],
      ["r2", diskObjectStore({ dir: join(scratch, "r2") })],
    ]),
  });
  trash.push(cache);
  const server = cacheServer({
    cache,
    publicOrigin: ORIGIN,
    purge: purgeBroker(),
    mount: "/cache",
    stores: storeFacts(declared),
  });
  const published = new Map<string, CacheBucket>();
  server.attach({
    buckets: {
      upsert: (key, value) => {
        published.set(key, value);
      },
      remove: (key) => {
        published.delete(key);
      },
    },
  });
  return { cache, published, publish: server.publish };
}

const create = async (
  cache: Cache,
  name: string,
  options: { public: boolean; store: string },
): Promise<void> => {
  const created = await cache.admin.create({
    ...asRoot(ROOT),
    name,
    public: options.public,
    retentionDays: 30,
    upstreamKeys: [],
    store: options.store,
  });
  if (!created.ok) throw new Error(`create ${name}: ${created.message}`);
};

describe("what a store's public URL publishes", () => {
  it("strips the trailing slash a URL grows, because every caller joins a bucket onto it", () => {
    expect(storeFacts(declaring(R2))).toEqual([
      { name: "local", kind: "local", default: true, publicUrl: null },
      { name: "r2", kind: "s3", default: false, publicUrl: PUBLIC_URL },
    ]);
  });

  it("is the substituter URL of a PUBLIC bucket on that store, and says reads come from it", async () => {
    const { cache, published, publish } = daemon(declaring(R2));
    await create(cache, "kolu", { public: true, store: "r2" });
    publish();
    expect(published.get("kolu")?.url).toBe(`${PUBLIC_URL}/kolu`);
    expect(published.get("kolu")?.readsFrom).toBe("store");
    expect(published.get("kolu")?.pushUrl).toBe(`${ORIGIN}/cache/kolu`);
    const described = await cache.admin.describe({ bucket: "kolu" });
    expect(described).toMatchObject({ ok: true, value: { store: "r2" } });
  });

  it("is not used by a PRIVATE bucket, which odu reads for the token's sake", async () => {
    const { cache, published, publish } = daemon(declaring(R2));
    await create(cache, "secret", { public: false, store: "r2" });
    publish();
    expect(published.get("secret")?.url).toBe(`${ORIGIN}/cache/secret`);
    expect(published.get("secret")?.readsFrom).toBe("odu");
    expect(published.get("secret")?.pushUrl).toBe(`${ORIGIN}/cache/secret`);
  });

  it("is not used by a bucket on a store nobody bound a domain to", async () => {
    const { cache, published, publish } = daemon(declaring(PLAIN));
    await create(cache, "kolu", { public: true, store: "r2" });
    await create(cache, "disk", { public: true, store: "local" });
    publish();
    expect(published.get("kolu")?.url).toBe(`${ORIGIN}/cache/kolu`);
    expect(published.get("kolu")?.readsFrom).toBe("odu");
    expect(published.get("disk")?.readsFrom).toBe("odu");
  });

  it("beats the bucket's own domain, which odu still honours for everything else", async () => {
    const { cache, published, publish } = daemon(declaring(R2));
    await create(cache, "kolu", { public: true, store: "r2" });
    expect(
      await cache.admin.domain({ ...asRoot(ROOT), bucket: "kolu", domain: "cache.kolu.dev" }),
    ).toMatchObject({ ok: true });
    publish();
    expect(published.get("kolu")?.url).toBe(`${PUBLIC_URL}/kolu`);
    expect(published.get("kolu")?.readsFrom).toBe("store");
    expect(published.get("kolu")?.pushUrl).toBe(`${ORIGIN}/cache/kolu`);
    expect(cache.bucketByDomain("cache.kolu.dev")?.name).toBe("kolu");

    await create(cache, "secret", { public: false, store: "r2" });
    expect(
      await cache.admin.domain({ ...asRoot(ROOT), bucket: "secret", domain: "secret.kolu.dev" }),
    ).toMatchObject({ ok: true });
    publish();
    expect(published.get("secret")?.url).toBe("https://secret.kolu.dev");
    expect(published.get("secret")?.readsFrom).toBe("odu");
  });
});

describe("asking a store's domain whether it serves", () => {
  const BUCKETS = [{ name: "kolu", public: true, store: "r2" }];
  const PROBED = `${PUBLIC_URL}/kolu/nix-cache-info`;

  const answering = (
    reply: () => Response | Promise<Response>,
  ): { send: typeof fetch; asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      send: (async (url: string | URL | Request) => {
        asked.push(String(url));
        return await reply();
      }) as unknown as typeof fetch,
    };
  };

  const probe = async (
    reply: () => Response | Promise<Response>,
    buckets = BUCKETS,
  ): Promise<{
    refusals: readonly { store: string; url: string; status: number | null }[];
    asked: string[];
    logged: { event: string; fields: Record<string, unknown> }[];
  }> => {
    const { send, asked } = answering(reply);
    const logged: { event: string; fields: Record<string, unknown> }[] = [];
    const refusals = await probePublicStores({
      stores: storeFacts(declaring(R2)),
      buckets,
      info: (bucket) => nixCacheInfo({ origin: ORIGIN, bucket }),
      send,
      log: (event, fields) => logged.push({ event, fields }),
    });
    return { refusals, asked, logged };
  };

  it("is satisfied by the file a Nix client reads first", async () => {
    const seen = await probe(() =>
      new Response(nixCacheInfo({ origin: ORIGIN, bucket: "kolu" }), { status: 200 }),
    );
    expect(seen.asked).toEqual([PROBED]);
    expect(seen.refusals).toEqual([]);
    expect(seen.logged).toEqual([]);
  });

  it("refuses a 404, a wrong body and a request that never arrived, naming each", async () => {
    const cases: [string, () => Response | Promise<Response>, number | null][] = [
      ["404", () => new Response("", { status: 404 }), 404],
      ["another site", () => new Response("<html>hello</html>", { status: 200 }), 200],
      ["unreachable", () => Promise.reject(new Error("getaddrinfo ENOTFOUND")), null],
    ];
    for (const [name, reply, status] of cases) {
      const seen = await probe(reply);
      expect({ name, refusals: seen.refusals }).toEqual({
        name,
        refusals: [{ store: "r2", url: PROBED, status }],
      });
      expect({ name, logged: seen.logged }).toEqual({
        name,
        logged: [{ event: "cache.store.public.unreachable", fields: { store: "r2", url: PROBED, status } }],
      });
    }
  });

  it("never asks about a store whose buckets are all private", async () => {
    const seen = await probe(() => new Response("", { status: 404 }), [
      { name: "secret", public: false, store: "r2" },
    ]);
    expect(seen.asked).toEqual([]);
    expect(seen.refusals).toEqual([]);
    expect(seen.logged).toEqual([]);
  });
});

describe("the private buckets a bound domain exposes", () => {
  const naming = (
    stores: StoreDeclarations,
    buckets: readonly { name: string; public: boolean; store: string }[],
  ): { found: readonly { bucket: string; store: string; url: string }[]; logged: string[] } => {
    const logged: string[] = [];
    const found = exposedBuckets({
      stores: storeFacts(stores),
      buckets,
      log: (event) => logged.push(event),
    });
    return { found, logged };
  };

  it("names a private bucket on a fronted store, with the address it answers at", () => {
    const seen = naming(declaring(R2), [
      { name: "secret", public: false, store: "r2" },
      { name: "kolu", public: true, store: "r2" },
      { name: "other", public: false, store: "local" },
    ]);
    expect(seen.found).toEqual([{ bucket: "secret", store: "r2", url: `${PUBLIC_URL}/secret` }]);
    expect(seen.logged).toEqual(["cache.bucket.exposed"]);
  });

  it("says nothing about a store nobody bound a domain to", () => {
    expect(naming(declaring(PLAIN), [{ name: "secret", public: false, store: "r2" }]).found).toEqual([]);
  });
});

describe("an endpoint a client cannot dial", () => {
  const endpointing = (endpoint: string, buckets: readonly { store: string }[]) => {
    const logged: { event: string; fields: Record<string, unknown> }[] = [];
    const found = probeStoreEndpoints({
      stores: [{ name: "r2", endpoint: new URL(endpoint) }],
      buckets,
      log: (event, fields) => logged.push({ event, fields }),
    });
    return { found, logged };
  };

  it("names a loopback or link-local endpoint that a bucket's reads depend on", () => {
    for (const endpoint of [
      "http://127.0.0.1:7070",
      "http://localhost:7070",
      "http://[::1]:7070",
      "http://169.254.1.2",
    ]) {
      const seen = endpointing(endpoint, [{ store: "r2" }]);
      expect({ endpoint, found: seen.found.length }).toEqual({ endpoint, found: 1 });
      expect(seen.logged[0]?.event).toBe("cache.store.endpoint.unreachable");
    }
  });

  it("says nothing about a routable endpoint, or about a store holding no bucket", () => {
    expect(endpointing("https://acct.r2.cloudflarestorage.com", [{ store: "r2" }]).found).toEqual([]);
    expect(endpointing("http://127.0.0.1:7070", [{ store: "local" }]).found).toEqual([]);
  });
});

describe("a private bucket on a store the world can read", () => {
  const fronted = (): Cache => {
    const cache = createCache({
      stateRoot: scratch,
      rootToken: ROOT,
      publicOrigin: ORIGIN,
      stores: new Map<string, ObjectStore>([
        ["local", diskObjectStore({ dir: join(scratch, "cache") })],
        ["r2", diskObjectStore({ dir: join(scratch, "r2") })],
      ]),
      frontedStores: new Set(["r2"]),
    });
    trash.push(cache);
    return cache;
  };

  it("is refused at create, and the public one beside it is not", async () => {
    const cache = fronted();
    const refused = await cache.admin.create({
      ...asRoot(ROOT),
      name: "secret",
      public: false,
      retentionDays: 30,
      upstreamKeys: [],
      store: "r2",
    });
    expect(refused).toMatchObject({ ok: false, code: "bad_input" });
    if (!refused.ok) expect(refused.message).toContain("publishes its objects at a public URL");
    await create(cache, "kolu", { public: true, store: "r2" });
    expect(cache.bucket("kolu")?.store).toBe("r2");
    await create(cache, "secret", { public: false, store: "local" });
    expect(cache.bucket("secret")?.store).toBe("local");
  });

  it("is refused at migrate, so a move cannot publish what a create would not", async () => {
    const cache = fronted();
    await create(cache, "secret", { public: false, store: "local" });
    const refused = await cache.admin.migrateStore({ ...asRoot(ROOT), bucket: "secret", store: "r2" });
    expect(refused).toMatchObject({ ok: false, code: "bad_input" });
    expect(cache.bucket("secret")?.store).toBe("local");
  });
});

describe("the narinfo objects a bucket pushed before 2.8 is missing", () => {
  const PATHS = [
    "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-one",
    "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-two",
  ];

  async function pushedBefore28(): Promise<{ cache: Cache; objects: ObjectStore }> {
    const objects = diskObjectStore({ dir: join(scratch, "cache") });
    const cache = createCache({
      stateRoot: scratch,
      rootToken: ROOT,
      publicOrigin: ORIGIN,
      stores: new Map<string, ObjectStore>([["local", objects]]),
    });
    trash.push(cache);
    await create(cache, "main", { public: true, store: "local" });
    const bucket = cache.bucket("main");
    if (bucket === null) throw new Error("no bucket main");
    for (const storePath of PATHS) {
      const bytes = new TextEncoder().encode(storePath);
      const narHash = `sha256:${base32(createHash("sha256").update(bytes).digest())}`;
      const file = `${narHash.slice("sha256:".length)}.nar.zst`;
      const upload = await cache.beginUpload(bucket, file);
      await upload.write(bytes);
      await upload.commit();
      const outcome = await cache.acceptNarinfo(
        bucket,
        storePathHash(storePath),
        new Response(
          [
            `StorePath: ${storePath}`,
            `URL: nar/${file}`,
            "Compression: none",
            `NarHash: ${narHash}`,
            `NarSize: ${bytes.length}`,
            "References: ",
            "",
          ].join("\n"),
        ).body as ReadableStream<Uint8Array>,
        { run: null, commit: null },
      );
      if (!outcome.ok) throw new Error(`push ${storePath}: ${outcome.message}`);
    }
    for (const storePath of PATHS) await objects.delete(narinfoKey("main", storePathHash(storePath)));
    await objects.delete(cacheInfoKey("main"));
    return { cache, objects };
  }

  const textOf = async (objects: ObjectStore, key: string): Promise<string | null> => {
    const object = await objects.get(key);
    return object === null ? null : await new Response(object.stream).text();
  };

  it("writes every one of them, and `nix-cache-info` with them", async () => {
    const { cache, objects } = await pushedBefore28();
    const bucket = cache.bucket("main");
    if (bucket === null) throw new Error("no bucket main");
    expect(await objects.head(narinfoKey("main", storePathHash(PATHS[0] as string)))).toBeNull();

    expect(await cache.backfillObjects()).toEqual({ rows: 2, written: 2, failures: 0 });

    for (const storePath of PATHS) {
      const hash = storePathHash(storePath);
      expect(await textOf(objects, narinfoKey("main", hash))).toBe(cache.narinfoText(bucket, hash));
    }
    expect(await textOf(objects, cacheInfoKey("main"))).toBe(cache.cacheInfoText("main"));
  });

  it("writes nothing the second time, which is how a restart resumes it", async () => {
    const { cache } = await pushedBefore28();
    expect((await cache.backfillObjects()).written).toBe(2);
    expect(await cache.backfillObjects()).toEqual({ rows: 2, written: 0, failures: 0 });
  });

  it("rewrites an object whose bytes are not what the row says", async () => {
    const { cache, objects } = await pushedBefore28();
    await cache.backfillObjects();
    const bucket = cache.bucket("main");
    if (bucket === null) throw new Error("no bucket main");
    const hash = storePathHash(PATHS[0] as string);
    await objects.delete(narinfoKey("main", hash));
    expect((await objects.put(narinfoKey("main", hash), new Blob(["Stale: yes\n"]))).ok).toBe(true);

    expect(await cache.backfillObjects()).toEqual({ rows: 2, written: 1, failures: 0 });
    expect(await textOf(objects, narinfoKey("main", hash))).toBe(cache.narinfoText(bucket, hash));
  });

  it("rewrites `nix-cache-info` when the daemon's public origin changed, and purges it", async () => {
    const { cache, objects } = await pushedBefore28();
    await cache.backfillObjects();
    expect(await textOf(objects, cacheInfoKey("main"))).toContain(`Odu-Origin: ${ORIGIN}\n`);
    await cache.close();

    const MOVED = "https://odu.moved.example";
    const purged: { reason: string; cacheInfo: boolean }[] = [];
    const later = createCache({
      stateRoot: scratch,
      rootToken: ROOT,
      publicOrigin: MOVED,
      stores: new Map<string, ObjectStore>([["local", objects]]),
      purged: (moved) => purged.push({ reason: moved.reason, cacheInfo: moved.cacheInfo === true }),
    });
    trash.push(later);
    await later.backfillObjects();

    expect(await textOf(objects, cacheInfoKey("main"))).toBe(later.cacheInfoText("main"));
    expect(await textOf(objects, cacheInfoKey("main"))).toContain(`Odu-Origin: ${MOVED}\n`);
    expect(purged).toContainEqual({ reason: "repush", cacheInfo: true });
  });

  it("leaves alone a row whose NAR the legacy migration has not landed", async () => {
    const { cache, objects } = await pushedBefore28();
    const hash = storePathHash(PATHS[0] as string);
    const repo = openCacheRepo(join(scratch, "cache", "cache.sqlite"));
    const row = repo.object("main", PATHS[0] as string);
    if (row === null) throw new Error("no row");
    repo.putObject({ ...row, fileHash: null, fileSize: null });
    repo.close();

    expect(await cache.backfillObjects()).toEqual({ rows: 2, written: 1, failures: 0 });
    expect(await objects.head(narinfoKey("main", hash))).toBeNull();
    expect(await objects.head(narinfoKey("main", storePathHash(PATHS[1] as string)))).not.toBeNull();
  });
});

describe("a re-push purges the narinfo it rewrote", () => {
  const PATH = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-one";
  const bytes = new TextEncoder().encode(PATH);
  const narHash = `sha256:${base32(createHash("sha256").update(bytes).digest())}`;
  const file = `${narHash.slice("sha256:".length)}.nar.zst`;
  const narinfo = (sigs: readonly string[]): string =>
    [
      `StorePath: ${PATH}`,
      `URL: nar/${file}`,
      "Compression: none",
      `NarHash: ${narHash}`,
      `NarSize: ${bytes.length}`,
      "References: ",
      ...sigs.map((sig) => `Sig: ${sig}`),
      "",
    ].join("\n");

  it("announces the one address whose bytes changed, and not the NAR's", async () => {
    const purged: { bucket: string; store: string; reason: string; removed: string[] }[] = [];
    const cache = createCache({
      stateRoot: scratch,
      rootToken: ROOT,
      publicOrigin: ORIGIN,
      stores: new Map<string, ObjectStore>([["local", diskObjectStore({ dir: join(scratch, "cache") })]]),
      purged: (moved) =>
        purged.push({
          bucket: moved.bucket,
          store: moved.store,
          reason: moved.reason,
          removed: moved.removals.map((removal) => `${removal.hash}:${String(removal.narFile)}`),
        }),
    });
    trash.push(cache);
    await create(cache, "main", { public: true, store: "local" });
    const bucket = cache.bucket("main");
    if (bucket === null) throw new Error("no bucket main");
    const push = async (sigs: readonly string[]): Promise<void> => {
      const upload = await cache.beginUpload(bucket, file);
      await upload.write(bytes);
      await upload.commit();
      const outcome = await cache.acceptNarinfo(
        bucket,
        storePathHash(PATH),
        new Response(narinfo(sigs)).body as ReadableStream<Uint8Array>,
        { run: null, commit: null },
      );
      if (!outcome.ok) throw new Error(outcome.message);
    };

    await push([]);
    await push([]);
    expect(purged).toEqual([]);

    await push(["lane-1:YWJj"]);
    expect(purged).toEqual([
      {
        bucket: "main",
        store: "local",
        reason: "repush",
        removed: [`${storePathHash(PATH)}:null`],
      },
    ]);
  });
});
