/**
 * READS THAT LEAVE ODU (PLAN 2.8) — the three facts that belong to no other
 * suite, and all three are about a store the operator put a DOMAIN in front of.
 *
 * - **The address a bucket publishes.** A public bucket on a store with a
 *   `publicUrl` is read from the store, so that is the substituter URL odu
 *   advertises and `readsFrom` says so. Everything else — a private bucket, a
 *   bucket on the daemon's own disk — is still read from odu, and `pushUrl`
 *   never moves, because a push is authenticated by odu whatever serves the
 *   reads.
 * - **The boot probe.** A `publicUrl` is a promise made outside odu, so the
 *   daemon asks the domain for the one file every Nix client reads first and
 *   logs a refusal when the answer is not it. `probePublicStores` returns what
 *   it would log, which is the only reason it can be asserted here.
 * - **The backfill.** Narinfos became objects in 2.8; every bucket pushed to
 *   before it has rows whose objects do not exist. The backfill writes them,
 *   and the claim worth proving is that it can be run again: the second pass
 *   writes nothing, and a rewritten object is written again only when its
 *   bytes are wrong.
 *
 * The store here is the daemon's own disk, which is enough for all three: the
 * backfill talks to an `ObjectStore` and nothing else, and `gcStores.test.ts`
 * is where the two stores are run against each other.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { purgeBroker } from "@odu/cordis/services";
import { diskObjectStore, type ObjectStore, type S3Declaration, type StoreDeclarations } from "@odu/objects";
import { type Cache, createCache } from "./cache";
import { base32, storePathHash } from "./narinfo";
import { cacheServer, probePublicStores } from "./server";
import { cacheInfoKey, narinfoKey, NIX_CACHE_INFO } from "./staging";
import { storeFacts } from "./stores";
import type { CacheBucket } from "./surface";
import { asRoot } from "./testlib";

const ROOT = "root-token";
const ORIGIN = "https://odu.example.org";
const PUBLIC_URL = "https://cache.example.com";

/** One declared store with a domain bound to it. Spelled as a value rather
 *  than parsed from a file: `stores.test.ts` owns the parse, and what this
 *  file is about starts once the declaration exists. */
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

/** The same store with nothing bound to it: the operator declared R2 but never
 *  gave it a name of its own. */
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

/**
 * A daemon with `r2` declared beside `local`, and the rows it publishes.
 *
 * The declared store's OBJECTS are a directory here — nothing below reads or
 * writes one, and the rule under test is about the declaration, which is the
 * only thing the server ever sees of a store.
 */
function daemon(declared: StoreDeclarations): {
  cache: Cache;
  published: Map<string, CacheBucket>;
  publish: () => void;
} {
  const cache = createCache({
    stateRoot: scratch,
    rootToken: ROOT,
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
    // A PUSH IS STILL ODU'S: the store serves bytes to anyone, but only this
    // daemon takes new ones, and it authenticates them on its own path.
    expect(published.get("kolu")?.pushUrl).toBe(`${ORIGIN}/cache/kolu`);
    const described = await cache.admin.describe({ bucket: "kolu" });
    expect(described).toMatchObject({ ok: true, value: { store: "r2" } });
  });

  it("is not used by a PRIVATE bucket, which odu reads for the token's sake", async () => {
    const { cache, published, publish } = daemon(declaring(R2));
    await create(cache, "secret", { public: false, store: "r2" });
    publish();
    // The bytes are on the same store with the same domain in front of it, and
    // the address is still odu's: a private bucket's reads are admitted by a
    // token this daemon holds, and a domain that served them would serve them
    // to everyone. (The NAR itself still leaves, as a signed redirect odu only
    // mints for an admitted reader — `routes.test.ts`.)
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
    // `local` can never have one: those objects are files on this machine, and
    // nothing but this process can read them.
    expect(published.get("disk")?.readsFrom).toBe("odu");
  });

  it("beats the bucket's own domain, which odu still honours for everything else", async () => {
    const { cache, published, publish } = daemon(declaring(R2));
    await create(cache, "kolu", { public: true, store: "r2" });
    expect(
      await cache.admin.domain({ ...asRoot(ROOT), bucket: "kolu", domain: "cache.kolu.dev" }),
    ).toMatchObject({ ok: true });
    publish();
    // THE READ ADDRESS IS WHERE THE BYTES ARE. A domain pointed at odu would
    // route every substitution back through this daemon, which is the thing
    // 2.8 exists to stop; the name keeps serving pushes and the `missing`
    // query, which odu answers from its own database.
    expect(published.get("kolu")?.url).toBe(`${PUBLIC_URL}/kolu`);
    expect(published.get("kolu")?.readsFrom).toBe("store");
    expect(published.get("kolu")?.pushUrl).toBe(`${ORIGIN}/cache/kolu`);
    expect(cache.bucketByDomain("cache.kolu.dev")?.name).toBe("kolu");

    // And on a PRIVATE bucket, with no store URL to lose to, the domain is
    // still the whole address.
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

  /** A `fetch` that answers the same thing to everything, and remembers what
   *  it was asked. */
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
      send,
      log: (event, fields) => logged.push({ event, fields }),
    });
    return { refusals, asked, logged };
  };

  it("is satisfied by the file a Nix client reads first", async () => {
    const seen = await probe(() => new Response(NIX_CACHE_INFO, { status: 200 }));
    expect(seen.asked).toEqual([PROBED]);
    expect(seen.refusals).toEqual([]);
    expect(seen.logged).toEqual([]);
  });

  it("refuses a 404, a wrong body and a request that never arrived, naming each", async () => {
    // THE THREE WAYS A BOUND DOMAIN IS WRONG: nothing there, something else
    // there (a parked page, another bucket), and nothing answering at all.
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
      // A LOGGED REFUSAL, NEVER A BOOT FAILURE: the daemon keeps serving every
      // bucket itself while the operator's DNS catches up.
      expect({ name, logged: seen.logged }).toEqual({
        name,
        logged: [{ event: "cache.store.public.unreachable", fields: { store: "r2", url: PROBED, status } }],
      });
    }
  });

  it("never asks about a store whose buckets are all private", async () => {
    // The domain may not be bound yet, and it would not matter: nothing on
    // this store is read from it, so a refusal would be noise at every boot.
    const seen = await probe(() => new Response("", { status: 404 }), [
      { name: "secret", public: false, store: "r2" },
    ]);
    expect(seen.asked).toEqual([]);
    expect(seen.refusals).toEqual([]);
  });
});

describe("the narinfo objects a bucket pushed before 2.8 is missing", () => {
  const PATHS = [
    "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-one",
    "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-two",
  ];

  /** The cache, its disk store, and two pushed paths — then the store put back
   *  the way 2.7 left it: rows, NARs, and no text objects at all. */
  async function pushedBefore28(): Promise<{ cache: Cache; objects: ObjectStore }> {
    const objects = diskObjectStore({ dir: join(scratch, "cache") });
    const cache = createCache({
      stateRoot: scratch,
      rootToken: ROOT,
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
      );
      if (!outcome.ok) throw new Error(`push ${storePath}: ${outcome.message}`);
    }
    // STAGE THE PAST: delete what 2.8 writes, leaving exactly what a bucket
    // pushed to by the older daemon holds.
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
      // THE OBJECT IS THE ROW'S TEXT: a client that never reaches odu must get
      // the same signed narinfo odu would have rendered for it.
      expect(await textOf(objects, narinfoKey("main", hash))).toBe(cache.narinfoText(bucket, hash));
    }
    expect(await textOf(objects, cacheInfoKey("main"))).toBe(NIX_CACHE_INFO);
  });

  it("writes nothing the second time, which is how a restart resumes it", async () => {
    const { cache } = await pushedBefore28();
    expect((await cache.backfillObjects()).written).toBe(2);
    // SIXTEEN THOUSAND ROWS ON ONE BUCKET: a pass that rewrote what it had
    // already written would make every restart cost the whole catch-up again.
    expect(await cache.backfillObjects()).toEqual({ rows: 2, written: 0, failures: 0 });
  });

  it("rewrites an object whose bytes are not what the row says", async () => {
    const { cache, objects } = await pushedBefore28();
    await cache.backfillObjects();
    const bucket = cache.bucket("main");
    if (bucket === null) throw new Error("no bucket main");
    const hash = storePathHash(PATHS[0] as string);
    // A HALF-WRITTEN OBJECT, or one left by a key rotation: the row is the
    // truth, so the store's copy loses.
    await objects.delete(narinfoKey("main", hash));
    expect((await objects.put(narinfoKey("main", hash), new Blob(["Stale: yes\n"]))).ok).toBe(true);

    expect(await cache.backfillObjects()).toEqual({ rows: 2, written: 1, failures: 0 });
    expect(await textOf(objects, narinfoKey("main", hash))).toBe(cache.narinfoText(bucket, hash));
  });
});
