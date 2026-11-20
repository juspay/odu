import { afterEach, describe, expect, it } from "bun:test";
import { createCache, type Cache } from "./cache";
import { storeFacts } from "./stores";
import { asRoot, localStores } from "./testlib";
import { cacheServer } from "./server";
import { purgeBroker } from "@odu/cordis/services";
import type { CacheBucket } from "./surface";

const BOUND = "http://127.0.0.1:18440";
const PUBLIC = "https://cache.example.com";

const trash: Cache[] = [];
afterEach(async () => {
  await Promise.all(trash.splice(0).map((cache) => cache.close()));
});

let world = 0;

async function row(publicOrigin: string): Promise<{
  cache: Cache;
  published: Map<string, CacheBucket>;
  publish: () => void;
}> {
  world += 1;
  const stateRoot = `${import.meta.dirname}/../../../.ci/cache-url-test/${process.pid}-${world}`;
  const cache = createCache({
    stateRoot,
    stores: localStores(stateRoot),
    rootToken: "root-token",
    publicOrigin,
  });
  trash.push(cache);
  const server = cacheServer({
    cache,
    publicOrigin,
    purge: purgeBroker(),
    mount: "/cache",
    stores: storeFacts(new Map()),
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

describe("the substituter URL a bucket publishes", () => {
  it("is the origin the row was constructed with, not the one it is bound to", async () => {
    for (const origin of [BOUND, PUBLIC]) {
      const { cache, published, publish } = await row(origin);
      const created = await cache.admin.create({
        ...asRoot("root-token"),
        name: "main",
        public: true,
        retentionDays: 30,
        upstreamKeys: [],
      });
      expect(created.ok).toBe(true);
      publish();
      expect(published.get("main")?.url).toBe(`${origin}/cache/main`);
    }
  });

  it("is on every row the board reads, including a bucket made before it attached", async () => {
    const { cache, published, publish } = await row(PUBLIC);
    await cache.admin.create({
      ...asRoot("root-token"),
      name: "early",
      public: false,
      retentionDays: 0,
      upstreamKeys: [],
    });
    publish();
    expect([...published.keys()]).toEqual(["early"]);
    expect(published.get("early")?.url).toBe(`${PUBLIC}/cache/early`);
  });

  it("is the bucket's own domain when it has one, while push keeps the path", async () => {
    const { cache, published, publish } = await row("https://odu.example");
    await cache.admin.create({
      ...asRoot("root-token"),
      name: "kolu",
      public: true,
      retentionDays: 30,
      upstreamKeys: [],
    });
    const named = await cache.admin.domain({
      ...asRoot("root-token"),
      bucket: "kolu",
      domain: "cache.kolu.dev",
    });
    expect(named).toMatchObject({ ok: true, value: { domain: "cache.kolu.dev" } });
    publish();
    expect(published.get("kolu")?.url).toBe("https://cache.kolu.dev");
    expect(published.get("kolu")?.pushUrl).toBe("https://odu.example/cache/kolu");
    const described = await cache.admin.describe({ bucket: "kolu" });
    expect(described).toMatchObject({ ok: true, value: { domain: "cache.kolu.dev" } });
  });
});
