import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import type { Provenance } from "./paths";
import { type PathSort, storePathParts } from "./surface";

export interface BucketRow {
  name: string;
  isPublic: boolean;
  retentionDays: number;
  keyName: string;
  secretKey: string;
  publicKey: string;
  upstreamKeys: readonly string[];
  created: number;
  domain: string | null;
  store: string;
}

export interface MigrationRow {
  bucket: string;
  fromStore: string;
  toStore: string;
  state: "copying" | "flipping" | "deleting";
  copied: number;
  total: number;
  bytes: number;
  started: number;
}

export type Scope = "read" | "write" | "admin";

export interface TokenRow {
  id: string;
  hash: string;
  bucketGlob: string;
  scope: Scope;
  expires: number | null;
  label: string | null;
  lastUsed: number | null;
  revoked: boolean;
  created: number;
}

export interface ObjectRow {
  bucket: string;
  storePath: string;
  hash: string;
  narHash: string;
  narSize: number;
  references: readonly string[];
  deriver: string | null;
  ca: string | null;
  caProof: "unknown" | "content-addressed" | "not-content-addressed";
  compression: string;
  fileHash: string | null;
  fileSize: number | null;
  sigs: readonly string[];
  hits: number;
  created: number;
  lastWanted: number;
  run: string | null;
  commit: string | null;
}

export interface BucketTotals {
  objects: number;
  bytes: number;
  hits: number;
  lastPush: number | null;
}

export interface BucketGauge {
  readonly bucket: string;
  readonly objects: number;
  readonly bytes: number;
  readonly hits: number;
  readonly pins: number;
}

export type PinAuthor = "write" | "admin";

export interface PinRow {
  bucket: string;
  name: string;
  rootPaths: readonly string[];
  created: number;
  createdBy: PinAuthor;
}

export type { PathSort };

export interface PathPage {
  limit: number;
  after: string | null;
  filter: string | null;
  sort: PathSort;
  descending: boolean;
}

export interface ObjectGroupRow {
  name: string;
  versions: number;
  bytes: number;
  hits: number;
  pushed: number;
  wanted: number;
  storePath: string;
  run: string | null;
  commit: string | null;
}

export interface CacheRepo {
  putBucket(row: BucketRow): void;
  bucket(name: string): BucketRow | null;
  bucketByDomain(domain: string): BucketRow | null;
  buckets(): BucketRow[];
  deleteBucket(name: string): void;
  migration(bucket: string): MigrationRow | null;
  migrations(): MigrationRow[];
  putMigration(row: MigrationRow): void;
  deleteMigration(bucket: string): void;

  putToken(row: TokenRow): void;
  tokenByHash(hash: string): TokenRow | null;
  tokens(): TokenRow[];
  setTokenRevoked(id: string, revoked: boolean): boolean;
  touchToken(id: string, at: number): void;

  putObject(row: ObjectRow): void;
  object(bucket: string, storePath: string): ObjectRow | null;
  objectByHash(bucket: string, hash: string): ObjectRow | null;
  objectByNarHash(bucket: string, narHash: string): ObjectRow | null;
  objectByNarHashCompression(
    bucket: string,
    narHash: string,
    compression: string,
  ): ObjectRow | null;
  objectsByNarHash(bucket: string, narHash: string): ObjectRow[];
  objects(bucket?: string): ObjectRow[];
  countRead(bucket: string, storePath: string): void;
  want(
    bucket: string,
    storePaths: readonly string[],
    at: number,
    provenance: Provenance,
  ): void;
  deleteObject(bucket: string, storePath: string): void;

  putPin(row: PinRow): void;
  pins(bucket?: string): PinRow[];
  pinCounts(): Map<string, number>;
  deletePin(bucket: string, name: string): boolean;
  revision(bucket: string): number;

  bucketStats(): Map<string, BucketTotals>;

  objectsPage(bucket: string, page: PathPage & { name?: string | null }): {
    rows: ObjectRow[];
    next: string | null;
  };

  objectGroupsPage(
    bucket: string,
    page: PathPage,
  ): { rows: ObjectGroupRow[]; next: string | null };
  objectTotals(): {
    objects: number;
    bytes: number;
    hits: number;
    lastWanted: number | null;
  };

  close(): void;
}

export const MIGRATIONS: readonly string[] = [
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
  `
  CREATE TABLE held (
    bucket     TEXT NOT NULL,
    store_path TEXT NOT NULL,
    missing    TEXT NOT NULL,
    created    INTEGER NOT NULL,
    PRIMARY KEY (bucket, store_path)
  );
  `,
  `
  ALTER TABLE held ADD COLUMN fetching INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE bucket ADD COLUMN domain TEXT;
  CREATE UNIQUE INDEX bucket_domain ON bucket (domain) WHERE domain IS NOT NULL;
  `,
  `
  ALTER TABLE held ADD COLUMN fetched TEXT NOT NULL DEFAULT '[]';
  `,
  `
  ALTER TABLE held ADD COLUMN failure TEXT;
  `,
  `
  ALTER TABLE object ADD COLUMN ca TEXT;
  `,
  `
  ALTER TABLE object ADD COLUMN file_hash TEXT;
  ALTER TABLE object ADD COLUMN file_size INTEGER;
  `,
  `
  DROP TABLE held;
  `,
  `
  ALTER TABLE object ADD COLUMN compression TEXT NOT NULL DEFAULT 'zstd';
  `,
  `
  ALTER TABLE object ADD COLUMN ca_proof TEXT NOT NULL DEFAULT 'unknown';
  UPDATE object SET ca_proof = 'content-addressed' WHERE ca IS NOT NULL;
  `,
  `
  ALTER TABLE bucket ADD COLUMN store TEXT NOT NULL DEFAULT 'local';
  `,
  `
  ALTER TABLE object RENAME COLUMN last_accessed TO last_wanted;
  DROP INDEX IF EXISTS object_accessed;
  CREATE INDEX object_wanted ON object (bucket, last_wanted);
  `,
  `
  ALTER TABLE pin ADD COLUMN created_by TEXT NOT NULL DEFAULT 'admin';
  `,
  `
  CREATE TABLE bucket_migration (
    bucket      TEXT PRIMARY KEY,
    to_store    TEXT NOT NULL,
    from_store  TEXT NOT NULL,
    state       TEXT NOT NULL,
    copied      INTEGER NOT NULL DEFAULT 0,
    total       INTEGER NOT NULL DEFAULT 0,
    bytes       INTEGER NOT NULL DEFAULT 0,
    started     INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE object ADD COLUMN name TEXT NOT NULL DEFAULT '';
  UPDATE object SET name = substr(store_path, instr(store_path, '-') + 1);
  CREATE INDEX object_name ON object (bucket, name, created);
  `,
  `
  ALTER TABLE token ADD COLUMN label TEXT;
  `,
  `
  ALTER TABLE object ADD COLUMN run TEXT;
  ALTER TABLE object ADD COLUMN commit_sha TEXT;
  `,
  `
  UPDATE object SET ca_proof = 'unknown'
  WHERE ca_proof = 'not-content-addressed'
    AND EXISTS (SELECT 1 FROM json_each(object.refs) WHERE json_each.value = object.store_path);
  `,
];

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

const cursorOf = (
  key: string,
  sort: PathSort,
): { value: string; key: string } | null => {
  const order = key.indexOf("|");
  if (order <= 0 || key.slice(0, order) !== sort) return null;
  const rest = key.slice(order + 1);
  const at = rest.indexOf("|");
  if (at <= 0) return null;
  return { value: rest.slice(0, at), key: rest.slice(at + 1) };
};

const cursorFor = (
  sort: PathSort,
  last: Record<PathSort, string | number>,
  key: string,
): string => `${sort}|${last[sort]}|${key}`;

const narrowing = (filter: string | null): string | null =>
  filter === null || filter === "" ? null : filter;

const PATH_ORDER: Record<
  PathSort,
  { readonly row: string; readonly group: string; readonly numeric: boolean }
> = {
  name: { row: "name COLLATE NOCASE", group: "name COLLATE NOCASE", numeric: false },
  size: { row: "nar_size", group: "bytes", numeric: true },
  pushed: { row: "created", group: "pushed", numeric: true },
  reads: { row: "hits", group: "hits", numeric: true },
};

const bucketOf = (row: Row): BucketRow => ({
  name: text(row, "name"),
  isPublic: integer(row, "is_public") !== 0,
  retentionDays: integer(row, "retention_days"),
  keyName: text(row, "key_name"),
  secretKey: text(row, "secret_key"),
  publicKey: text(row, "public_key"),
  upstreamKeys: list(row, "upstream_keys"),
  created: integer(row, "created"),
  domain: maybeText(row, "domain"),
  store: text(row, "store"),
});

const migrationOf = (row: Row): MigrationRow => ({
  bucket: text(row, "bucket"),
  fromStore: text(row, "from_store"),
  toStore: text(row, "to_store"),
  state: text(row, "state") as MigrationRow["state"],
  copied: integer(row, "copied"),
  total: integer(row, "total"),
  bytes: integer(row, "bytes"),
  started: integer(row, "started"),
});

const tokenOf = (row: Row): TokenRow => ({
  id: text(row, "id"),
  hash: text(row, "hash"),
  bucketGlob: text(row, "bucket_glob"),
  scope: text(row, "scope") as Scope,
  expires: row["expires"] === null ? null : integer(row, "expires"),
  label: maybeText(row, "label"),
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
  ca: maybeText(row, "ca"),
  caProof: text(row, "ca_proof") as ObjectRow["caProof"],
  compression: text(row, "compression"),
  fileHash: maybeText(row, "file_hash"),
  fileSize: row["file_size"] === null || row["file_size"] === undefined
    ? null
    : integer(row, "file_size"),
  sigs: list(row, "sigs"),
  hits: integer(row, "hits"),
  created: integer(row, "created"),
  lastWanted: integer(row, "last_wanted"),
  run: maybeText(row, "run"),
  // `commit_sha`, because `COMMIT` is SQL's own word (migration 18).
  commit: maybeText(row, "commit_sha"),
});

const pinOf = (row: Row): PinRow => ({
  bucket: text(row, "bucket"),
  name: text(row, "name"),
  rootPaths: list(row, "root_paths"),
  created: integer(row, "created"),
  createdBy: text(row, "created_by") as PinRow["createdBy"],
});

/** `Database` creates with the process umask, which on a default machine is
 *  world-readable, so the mode is set here rather than left to whoever started
 *  the process. */
export function openCacheRepo(path: string): CacheRepo {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // `mkdirSync`'s mode is honoured only for directories it CREATES; an
    // existing state root keeps whatever it had.
    try {
      chmodSync(dirname(path), 0o700);
    } catch {
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

  const revisions = new Map<string, number>();
  const bump = (bucket: string): void => {
    revisions.set(bucket, (revisions.get(bucket) ?? 0) + 1);
  };

  return {
    putBucket(row) {
      bump(row.name);
      db.run(
        `INSERT INTO bucket (name, is_public, retention_days, key_name, secret_key,
           public_key, upstream_keys, created, domain, store)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET is_public = excluded.is_public,
           retention_days = excluded.retention_days, key_name = excluded.key_name,
           secret_key = excluded.secret_key, public_key = excluded.public_key,
           upstream_keys = excluded.upstream_keys, domain = excluded.domain,
           store = excluded.store`,
        [
          row.name,
          row.isPublic ? 1 : 0,
          row.retentionDays,
          row.keyName,
          row.secretKey,
          row.publicKey,
          JSON.stringify(row.upstreamKeys),
          row.created,
          row.domain,
          row.store,
        ],
      );
    },
    bucket: (name) => {
      const row = db.query("SELECT * FROM bucket WHERE name = ?").get(name) as Row | null;
      return row === null ? null : bucketOf(row);
    },
    bucketByDomain: (domain) => {
      const row = db.query("SELECT * FROM bucket WHERE domain = ?").get(domain) as Row | null;
      return row === null ? null : bucketOf(row);
    },
    buckets: () => all("SELECT * FROM bucket ORDER BY name", [], bucketOf),
    deleteBucket(name) {
      bump(name);
      db.run("DELETE FROM bucket WHERE name = ?", [name]);
      db.run("DELETE FROM object WHERE bucket = ?", [name]);
      db.run("DELETE FROM pin WHERE bucket = ?", [name]);
      db.run("DELETE FROM bucket_migration WHERE bucket = ?", [name]);
      db.run("DELETE FROM token WHERE bucket_glob = ?", [name]);
    },

    migration: (bucket) => {
      const row = db.query("SELECT * FROM bucket_migration WHERE bucket = ?").get(bucket) as Row | null;
      return row === null ? null : migrationOf(row);
    },
    migrations: () => all("SELECT * FROM bucket_migration ORDER BY bucket", [], migrationOf),
    putMigration(row) {
      db.run(
        `INSERT INTO bucket_migration (bucket, to_store, from_store, state, copied, total, bytes, started)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bucket) DO UPDATE SET to_store = excluded.to_store,
           from_store = excluded.from_store, state = excluded.state,
           copied = excluded.copied, total = excluded.total, bytes = excluded.bytes`,
        [row.bucket, row.toStore, row.fromStore, row.state, row.copied, row.total, row.bytes, row.started],
      );
    },
    deleteMigration(bucket) {
      db.run("DELETE FROM bucket_migration WHERE bucket = ?", [bucket]);
    },

    putToken(row) {
      db.run(
        `INSERT INTO token (id, hash, bucket_glob, scope, expires, label, last_used, revoked, created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.hash,
          row.bucketGlob,
          row.scope,
          row.expires,
          row.label,
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
      bump(row.bucket);
      db.run(
        `INSERT INTO object (bucket, store_path, name, hash, nar_hash, nar_size, refs,
           deriver, ca, ca_proof, compression, file_hash, file_size, sigs, hits, created,
           last_wanted, run, commit_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bucket, store_path) DO UPDATE SET hash = excluded.hash,
           nar_hash = excluded.nar_hash, nar_size = excluded.nar_size,
           refs = excluded.refs, deriver = excluded.deriver,
           ca = excluded.ca, ca_proof = excluded.ca_proof,
           compression = excluded.compression,
           file_hash = excluded.file_hash,
           file_size = excluded.file_size, sigs = excluded.sigs,
           -- WHAT BUILT IT SURVIVES A RE-PUSH THAT SAYS NOTHING. A developer
           -- running a bare "odu cache push" over a path a run already stored
           -- knows no run and no commit, and overwriting with null would
           -- throw away the only record of where the bytes came from. The
           -- two coalesce INDEPENDENTLY: the GitHub action states the commit
           -- and never a run, so one stated field must not carry the other's
           -- absence into the row.
           run = COALESCE(excluded.run, run),
           commit_sha = COALESCE(excluded.commit_sha, commit_sha)`,
        [
          row.bucket,
          row.storePath,
          storePathParts(row.storePath).name,
          row.hash,
          row.narHash,
          row.narSize,
          JSON.stringify(row.references),
          row.deriver,
          row.ca,
          row.caProof,
          row.compression,
          row.fileHash,
          row.fileSize,
          JSON.stringify(row.sigs),
          row.hits,
          row.created,
          row.lastWanted,
          row.run,
          row.commit,
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
    objectByNarHashCompression: (bucket, narHash, compression) => {
      const row = db
        .query("SELECT * FROM object WHERE bucket = ? AND nar_hash = ? AND compression = ?")
        .get(bucket, narHash, compression) as Row | null;
      return row === null ? null : objectOf(row);
    },
    objectsByNarHash: (bucket, narHash) =>
      all("SELECT * FROM object WHERE bucket = ? AND nar_hash = ?", [bucket, narHash], objectOf),
    objects: (bucket) =>
      bucket === undefined
        ? all("SELECT * FROM object", [], objectOf)
        : all("SELECT * FROM object WHERE bucket = ?", [bucket], objectOf),
    countRead(bucket, storePath) {
      db.run("UPDATE object SET hits = hits + 1 WHERE bucket = ? AND store_path = ?", [
        bucket,
        storePath,
      ]);
    },
    want(bucket, storePaths, at, provenance) {
      if (storePaths.length === 0) return;
      bump(bucket);
      const holes = storePaths.map(() => "?").join(", ");
      db.run(
        `UPDATE object SET last_wanted = ?, run = COALESCE(run, ?), ` +
          `commit_sha = COALESCE(commit_sha, ?) ` +
          `WHERE bucket = ? AND store_path IN (${holes})`,
        [at, provenance.run, provenance.commit, bucket, ...storePaths],
      );
    },
    deleteObject(bucket, storePath) {
      bump(bucket);
      db.run("DELETE FROM object WHERE bucket = ? AND store_path = ?", [bucket, storePath]);
    },

    putPin(row) {
      bump(row.bucket);
      db.run(
        `INSERT INTO pin (bucket, name, root_paths, created, created_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(bucket, name) DO UPDATE SET root_paths = excluded.root_paths,
           created = excluded.created, created_by = excluded.created_by`,
        [row.bucket, row.name, JSON.stringify(row.rootPaths), row.created, row.createdBy],
      );
    },
    revision: (bucket) => revisions.get(bucket) ?? 0,
    pins: (bucket) =>
      bucket === undefined
        ? all("SELECT * FROM pin ORDER BY created", [], pinOf)
        : all("SELECT * FROM pin WHERE bucket = ? ORDER BY created", [bucket], pinOf),
    pinCounts() {
      const rows = db
        .query("SELECT bucket, COUNT(*) AS pins FROM pin GROUP BY bucket")
        .all() as Row[];
      return new Map(rows.map((row) => [text(row, "bucket"), integer(row, "pins")]));
    },
    bucketStats() {
      const rows = db
        .query(
          "SELECT bucket, COUNT(*) AS objects, COALESCE(SUM(COALESCE(file_size, nar_size)), 0) AS bytes, " +
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
      const order = PATH_ORDER[page.sort];
      const where = ["bucket = ?"];
      const params: unknown[] = [bucket];
      const filter = narrowing(page.filter);
      if (filter !== null) {
        // `instr` rather than `LIKE`: the filter is a SUBSTRING a person typed,
        // and `%` or `_` in it would be a wildcard nobody meant.
        where.push("instr(store_path, ?) > 0");
        params.push(filter);
      }
      if (page.name !== undefined && page.name !== null) {
        where.push("name = ?");
        params.push(page.name);
      }
      const after = page.after === null ? null : cursorOf(page.after, page.sort);
      if (after !== null) {
        const compare = page.descending ? "<" : ">";
        where.push(
          `(${order.row} ${compare} ? OR (${order.row} = ? AND store_path ${compare} ?))`,
        );
        const value = order.numeric ? Number(after.value) : after.value;
        params.push(value, value, after.key);
      }
      params.push(page.limit + 1);
      const way = page.descending ? "DESC" : "ASC";
      const found = db
        .query(
          `SELECT * FROM object WHERE ${where.join(" AND ")} ` +
            `ORDER BY ${order.row} ${way}, store_path ${way} LIMIT ?`,
        )
        .all(...(params as never[])) as Row[];
      const more = found.length > page.limit;
      const rows = more ? found.slice(0, page.limit) : found;
      const last = rows.at(-1);
      return {
        rows: rows.map(objectOf),
        next:
          more && last !== undefined
            ? cursorFor(
                page.sort,
                {
                  name: text(last, "name"),
                  size: integer(last, "nar_size"),
                  pushed: integer(last, "created"),
                  reads: integer(last, "hits"),
                },
                text(last, "store_path"),
              )
            : null,
      };
    },

    objectGroupsPage(bucket, page) {
      const order = PATH_ORDER[page.sort];
      const where = ["bucket = ?"];
      const params: unknown[] = [bucket];
      const filter = narrowing(page.filter);
      if (filter !== null) {
        where.push("instr(store_path, ?) > 0");
        params.push(filter);
      }
      const having: string[] = [];
      const after = page.after === null ? null : cursorOf(page.after, page.sort);
      if (after !== null) {
        const compare = page.descending ? "<" : ">";
        having.push(
          `(${order.group} ${compare} ? OR (${order.group} = ? AND name ${compare} ?))`,
        );
        const value = order.numeric ? Number(after.value) : after.value;
        params.push(value, value, after.key);
      }
      params.push(page.limit + 1);
      const way = page.descending ? "DESC" : "ASC";
      // A bare column gets the max row's value only when the select holds
      // exactly ONE min/max, and this one holds two — so the newest version
      // is named by a subquery that reads the same span of `object_name` the
      // grouping does, and carries the FILTER so a filtered group answers a
      // path the filter matched rather than one it hid.
      //
      // THREE SUBQUERIES, NOT ONE, because a SQLite scalar subquery yields a
      // single COLUMN: the path, the run and the commit cannot come out of
      // one of them.
      //
      // Each subquery carries a `?` when there is a filter, and those
      // `?`s are read before the WHERE's; a column added to the list below
      // without its binding would not be an error SQLite reports — every
      // parameter after the select list would simply shift, and the page
      // would be wrong rather than refused.
      const perVersion = ["store_path", "run", "commit_sha"];
      const newest = (column: string): string =>
        `(SELECT inner.${column} FROM object AS inner ` +
        "WHERE inner.bucket = object.bucket AND inner.name = object.name " +
        (filter === null ? "" : "AND instr(inner.store_path, ?) > 0 ") +
        `ORDER BY inner.created DESC, inner.store_path DESC LIMIT 1) AS ${column}`;
      const found = db
        .query(
          "SELECT name, COUNT(*) AS versions, " +
            "COALESCE(SUM(nar_size), 0) AS bytes, COALESCE(SUM(hits), 0) AS hits, " +
            "MAX(created) AS pushed, MAX(last_wanted) AS wanted, " +
            `${perVersion.map(newest).join(", ")} ` +
            `FROM object WHERE ${where.join(" AND ")} GROUP BY name ` +
            (having.length === 0 ? "" : `HAVING ${having.join(" AND ")} `) +
            `ORDER BY ${order.group} ${way}, name ${way} LIMIT ?`,
        )
        .all(
          ...((filter === null
            ? params
            : [...perVersion.map(() => filter), ...params]) as never[]),
        ) as Row[];
      const more = found.length > page.limit;
      const rows = (more ? found.slice(0, page.limit) : found).map((row) => ({
        name: text(row, "name"),
        versions: integer(row, "versions"),
        bytes: integer(row, "bytes"),
        hits: integer(row, "hits"),
        pushed: integer(row, "pushed"),
        wanted: integer(row, "wanted"),
        storePath: text(row, "store_path"),
        run: maybeText(row, "run"),
        commit: maybeText(row, "commit_sha"),
      }));
      const last = rows.at(-1);
      return {
        rows,
        next:
          more && last !== undefined
            ? cursorFor(
                page.sort,
                { name: last.name, size: last.bytes, pushed: last.pushed, reads: last.hits },
                last.name,
              )
            : null,
      };
    },
    objectTotals() {
      const row = db
        .query(
          "SELECT COUNT(*) AS objects, COALESCE(SUM(COALESCE(file_size, nar_size)), 0) AS bytes, " +
            "COALESCE(SUM(hits), 0) AS hits, MAX(last_wanted) AS last " +
            "FROM object",
        )
        .get() as Row;
      const last = row["last"];
      return {
        objects: integer(row, "objects"),
        bytes: integer(row, "bytes"),
        hits: integer(row, "hits"),
        lastWanted: last === null || last === undefined ? null : Number(last),
      };
    },

    deletePin(bucket, name) {
      const found = db
        .query("SELECT name FROM pin WHERE bucket = ? AND name = ?")
        .get(bucket, name) as Row | null;
      if (found === null) return false;
      bump(bucket);
      db.run("DELETE FROM pin WHERE bucket = ? AND name = ?", [bucket, name]);
      return true;
    },

    close() {
      db.close();
    },
  };
}
