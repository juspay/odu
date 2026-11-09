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
import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BucketRow,
  CACHE_SCHEMA_VERSION,
  type CacheRepo,
  MIGRATIONS,
  type ObjectRow,
  openCacheRepo,
  type PathSort,
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
  store: "local",
};

const token: TokenRow = {
  id: "t1",
  hash: "a".repeat(64),
  bucketGlob: "main",
  scope: "write",
  expires: null,
  label: null,
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
  ca: null,
  caProof: "unknown",
    compression: "zstd",
    fileHash: null,
    fileSize: null,
  sigs: ["main-1:c2ln"],
  hits: 3,
  created: NOW,
  lastWanted: NOW,
  run: null,
  commit: null,
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

  it("counts a read without renewing it: hits move, lastWanted does not", () => {
    // Reads are leaving odu (PLAN 2.8), so a clock that is about to stop
    // ticking cannot be the one retention reads. The counter is still the
    // cache's own statistic.
    const repo = openCacheRepo(":memory:");
    repo.putObject(object);
    repo.countRead("main", object.storePath);
    const row = repo.object("main", object.storePath);
    expect(row?.hits).toBe(object.hits + 1);
    expect(row?.lastWanted).toBe(object.lastWanted);
  });

  it("renews exactly the paths a want names, in one statement", () => {
    // The `missing` query asks about a whole closure at once, so the renewal
    // is one write for the batch — and a path nobody asked about keeps its
    // own clock.
    const repo = openCacheRepo(":memory:");
    const other = { ...object, storePath: `${object.storePath}-two`, hash: "b".repeat(32) };
    const untouched = { ...object, storePath: `${object.storePath}-three`, hash: "c".repeat(32) };
    for (const row of [object, other, untouched]) repo.putObject(row);
    repo.want("main", [object.storePath, other.storePath], NOW + 1_000);
    expect(repo.object("main", object.storePath)?.lastWanted).toBe(NOW + 1_000);
    expect(repo.object("main", other.storePath)?.lastWanted).toBe(NOW + 1_000);
    expect(repo.object("main", untouched.storePath)?.lastWanted).toBe(NOW);
    expect(repo.object("main", object.storePath)?.hits).toBe(object.hits);
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
    expect(repo.objectTotals()).toEqual({ objects: 0, bytes: 0, hits: 0, lastWanted: null });
    repo.putObject(object);
    repo.putObject({ ...object, bucket: "other", lastWanted: NOW + 5 });
    expect(repo.objectTotals()).toEqual({
      objects: 2,
      bytes: 559184,
      hits: object.hits * 2,
      lastWanted: NOW + 5,
    });
  });
});

/**
 * THE GROUPING IS THE DATABASE'S, and that is the whole point of it: a view
 * holding one page cannot count a bucket, and a view that tried would state
 * its page's totals as the bucket's and change them at "show more". So the
 * counts, the sums, the order and the paging are asserted here, where they
 * are computed.
 */
describe("a bucket's paths, by package", () => {
  const build = (name: string, hash: string, over: Partial<ObjectRow>): ObjectRow => ({
    ...object,
    storePath: `/nix/store/${hash}-${name}`,
    hash,
    ...over,
  });
  /** Three builds of one package and one of another, so a group's totals are
   *  neither the page's nor any one row's. */
  const seed = (repo: CacheRepo): void => {
    repo.putObject(
      build("widget-1.0", "a".repeat(32), { narSize: 100, hits: 1, created: NOW, lastWanted: NOW }),
    );
    repo.putObject(
      build("widget-1.0", "b".repeat(32), {
        narSize: 200,
        hits: 2,
        created: NOW + 10,
        lastWanted: NOW + 50,
      }),
    );
    repo.putObject(
      build("widget-1.0", "c".repeat(32), {
        narSize: 300,
        hits: 4,
        created: NOW + 20,
        lastWanted: NOW + 5,
      }),
    );
    repo.putObject(
      build("zlib-1.3", "d".repeat(32), {
        narSize: 900,
        hits: 9,
        created: NOW + 15,
        lastWanted: NOW + 15,
      }),
    );
  };
  const page = { limit: 10, after: null, filter: null, sort: "pushed" as const, descending: true };

  it("counts and sums every version, and names the newest one's path", () => {
    const repo = openCacheRepo(":memory:");
    seed(repo);
    const { rows, next } = repo.objectGroupsPage("main", page);
    expect(next).toBeNull();
    expect(rows).toEqual([
      {
        name: "widget-1.0",
        versions: 3,
        bytes: 600,
        hits: 7,
        // The newest PUSH, and the latest want across all three — a version
        // nobody wants must not make the package look idle.
        pushed: NOW + 20,
        wanted: NOW + 50,
        storePath: `/nix/store/${"c".repeat(32)}-widget-1.0`,
        // The newest version's own, read off the same row the path is: this
        // seed states no provenance, so both are null.
        run: null,
        commit: null,
      },
      {
        name: "zlib-1.3",
        versions: 1,
        bytes: 900,
        hits: 9,
        pushed: NOW + 15,
        wanted: NOW + 15,
        storePath: `/nix/store/${"d".repeat(32)}-zlib-1.3`,
        run: null,
        commit: null,
      },
    ]);
  });

  it("orders by the aggregate, not by any one version", () => {
    const repo = openCacheRepo(":memory:");
    seed(repo);
    const names = (sort: PathSort, descending: boolean): string[] =>
      repo.objectGroupsPage("main", { ...page, sort, descending }).rows.map((row) => row.name);
    // zlib's single NAR (900) is the biggest; the PACKAGE widget holds 600
    // against it, so by size zlib leads — and by reads it does too.
    expect(names("size", true)).toEqual(["zlib-1.3", "widget-1.0"]);
    expect(names("size", false)).toEqual(["widget-1.0", "zlib-1.3"]);
    expect(names("reads", true)).toEqual(["zlib-1.3", "widget-1.0"]);
    expect(names("name", false)).toEqual(["widget-1.0", "zlib-1.3"]);
  });

  it("pages by the cursor it minted, and starts again on one from another order", () => {
    const repo = openCacheRepo(":memory:");
    seed(repo);
    const first = repo.objectGroupsPage("main", { ...page, sort: "size", limit: 1 });
    expect(first.rows.map((row) => row.name)).toEqual(["zlib-1.3"]);
    expect(first.next).not.toBeNull();
    const after = first.next;
    const second = repo.objectGroupsPage("main", { ...page, sort: "size", limit: 1, after });
    expect(second.rows.map((row) => row.name)).toEqual(["widget-1.0"]);
    expect(second.next).toBeNull();
    // A CURSOR NAMES ITS OWN ORDER. Replayed against another one it is no
    // cursor at all — the FIRST page, not an empty one: read as a number, a
    // name binds as NULL and every keyset test would fail silently.
    const elsewhere = repo.objectGroupsPage("main", { ...page, sort: "pushed", limit: 1, after });
    expect(elsewhere.rows).toHaveLength(1);
    expect(elsewhere.next).not.toBeNull();
  });

  it("narrows to one package's versions, and to a filter", () => {
    const repo = openCacheRepo(":memory:");
    seed(repo);
    const versions = repo.objectsPage("main", { ...page, name: "widget-1.0" });
    expect(versions.rows.map((row) => row.narSize)).toEqual([300, 200, 100]);
    // The filter is the same substring the board's box sends, and it narrows
    // the GROUPING too — the totals are of what matched.
    expect(
      repo.objectGroupsPage("main", { ...page, filter: "zlib" }).rows.map((row) => row.name),
    ).toEqual(["zlib-1.3"]);
  });

  it("reads a FILTERED group's provenance off the newest version the filter matched", () => {
    const repo = openCacheRepo(":memory:");
    // Two of one package's three builds share a hash prefix the third does
    // not, so the newest MATCHING version is not the newest version — and
    // the provenance columns have to come from the former.
    repo.putObject(
      build("widget-1.0", `prg${"a".repeat(29)}`, {
        created: NOW,
        run: "run-a",
        commit: "a".repeat(40),
      }),
    );
    repo.putObject(
      build("widget-1.0", `prg${"b".repeat(29)}`, {
        created: NOW + 10,
        run: "run-b",
        commit: "b".repeat(40),
      }),
    );
    repo.putObject(
      build("widget-1.0", `zzz${"c".repeat(29)}`, {
        created: NOW + 20,
        run: "run-c",
        commit: "c".repeat(40),
      }),
    );
    const { rows } = repo.objectGroupsPage("main", { ...page, filter: "prg" });
    expect(rows).toHaveLength(1);
    // THE ASSERTION A MIS-BINDING FAILS: every per-version subquery carries
    // its own filter `?`, so a select list and a binding list that drifted
    // apart would answer run-c's row — or no row at all.
    expect(rows[0]).toMatchObject({
      versions: 2,
      storePath: `/nix/store/prg${"b".repeat(29)}-widget-1.0`,
      run: "run-b",
      commit: "b".repeat(40),
    });
  });

  it("orders paths themselves by the same columns", () => {
    const repo = openCacheRepo(":memory:");
    seed(repo);
    expect(
      repo.objectsPage("main", { ...page, sort: "size" }).rows.map((row) => row.narSize),
    ).toEqual([900, 300, 200, 100]);
    expect(
      repo
        .objectsPage("main", { ...page, sort: "reads", descending: false })
        .rows.map((row) => row.hits),
    ).toEqual([1, 2, 4, 9]);
  });
});

describe("pins", () => {
  it("round-trips a closure with its author, and replaces it by name", () => {
    const repo = openCacheRepo(":memory:");
    const pin = { bucket: "main", name: "release-1.2" };
    repo.putPin({ ...pin, rootPaths: ["/nix/store/a"], created: NOW, createdBy: "admin" });
    // A RE-POINT CARRIES THE NEW AUTHOR: a pin is whoever last made it, and
    // the rule about who may move it next reads that column.
    repo.putPin({ ...pin, rootPaths: ["/nix/store/b"], created: NOW, createdBy: "write" });
    expect(repo.pins("main")).toEqual([
      { ...pin, rootPaths: ["/nix/store/b"], created: NOW, createdBy: "write" },
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
    repo.putPin({ bucket: "main", name: "p", rootPaths: [], created: NOW, createdBy: "admin" });
    repo.deleteBucket("main");
    expect(repo.buckets()).toHaveLength(0);
    expect(repo.objects()).toHaveLength(0);
    expect(repo.pins()).toHaveLength(0);
  });
});

/** THE FOUR SQL STRINGS THAT SHIPPED BEFORE THIS PR, pinned by content.
 *
 * `slice(0, 4)` alone follows a future mid-list insert, so it would hand the
 * new migration list back to itself and pass. The hash makes a reorder or an
 * insert in the shipped prefix fail HERE, where the cause is obvious.
 */
const SHIPPED_V1_TO_V4_SHA256 =
  "278af79f3e7195b7faed7eb47e239afb5a7e978c4f8a5b5ccf8b1ea324a6f22e";

describe("upgrading an existing database", () => {
  it("opens a v4 file and applies only the appended migrations", () => {
    expect(
      createHash("sha256").update(MIGRATIONS.slice(0, 4).join("\n")).digest("hex"),
    ).toBe(SHIPPED_V1_TO_V4_SHA256);
    const dir = mkdtempSync(join(tmpdir(), "odu-cache-upgrade-"));
    const file = join(dir, "cache.sqlite");
    try {
      // THE POD'S FILE: the four migrations that shipped before this PR's
      // fetch progress. `user_version` is 4, and `domain` already exists.
      const old = new Database(file);
      for (const sql of MIGRATIONS.slice(0, 4)) old.exec(sql);
      old.exec("PRAGMA user_version = 4;");
      old.close();

      const repo = openCacheRepo(file);
      repo.close();

      const check = new Database(file);
      expect((check.query("PRAGMA user_version;").get() as { user_version: number }).user_version).toBe(
        CACHE_SCHEMA_VERSION,
      );
      const columns = (check.query("PRAGMA table_info(object);").all() as { name: string }[]).map(
        (column) => column.name,
      );
      expect(columns).toContain("ca");
      expect(columns).toContain("file_hash");
      expect(columns).toContain("file_size");
      const held = check.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'held'").get();
      expect(held).toBeNull();
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
