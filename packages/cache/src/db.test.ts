/**
 * The metadata: migrations, and every round trip the cache depends on.
 *
 * On `:memory:` — the repository is the seam PR 12 replaces with Postgres, so
 * what is asserted here is the INTERFACE (rows in, rows out, no SQL anywhere
 * else) rather than SQLite's behaviour. The two exceptions are the two facts
 * that are SQLite's and matter: the schema version, and that a file written by
 * a newer build is refused rather than read.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BucketRow,
  CACHE_SCHEMA_VERSION,
  type ObjectRow,
  openCacheRepo,
  type TokenRow,
} from "./db";

const NOW = 1_700_000_000_000;

const bucket: BucketRow = {
  name: "main",
  isPublic: true,
  retentionDays: 30,
  keyName: "main-1",
  secretKey: "main-1:c2VjcmV0",
  publicKey: "main-1:cHVibGlj",
  upstreamKeys: ["cache.nixos.org-1"],
  created: NOW,
  domain: null,
};

const token: TokenRow = {
  id: "t1",
  hash: "a".repeat(64),
  bucketGlob: "main",
  scope: "write",
  expires: null,
  lastUsed: null,
  revoked: false,
  created: NOW,
};

const object: ObjectRow = {
  bucket: "main",
  storePath: "/nix/store/pa6rydwgjxxmmvdxap7qk9c85h8jbimy-hello-2.12.3",
  hash: "pa6rydwgjxxmmvdxap7qk9c85h8jbimy",
  narHash: "sha256:0b56hsfzp1d4kx9j095zk64b0zmi189s3ih8mk2zyshpi48fgw76",
  narSize: 279592,
  references: ["/nix/store/pqyiidz5mi73wv5f91d48s9plcqyj5bz-glibc-2.44-57"],
  deriver: "/nix/store/y1kh9arkh7w7am664yqbnnrfpsisqcdc-hello-2.12.3.drv",
  sigs: ["main-1:c2ln"],
  hits: 3,
  created: NOW,
  lastAccessed: NOW,
};

describe("migrations", () => {
  it("stamps the schema version it applied", () => {
    const path = join(mkdtempSync(join(tmpdir(), "odu-cache-db-")), "cache.sqlite");
    try {
      openCacheRepo(path).close();
      const db = new Database(path);
      const row = db.query("PRAGMA user_version;").get() as { user_version: number };
      expect(row.user_version).toBe(CACHE_SCHEMA_VERSION);
      db.close();
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("refuses a file written by a newer build", () => {
    const path = join(mkdtempSync(join(tmpdir(), "odu-cache-db-")), "cache.sqlite");
    try {
      const db = new Database(path, { create: true });
      db.exec(`PRAGMA user_version = ${CACHE_SCHEMA_VERSION + 1};`);
      db.close();
      expect(() => openCacheRepo(path)).toThrow(/newer odu/);
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });
});

describe("buckets", () => {
  it("round-trips, including the upstream key list", () => {
    const repo = openCacheRepo(":memory:");
    repo.putBucket(bucket);
    expect(repo.bucket("main")).toEqual(bucket);
    expect(repo.bucket("absent")).toBeNull();
    expect(repo.buckets().map((row) => row.name)).toEqual(["main"]);
  });

  it("finds a bucket by the domain it claimed", () => {
    const repo = openCacheRepo(":memory:");
    repo.putBucket({ ...bucket, domain: "cache.example.org" });
    expect(repo.bucketByDomain("cache.example.org")?.name).toBe("main");
    expect(repo.bucketByDomain("other.example.org")).toBeNull();
    // A-TO-B: the upsert moves the name rather than keeping the old one.
    repo.putBucket({ ...bucket, domain: null });
    expect(repo.bucketByDomain("cache.example.org")).toBeNull();
  });

  it("refuses two buckets with one domain", () => {
    const repo = openCacheRepo(":memory:");
    repo.putBucket({ ...bucket, domain: "cache.example.org" });
    expect(() =>
      repo.putBucket({ ...bucket, name: "other", domain: "cache.example.org" }),
    ).toThrow();
  });

  it("updates a bucket in place rather than duplicating it", () => {
    const repo = openCacheRepo(":memory:");
    repo.putBucket(bucket);
    repo.putBucket({ ...bucket, isPublic: false, retentionDays: 7 });
    expect(repo.buckets()).toHaveLength(1);
    expect(repo.bucket("main")).toEqual({ ...bucket, isPublic: false, retentionDays: 7 });
  });
});

describe("held uploads", () => {
  it("round-trips the reason and keeps the arrival time on a refresh", () => {
    const repo = openCacheRepo(":memory:");
    repo.putHeld({
      bucket: "main",
      storePath: "/nix/store/parent",
      missing: ["/nix/store/child"],
      fetching: 0,
      created: NOW,
    });
    // A later drain narrowed the reason; the row's `since` is when the path
    // first arrived and must not move.
    repo.putHeld({
      bucket: "main",
      storePath: "/nix/store/parent",
      missing: [],
      fetching: 0,
      created: NOW + 5000,
    });
    expect(repo.held()).toEqual([
      { bucket: "main", storePath: "/nix/store/parent", missing: [], fetching: 0, created: NOW },
    ]);
    expect(repo.held("main")).toHaveLength(1);
    expect(repo.held("other")).toEqual([]);
    repo.deleteHeld("main", "/nix/store/parent");
    expect(repo.held()).toEqual([]);
  });

  it("goes with its bucket", () => {
    const repo = openCacheRepo(":memory:");
    repo.putBucket(bucket);
    repo.putHeld({
      bucket: "main",
      storePath: "/nix/store/parent",
      missing: ["/nix/store/child"],
      fetching: 0,
      created: NOW,
    });
    repo.deleteBucket("main");
    expect(repo.held()).toEqual([]);
  });
});

describe("tokens", () => {
  it("round-trips and finds by hash", () => {
    const repo = openCacheRepo(":memory:");
    repo.putToken(token);
    expect(repo.tokenByHash(token.hash)).toEqual(token);
    expect(repo.tokens()).toEqual([token]);
  });

  it("revokes one token and leaves the rest", () => {
    const repo = openCacheRepo(":memory:");
    repo.putToken(token);
    repo.putToken({ ...token, id: "t2", hash: "b".repeat(64) });
    expect(repo.setTokenRevoked("t1", true)).toBe(true);
    expect(repo.setTokenRevoked("nope", true)).toBe(false);
    const rows = repo.tokens();
    expect(rows.find((row) => row.id === "t1")?.revoked).toBe(true);
    expect(rows.find((row) => row.id === "t2")?.revoked).toBe(false);
  });

  it("records last use", () => {
    const repo = openCacheRepo(":memory:");
    repo.putToken(token);
    repo.touchToken("t1", NOW + 5);
    expect(repo.tokenByHash(token.hash)?.lastUsed).toBe(NOW + 5);
  });
});

describe("objects", () => {
  it("round-trips and is findable by store path, hash and nar hash", () => {
    const repo = openCacheRepo(":memory:");
    repo.putObject(object);
    expect(repo.object("main", object.storePath)).toEqual(object);
    expect(repo.objectByHash("main", object.hash)).toEqual(object);
    expect(repo.objectByNarHash("main", object.narHash)).toEqual(object);
    expect(repo.objectByHash("other", object.hash)).toBeNull();
    expect(repo.objects("main")).toHaveLength(1);
    expect(repo.objects("other")).toHaveLength(0);
  });

  it("keeps the hit count and creation time across a re-push", () => {
    const repo = openCacheRepo(":memory:");
    repo.putObject(object);
    repo.putObject({ ...object, narSize: 1, hits: 0, created: NOW + 99 });
    const row = repo.object("main", object.storePath);
    expect(row?.narSize).toBe(1);
    // The count is a property of the ROW, not of the push that overwrote it.
    expect(row?.hits).toBe(object.hits);
    expect(row?.created).toBe(object.created);
  });

  it("counts a read as one write: last access and hits together", () => {
    const repo = openCacheRepo(":memory:");
    repo.putObject(object);
    repo.touchObject("main", object.storePath, NOW + 1_000);
    const row = repo.object("main", object.storePath);
    expect(row?.lastAccessed).toBe(NOW + 1_000);
    expect(row?.hits).toBe(object.hits + 1);
  });

  it("deletes one row", () => {
    const repo = openCacheRepo(":memory:");
    repo.putObject(object);
    repo.deleteObject("main", object.storePath);
    expect(repo.object("main", object.storePath)).toBeNull();
  });
});

describe("counting", () => {
  it("counts objects, bytes and reads per bucket in SQL", () => {
    const repo = openCacheRepo(":memory:");
    repo.putObject(object);
    repo.putObject({
      ...object,
      storePath: "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-second",
      hash: "a".repeat(32),
      narSize: 100,
    });
    repo.putObject({ ...object, bucket: "other" });
    // `lastPush` is the newest narinfo's `created`, and `hits` the sum — the two
    // facts a board paints per bucket, counted here rather than loaded as rows.
    expect(repo.bucketStats()).toEqual(
      new Map([
        ["main", { objects: 2, bytes: 279692, hits: 6, lastPush: NOW }],
        ["other", { objects: 1, bytes: 279592, hits: 3, lastPush: NOW }],
      ]),
    );
    // A bucket with nothing in it has no row at all, which the caller reads as
    // zero rather than as an error.
    expect(repo.bucketStats().get("empty")).toBeUndefined();
  });

  it("totals reads and the newest access across every bucket", () => {
    const repo = openCacheRepo(":memory:");
    expect(repo.objectTotals()).toEqual({ objects: 0, bytes: 0, hits: 0, lastAccessed: null });
    repo.putObject(object);
    repo.putObject({ ...object, bucket: "other", lastAccessed: NOW + 5 });
    expect(repo.objectTotals()).toEqual({
      objects: 2,
      bytes: 559184,
      hits: object.hits * 2,
      lastAccessed: NOW + 5,
    });
  });
});

describe("pins", () => {
  it("round-trips a closure, and replaces it by name", () => {
    const repo = openCacheRepo(":memory:");
    repo.putPin({ bucket: "main", name: "release-1.2", rootPaths: ["/nix/store/a"], created: NOW });
    repo.putPin({ bucket: "main", name: "release-1.2", rootPaths: ["/nix/store/b"], created: NOW });
    expect(repo.pins("main")).toEqual([
      { bucket: "main", name: "release-1.2", rootPaths: ["/nix/store/b"], created: NOW },
    ]);
    expect(repo.deletePin("main", "release-1.2")).toBe(true);
    expect(repo.deletePin("main", "release-1.2")).toBe(false);
    expect(repo.pins()).toHaveLength(0);
  });
});

describe("deleting a bucket", () => {
  it("takes its objects and pins with it", () => {
    const repo = openCacheRepo(":memory:");
    repo.putBucket(bucket);
    repo.putObject(object);
    repo.putPin({ bucket: "main", name: "p", rootPaths: [], created: NOW });
    repo.deleteBucket("main");
    expect(repo.buckets()).toHaveLength(0);
    expect(repo.objects()).toHaveLength(0);
    expect(repo.pins()).toHaveLength(0);
  });
});
