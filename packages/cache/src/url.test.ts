/**
 * THE URL A BUCKET PUBLISHES, which is the one thing about the cache that a
 * proxy changes — and, since the cache owns its own contract, the one thing it
 * used to borrow from the service.
 *
 * A daemon behind nginx is bound to loopback; the address its clients must be
 * told is the proxy's, and `odu cache use` prints whatever this answers into a
 * `nix.conf`. So the row is CONSTRUCTED with the public origin, and every row it
 * publishes carries that address rather than the one this process happens to be
 * bound to.
 *
 * A loopback URL in a `nix.conf` is a substituter that works for nobody, which
 * is why this asserts the string a reader copies rather than a field name.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createCache, type Cache } from "./cache";
import { asRoot } from "./testlib";
import { cacheServer } from "./server";
import type { CacheBucket } from "./surface";

const BOUND = "http://127.0.0.1:18440";
const PUBLIC = "https://cache.example.com";

const trash: Cache[] = [];
afterEach(async () => {
  await Promise.all(trash.splice(0).map((cache) => cache.close()));
});

/** A cache over a throwaway state root with NOTHING in the store: no NAR is
 *  read or written here, so the Nix daemon is never consulted. */
let world = 0;

async function row(publicOrigin: string): Promise<{
  cache: Cache;
  published: Map<string, CacheBucket>;
  publish: () => void;
}> {
  world += 1;
  const cache = createCache({
    // A WORLD PER CASE: a bucket created by one case must not be visible to the
    // next, or a `create` would answer `bucket_exists` for a reason this test is
    // not about.
    stateRoot: `${import.meta.dirname}/../../../.ci/cache-url-test/${process.pid}-${world}`,
    rootToken: "root-token",
  });
  trash.push(cache);
  const server = cacheServer({ cache, publicOrigin, mount: "/cache" });
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
    held: { upsert: () => {}, remove: () => {} },
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
      // The ROW a subscriber holds carries the address a person would paste,
      // and it moved with the construction rather than with the listener.
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
    // `attach` publishes once, so a daemon that had a cache before it had a
    // listener still shows it.
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
    // A NAME is the whole substituter address. The push API still needs the
    // bucket in its path, so `pushUrl` does not move — and the advertised
    // scheme follows the deployment's public origin (here, TLS).
    expect(published.get("kolu")?.url).toBe("https://cache.kolu.dev");
    expect(published.get("kolu")?.pushUrl).toBe("https://odu.example/cache/kolu");
    const described = await cache.admin.describe({ bucket: "kolu" });
    expect(described).toMatchObject({ ok: true, value: { domain: "cache.kolu.dev" } });
  });
});
