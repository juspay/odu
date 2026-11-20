import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeBroker } from "@odu/cordis/services";
import { type Cache, createCache } from "./cache";
import { cacheServer, type CacheServer } from "./server";
import { storeFacts } from "./stores";
import { asRoot, localStores } from "./testlib";

const ROOT = "root-token";
const PUBLIC = "https://odu.example.org";

const trash: { cache: Cache; dir: string }[] = [];
afterEach(async () => {
  for (const { cache, dir } of trash.splice(0)) {
    await cache.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function row(
  buckets: readonly { name: string; public?: boolean; domain?: string }[],
): Promise<CacheServer> {
  const dir = mkdtempSync(join(tmpdir(), "odu-bucket-at-"));
  const cache = createCache({
    stateRoot: dir,
    stores: localStores(dir),
    rootToken: ROOT,
    publicOrigin: PUBLIC,
  });
  trash.push({ cache, dir });
  for (const bucket of buckets) {
    await cache.admin.create({
      ...asRoot(ROOT),
      name: bucket.name,
      public: bucket.public ?? true,
      upstreamKeys: [],
      retentionDays: 30,
    });
    if (bucket.domain !== undefined) {
      await cache.admin.domain({
        ...asRoot(ROOT),
        bucket: bucket.name,
        domain: bucket.domain,
      });
    }
  }
  return cacheServer({
    cache,
    publicOrigin: PUBLIC,
    purge: purgeBroker(),
    mount: "/cache",
    stores: storeFacts(new Map()),
  });
}

describe("the bucket a substituter URL names", () => {
  it("answers the path form this daemon publishes, with ITS origin", async () => {
    const server = await row([{ name: "main" }]);
    expect(server.bucketAt(`${PUBLIC}/cache/main`)).toMatchObject({
      name: "main",
      origin: PUBLIC,
      substituter: `${PUBLIC}/cache/main`,
    });
    expect(server.bucketAt(`${PUBLIC}/cache/main/`)).not.toBeNull();
  });

  it("answers a bucket at its own domain", async () => {
    const server = await row([{ name: "main", domain: "cache.example.com" }]);
    expect(server.bucketAt("https://cache.example.com")).toMatchObject({
      name: "main",
      origin: PUBLIC,
    });
    expect(server.bucketAt(`${PUBLIC}/cache/main`)).not.toBeNull();
  });

  it("answers the URL IT advertises, never the string it was asked about", async () => {
    const server = await row([{ name: "main" }]);
    expect(server.bucketAt(`https://evil.example@odu.example.org/cache/main`)).toMatchObject({
      name: "main",
      substituter: `${PUBLIC}/cache/main`,
    });
    expect(server.bucketAt(`${PUBLIC}/cache/main/`)).toMatchObject({
      substituter: `${PUBLIC}/cache/main`,
    });
  });

  it("answers a PRIVATE bucket, which no anonymous probe could have found", async () => {
    const server = await row([{ name: "secret", public: false }]);
    expect(server.bucketAt(`${PUBLIC}/cache/secret`)).toMatchObject({ name: "secret" });
  });

  it("refuses a URL at somebody else's host that names one of our buckets", async () => {
    const server = await row([{ name: "main" }]);
    expect(server.bucketAt("https://evil.example/cache/main")).toBeNull();
    expect(server.bucketAt("https://evil.example/main")).toBeNull();
  });

  it("refuses a bucket name this daemon does not serve", async () => {
    const server = await row([{ name: "main" }]);
    expect(server.bucketAt(`${PUBLIC}/cache/nope`)).toBeNull();
  });

  it("refuses a domain nobody bound", async () => {
    const server = await row([{ name: "main" }]);
    expect(server.bucketAt("https://cache.example.com")).toBeNull();
  });

  it("refuses a path under our origin that is not the mount", async () => {
    const server = await row([{ name: "main" }]);
    expect(server.bucketAt(`${PUBLIC}/main`)).toBeNull();
    expect(server.bucketAt(`${PUBLIC}/other/cache/main`)).toBeNull();
  });

  it("refuses a scheme that is not http(s), and a string that is not a URL", async () => {
    const server = await row([{ name: "main" }]);
    expect(server.bucketAt("file:///cache/main")).toBeNull();
    expect(server.bucketAt("s3://bucket/main")).toBeNull();
    expect(server.bucketAt("main")).toBeNull();
    expect(server.bucketAt("")).toBeNull();
  });
});
