/**
 * THE METADATA — SQLite in WAL mode, behind a narrow repository interface.
 *
 * This is the first database in the tree (PLAN.md F3, which is why it is worth
 * a sentence): the run catalog is append-only files, and the cache needs
 * queries over mutable state — what is this bucket's oldest object, what does
 * this path reference, which tokens can write here. Files would mean an
 * index somebody has to keep true.
 *
 * **Why a repository interface rather than a store.** PR 12 puts several odu
 * servers behind one domain, which means Postgres, which means every caller
 * must stop knowing what SQLite is. The interface below is the whole of that
 * seam: rows in, rows out, no SQL, no transaction, no `Database` in a
 * signature. The cost is a handful of near-trivial methods, and the benefit is
 * that the swap is one file.
 *
 * **Why `bun:sqlite`.** It is the runtime's own binding — no native build, no
 * node-gyp in the Nix sandbox, no ABI to track — and odu already ships on Bun.
 *
 * **Migrations are by version.** `PRAGMA user_version` is the schema's own
 * number and the only place it lives; adding a column is a new entry in
 * {@link MIGRATIONS} and nothing else. A file written by a newer build is
 * refused rather than read, because reading it would mean silently dropping
 * whatever it added.
 */

import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";

/** A bucket: one cache, one substituter URL, one signing keypair. */
export interface BucketRow {
  name: string;
  isPublic: boolean;
  /** Days an object survives without being read. `0` expires everything that
   *  is not referenced or pinned, which is what the e2e suite uses to make GC
   *  deterministic. */
  retentionDays: number;
  keyName: string;
  secretKey: string;
  publicKey: string;
  /** Key NAMES whose signatures make a path "already upstream" — the filter
   *  that keeps nixpkgs out of a bucket. */
  upstreamKeys: readonly string[];
  created: number;
}

export type Scope = "read" | "write" | "admin";

/** A token. The plaintext exists exactly once, in the answer that minted it. */
export interface TokenRow {
  id: string;
  /** sha256 of the token, hex. Never the token. */
  hash: string;
  /** A comma-separated list of patterns; `*` is a wildcard. */
  bucketGlob: string;
  scope: Scope;
  expires: number | null;
  lastUsed: number | null;
  revoked: boolean;
  created: number;
}

/** One store path as this bucket knows it. The bytes are the store's. */
export interface ObjectRow {
  bucket: string;
  storePath: string;
  /** The store path's hash part — what a narinfo is named for. */
  hash: string;
  /** `sha256:<base32>` */
  narHash: string;
  narSize: number;
  references: readonly string[];
  deriver: string | null;
  sigs: readonly string[];
  /** narinfo reads. What `odu cache stats` reports. */
  hits: number;
  created: number;
  lastAccessed: number;
}

/** What one bucket's SQL totals say: the row a subscriber sees, minus the
 *  bucket's own columns. */
export interface BucketTotals {
  objects: number;
  bytes: number;
  /** narinfo reads, summed over the bucket's objects. */
  hits: number;
  /** When the newest narinfo landed; `null` for a bucket nothing was pushed
   *  to. */
  lastPush: number | null;
}

/**
 * AN UPLOAD THE BUCKET TOOK BUT CANNOT SERVE YET — a narinfo whose references
 * are not in the store.
 *
 * It is a ROW rather than a line of staging's memory because it is a fact the
 * bucket publishes: the board lists the paths a push is holding and why, and a
 * restart must not make a pending upload look like one that never arrived. The
 * staged narinfo itself stays on disk (staging's), so the row only names the
 * position and the reason.
 */
export interface HeldRow {
  bucket: string;
  storePath: string;
  /** References the store says are not valid, as Nix named them. */
  missing: readonly string[];
  created: number;
}

/** A named closure kept out of garbage collection. */
export interface PinRow {
  bucket: string;
  name: string;
  /** The closure resolved at pin time. GC also walks the bucket's own
   *  references from these roots, so a path added to the closure later is
   *  still protected. */
  rootPaths: readonly string[];
  created: number;
}

export interface CacheRepo {
  putBucket(row: BucketRow): void;
  bucket(name: string): BucketRow | null;
  buckets(): BucketRow[];
  deleteBucket(name: string): void;

  putToken(row: TokenRow): void;
  tokenByHash(hash: string): TokenRow | null;
  tokens(): TokenRow[];
  setTokenRevoked(id: string, revoked: boolean): boolean;
  touchToken(id: string, at: number): void;

  putObject(row: ObjectRow): void;
  object(bucket: string, storePath: string): ObjectRow | null;
  objectByHash(bucket: string, hash: string): ObjectRow | null;
  objectByNarHash(bucket: string, narHash: string): ObjectRow | null;
  objects(bucket?: string): ObjectRow[];
  /** Bump last access and the hit count together — one row write per read. */
  touchObject(bucket: string, storePath: string, at: number): void;
  deleteObject(bucket: string, storePath: string): void;

  putPin(row: PinRow): void;
  pins(bucket?: string): PinRow[];
  deletePin(bucket: string, name: string): boolean;

  /**
   * The uploads a bucket is holding for references. `put` refreshes the
   * REASON when a drain says something different, so a row's `since` stays
   * the moment the path first arrived.
   */
  putHeld(row: HeldRow): void;
  held(bucket?: string): HeldRow[];
  deleteHeld(bucket: string, storePath: string): void;

  /** Object count, nar bytes, reads and the newest push per bucket, COUNTED BY
   *  SQL. A cache with a hundred thousand objects must not answer "how big am
   *  I" by loading them — and a BOARD asks that question once per bucket per
   *  publish, which is the same argument one order of magnitude louder. */
  bucketStats(): Map<string, BucketTotals>;

  /**
   * ONE PAGE of a bucket's paths, newest first — the keyset page behind
   * `cache.paths`.
   *
   * `after` is a cursor this function minted (`cursorOf`), so a page is a
   * POSITION in `(created, store_path)` order rather than an offset: a push
   * landing between two pages shifts nothing the reader is about to read, which
   * an `OFFSET` would.
   */
  objectsPage(
    bucket: string,
    page: { limit: number; after: string | null; filter: string | null },
  ): { rows: ObjectRow[]; more: boolean };
  /** The same, over every bucket, plus reads and the newest access. */
  objectTotals(): {
    objects: number;
    bytes: number;
    hits: number;
    lastAccessed: number | null;
  };

  close(): void;
}

/**
 * Schema history, one entry per version, applied in order. `user_version` is
 * the index of the last applied entry, so a fresh file runs all of them and an
 * existing one runs the tail.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE bucket (
    name            TEXT PRIMARY KEY,
    is_public       INTEGER NOT NULL,
    retention_days  INTEGER NOT NULL,
    key_name        TEXT NOT NULL,
    secret_key      TEXT NOT NULL,
    public_key      TEXT NOT NULL,
    upstream_keys   TEXT NOT NULL,
    created         INTEGER NOT NULL
  );

  CREATE TABLE token (
    id          TEXT PRIMARY KEY,
    hash        TEXT NOT NULL UNIQUE,
    bucket_glob TEXT NOT NULL,
    scope       TEXT NOT NULL,
    expires     INTEGER,
    last_used   INTEGER,
    revoked     INTEGER NOT NULL DEFAULT 0,
    created     INTEGER NOT NULL
  );
  CREATE INDEX token_hash ON token (hash);

  CREATE TABLE object (
    bucket        TEXT NOT NULL,
    store_path    TEXT NOT NULL,
    hash          TEXT NOT NULL,
    nar_hash      TEXT NOT NULL,
    nar_size      INTEGER NOT NULL,
    refs          TEXT NOT NULL,
    deriver       TEXT,
    sigs          TEXT NOT NULL,
    hits          INTEGER NOT NULL DEFAULT 0,
    created       INTEGER NOT NULL,
    last_accessed INTEGER NOT NULL,
    PRIMARY KEY (bucket, store_path)
  );
  CREATE INDEX object_hash ON object (bucket, hash);
  CREATE INDEX object_nar_hash ON object (bucket, nar_hash);
  CREATE INDEX object_accessed ON object (bucket, last_accessed);

  CREATE TABLE pin (
    bucket     TEXT NOT NULL,
    name       TEXT NOT NULL,
    root_paths TEXT NOT NULL,
    created    INTEGER NOT NULL,
    PRIMARY KEY (bucket, name)
  );
  `,
  // v2 — WHAT A BUCKET IS HOLDING FOR REFERENCES. Before this the reason lived
  // only in a drain's memory and died with the process, so a person looking at
  // a stalled push saw nothing until the next drain happened to run.
  `
  CREATE TABLE held (
    bucket     TEXT NOT NULL,
    store_path TEXT NOT NULL,
    missing    TEXT NOT NULL,
    created    INTEGER NOT NULL,
    PRIMARY KEY (bucket, store_path)
  );
  `,
];

/** The schema this build writes. A file carrying a HIGHER number was written by
 *  a newer odu and is refused rather than read. */
export const CACHE_SCHEMA_VERSION = MIGRATIONS.length;

interface Row {
  [column: string]: unknown;
}

const text = (row: Row, column: string): string => String(row[column]);
const maybeText = (row: Row, column: string): string | null => {
  const value = row[column];
  return value === null || value === undefined ? null : String(value);
};
const integer = (row: Row, column: string): number => Number(row[column]);
const list = (row: Row, column: string): string[] => {
  try {
    const parsed = JSON.parse(text(row, column)) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/**
 * A PAGE CURSOR — `<created>|<storePath>`, the last row of the page just given.
 *
 * Opaque to a caller on purpose: it names a POSITION in the page order, and a
 * caller that could read it would be a caller tempted to mint one. A malformed
 * cursor is `null` — the first page — rather than an error, because the only
 * thing a stale cursor can mean is "start again".
 */
export const cursorOf = (key: string): { created: number; storePath: string } | null => {
  const at = key.indexOf("|");
  if (at <= 0) return null;
  const created = Number(key.slice(0, at));
  if (!Number.isFinite(created)) return null;
  return { created, storePath: key.slice(at + 1) };
};

/** The cursor for a page's last row. */
export const cursorFor = (row: { created: number; storePath: string }): string =>
  `${row.created}|${row.storePath}`;

const bucketOf = (row: Row): BucketRow => ({
  name: text(row, "name"),
  isPublic: integer(row, "is_public") !== 0,
  retentionDays: integer(row, "retention_days"),
  keyName: text(row, "key_name"),
  secretKey: text(row, "secret_key"),
  publicKey: text(row, "public_key"),
  upstreamKeys: list(row, "upstream_keys"),
  created: integer(row, "created"),
});

const tokenOf = (row: Row): TokenRow => ({
  id: text(row, "id"),
  hash: text(row, "hash"),
  bucketGlob: text(row, "bucket_glob"),
  scope: text(row, "scope") as Scope,
  expires: row["expires"] === null ? null : integer(row, "expires"),
  lastUsed: row["last_used"] === null ? null : integer(row, "last_used"),
  revoked: integer(row, "revoked") !== 0,
  created: integer(row, "created"),
});

const objectOf = (row: Row): ObjectRow => ({
  bucket: text(row, "bucket"),
  storePath: text(row, "store_path"),
  hash: text(row, "hash"),
  narHash: text(row, "nar_hash"),
  narSize: integer(row, "nar_size"),
  references: list(row, "refs"),
  deriver: maybeText(row, "deriver"),
  sigs: list(row, "sigs"),
  hits: integer(row, "hits"),
  created: integer(row, "created"),
  lastAccessed: integer(row, "last_accessed"),
});

const pinOf = (row: Row): PinRow => ({
  bucket: text(row, "bucket"),
  name: text(row, "name"),
  rootPaths: list(row, "root_paths"),
  created: integer(row, "created"),
});

const heldOf = (row: Row): HeldRow => ({
  bucket: text(row, "bucket"),
  storePath: text(row, "store_path"),
  missing: list(row, "missing"),
  created: integer(row, "created"),
});

/** Open (or create) the cache database. `":memory:"` is what the suite uses.
 *
 * **Modes matter here.** The database holds every bucket's ed25519 SECRET key
 * and every token hash, so it is a secret: the directory is 0700 and the file —
 * plus the `-wal` and `-shm` siblings SQLite creates beside it — is 0600.
 * `Database` creates with the process umask, which on a default machine is
 * world-readable, so the mode is set here rather than left to whoever started
 * the process.
 */
export function openCacheRepo(path: string): CacheRepo {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // `mkdirSync`'s mode is honoured only for directories it CREATES; an
    // existing state root keeps whatever it had.
    try {
      chmodSync(dirname(path), 0o700);
    } catch {
      // A state root somebody else owns is theirs to fix; the file modes below
      // still apply to what this process creates.
    }
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = OFF;");

  const current = Number(
    (db.query("PRAGMA user_version;").get() as Row | null)?.["user_version"] ?? 0,
  );
  if (current > CACHE_SCHEMA_VERSION) {
    throw new Error(
      `odu: ${path} was written by a newer odu (schema ${current}, this build ` +
        `reads ${CACHE_SCHEMA_VERSION}) — upgrade odu rather than reading it`,
    );
  }
  for (let version = current; version < CACHE_SCHEMA_VERSION; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version] as string);
      db.exec(`PRAGMA user_version = ${version + 1};`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // AFTER the migrations, not before: `-wal` and `-shm` are created by the
  // first write, so a chmod run immediately after `new Database` finds neither
  // of them and swallows the error — and the first run's WAL, which holds the
  // bucket's secret key, is world-readable until the next restart.
  if (path !== ":memory:") {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        chmodSync(file, 0o600);
      } catch {
        // `-shm` is absent outside WAL mode; the rest are here by now.
      }
    }
  }

  const all = <T>(sql: string, params: unknown[], map: (row: Row) => T): T[] =>
    (db.query(sql).all(...(params as never[])) as Row[]).map(map);

  return {
    putBucket(row) {
      db.run(
        `INSERT INTO bucket (name, is_public, retention_days, key_name, secret_key,
           public_key, upstream_keys, created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET is_public = excluded.is_public,
           retention_days = excluded.retention_days, key_name = excluded.key_name,
           secret_key = excluded.secret_key, public_key = excluded.public_key,
           upstream_keys = excluded.upstream_keys`,
        [
          row.name,
          row.isPublic ? 1 : 0,
          row.retentionDays,
          row.keyName,
          row.secretKey,
          row.publicKey,
          JSON.stringify(row.upstreamKeys),
          row.created,
        ],
      );
    },
    bucket: (name) => {
      const row = db.query("SELECT * FROM bucket WHERE name = ?").get(name) as Row | null;
      return row === null ? null : bucketOf(row);
    },
    buckets: () => all("SELECT * FROM bucket ORDER BY name", [], bucketOf),
    deleteBucket(name) {
      db.run("DELETE FROM bucket WHERE name = ?", [name]);
      db.run("DELETE FROM object WHERE bucket = ?", [name]);
      db.run("DELETE FROM pin WHERE bucket = ?", [name]);
      db.run("DELETE FROM held WHERE bucket = ?", [name]);
    },

    putToken(row) {
      db.run(
        `INSERT INTO token (id, hash, bucket_glob, scope, expires, last_used, revoked, created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.hash,
          row.bucketGlob,
          row.scope,
          row.expires,
          row.lastUsed,
          row.revoked ? 1 : 0,
          row.created,
        ],
      );
    },
    tokenByHash: (hash) => {
      const row = db.query("SELECT * FROM token WHERE hash = ?").get(hash) as Row | null;
      return row === null ? null : tokenOf(row);
    },
    tokens: () => all("SELECT * FROM token ORDER BY created DESC", [], tokenOf),
    setTokenRevoked(id, revoked) {
      const found = db.query("SELECT id FROM token WHERE id = ?").get(id) as Row | null;
      if (found === null) return false;
      db.run("UPDATE token SET revoked = ? WHERE id = ?", [revoked ? 1 : 0, id]);
      return true;
    },
    touchToken(id, at) {
      db.run("UPDATE token SET last_used = ? WHERE id = ?", [at, id]);
    },

    putObject(row) {
      db.run(
        `INSERT INTO object (bucket, store_path, hash, nar_hash, nar_size, refs,
           deriver, sigs, hits, created, last_accessed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bucket, store_path) DO UPDATE SET hash = excluded.hash,
           nar_hash = excluded.nar_hash, nar_size = excluded.nar_size,
           refs = excluded.refs, deriver = excluded.deriver,
           sigs = excluded.sigs`,
        [
          row.bucket,
          row.storePath,
          row.hash,
          row.narHash,
          row.narSize,
          JSON.stringify(row.references),
          row.deriver,
          JSON.stringify(row.sigs),
          row.hits,
          row.created,
          row.lastAccessed,
        ],
      );
    },
    object: (bucket, storePath) => {
      const row = db
        .query("SELECT * FROM object WHERE bucket = ? AND store_path = ?")
        .get(bucket, storePath) as Row | null;
      return row === null ? null : objectOf(row);
    },
    objectByHash: (bucket, hash) => {
      const row = db
        .query("SELECT * FROM object WHERE bucket = ? AND hash = ?")
        .get(bucket, hash) as Row | null;
      return row === null ? null : objectOf(row);
    },
    objectByNarHash: (bucket, narHash) => {
      const row = db
        .query("SELECT * FROM object WHERE bucket = ? AND nar_hash = ?")
        .get(bucket, narHash) as Row | null;
      return row === null ? null : objectOf(row);
    },
    objects: (bucket) =>
      bucket === undefined
        ? all("SELECT * FROM object", [], objectOf)
        : all("SELECT * FROM object WHERE bucket = ?", [bucket], objectOf),
    touchObject(bucket, storePath, at) {
      db.run(
        "UPDATE object SET last_accessed = ?, hits = hits + 1 WHERE bucket = ? AND store_path = ?",
        [at, bucket, storePath],
      );
    },
    deleteObject(bucket, storePath) {
      db.run("DELETE FROM object WHERE bucket = ? AND store_path = ?", [bucket, storePath]);
    },

    putPin(row) {
      db.run(
        `INSERT INTO pin (bucket, name, root_paths, created) VALUES (?, ?, ?, ?)
         ON CONFLICT(bucket, name) DO UPDATE SET root_paths = excluded.root_paths,
           created = excluded.created`,
        [row.bucket, row.name, JSON.stringify(row.rootPaths), row.created],
      );
    },
    pins: (bucket) =>
      bucket === undefined
        ? all("SELECT * FROM pin ORDER BY created", [], pinOf)
        : all("SELECT * FROM pin WHERE bucket = ? ORDER BY created", [bucket], pinOf),
    bucketStats() {
      const rows = db
        .query(
          "SELECT bucket, COUNT(*) AS objects, COALESCE(SUM(nar_size), 0) AS bytes, " +
            "COALESCE(SUM(hits), 0) AS hits, MAX(created) AS pushed " +
            "FROM object GROUP BY bucket",
        )
        .all() as Row[];
      return new Map(
        rows.map((row) => {
          const pushed = row["pushed"];
          return [
            text(row, "bucket"),
            {
              objects: integer(row, "objects"),
              bytes: integer(row, "bytes"),
              hits: integer(row, "hits"),
              lastPush: pushed === null || pushed === undefined ? null : Number(pushed),
            },
          ];
        }),
      );
    },

    objectsPage(bucket, page) {
      const after = page.after === null ? null : cursorOf(page.after);
      const where = ["bucket = ?"];
      const params: unknown[] = [bucket];
      if (page.filter !== null && page.filter !== "") {
        // `instr` rather than `LIKE`: the filter is a SUBSTRING a person typed,
        // and `%` or `_` in it would be a wildcard nobody meant.
        where.push("instr(store_path, ?) > 0");
        params.push(page.filter);
      }
      if (after !== null) {
        where.push("(created < ? OR (created = ? AND store_path < ?))");
        params.push(after.created, after.created, after.storePath);
      }
      params.push(page.limit + 1);
      const rows = db
        .query(
          `SELECT * FROM object WHERE ${where.join(" AND ")} ` +
            "ORDER BY created DESC, store_path DESC LIMIT ?",
        )
        .all(...(params as never[])) as Row[];
      const more = rows.length > page.limit;
      return { rows: (more ? rows.slice(0, page.limit) : rows).map(objectOf), more };
    },
    objectTotals() {
      const row = db
        .query(
          "SELECT COUNT(*) AS objects, COALESCE(SUM(nar_size), 0) AS bytes, " +
            "COALESCE(SUM(hits), 0) AS hits, MAX(last_accessed) AS last " +
            "FROM object",
        )
        .get() as Row;
      const last = row["last"];
      return {
        objects: integer(row, "objects"),
        bytes: integer(row, "bytes"),
        hits: integer(row, "hits"),
        lastAccessed: last === null || last === undefined ? null : Number(last),
      };
    },

    deletePin(bucket, name) {
      const found = db
        .query("SELECT name FROM pin WHERE bucket = ? AND name = ?")
        .get(bucket, name) as Row | null;
      if (found === null) return false;
      db.run("DELETE FROM pin WHERE bucket = ? AND name = ?", [bucket, name]);
      return true;
    },

    putHeld(row) {
      // `created` is NOT overwritten: it is when the path first arrived, which
      // is what the board's "waiting since" means. A later drain with the same
      // or a shorter list of missing references refreshes the REASON only.
      db.run(
        `INSERT INTO held (bucket, store_path, missing, created) VALUES (?, ?, ?, ?)
         ON CONFLICT(bucket, store_path) DO UPDATE SET missing = excluded.missing`,
        [row.bucket, row.storePath, JSON.stringify(row.missing), row.created],
      );
    },
    held: (bucket) =>
      bucket === undefined
        ? all("SELECT * FROM held ORDER BY created", [], heldOf)
        : all("SELECT * FROM held WHERE bucket = ? ORDER BY created", [bucket], heldOf),
    deleteHeld(bucket, storePath) {
      db.run("DELETE FROM held WHERE bucket = ? AND store_path = ?", [bucket, storePath]);
    },

    close() {
      db.close();
    },
  };
}
