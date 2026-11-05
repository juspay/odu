/**
 * WHICH BUCKET A SUBSTITUTER URL NAMES — the whole of PLAN 4.1's write grant,
 * and the one question a repository must not be able to lie its way through.
 *
 * The grant used to be decided by asking the URL for its `nix-cache-info` and
 * believing the `Odu-Origin` / `Odu-Bucket` lines in the BODY, so one line of
 * `flake.nix` pointing at a server the attacker runs claimed to be any bucket
 * here and collected a write token for it. This decides from the URL against
 * what the row ADVERTISES, which is why every case below is a URL and not a
 * response.
 */

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

/** A cache row over a throwaway state root, with these buckets created. */
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
      // THE DAEMON'S OWN PUSH ORIGIN, never a string a reader supplied.
      origin: PUBLIC,
      substituter: `${PUBLIC}/cache/main`,
    });
    // A trailing slash is the same URL.
    expect(server.bucketAt(`${PUBLIC}/cache/main/`)).not.toBeNull();
  });

  it("answers a bucket at its own domain", async () => {
    const server = await row([{ name: "main", domain: "cache.example.com" }]);
    expect(server.bucketAt("https://cache.example.com")).toMatchObject({
      name: "main",
      origin: PUBLIC,
    });
    // AND STILL AT THE PATH FORM, which every bucket answers whatever else it
    // has — a repository may have either in its `nixConfig`.
    expect(server.bucketAt(`${PUBLIC}/cache/main`)).not.toBeNull();
  });

  it("answers a PRIVATE bucket, which no anonymous probe could have found", async () => {
    // The probe could not resolve one at all: a private bucket's
    // `nix-cache-info` is a 404 to a reader without a token, so every repo
    // reading from one silently pushed nothing.
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
    // `/main` is not `/cache/main`: the candidate parse finds the bucket by
    // its last segment, and the confirmation against what the row advertises
    // is what rejects it.
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
