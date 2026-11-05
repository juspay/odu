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
import { type PathSort, storePathParts } from "./surface";

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
  /** THE NAME A BUCKET IS SERVED AT, when it has one (`cache.kolu.dev`). The
   *  row answers by `Host` as well as by `/cache/<name>`, and the advertised
   *  substituter URL becomes this name. `null` means the path form. */
  domain: string | null;
  /** THE STORE ITS OBJECTS LIVE IN, by declared name: `local` (the disk under
   *  the state directory, always there) or a store the operator declared. A
   *  name, never a credential: the store's facts are config, not data. */
  store: string;
}

/**
 * A BUCKET'S MOVE FROM ONE STORE TO ANOTHER, as it stands.
 *
 * It is persisted because it is long and resumable: the objects are copied
 * two at a time and the bucket keeps serving from `fromStore` throughout, so
 * a daemon restarted in the middle picks the move up where it stopped rather
 * than leaving half a bucket in each store with nobody tracking it.
 *
 * `state` is the only thing that says which store `bucket.store` names:
 * `copying` and `flipping` mean the OLD one, `deleting` means the new one is
 * already live and the old objects are being let go.
 */
export interface MigrationRow {
  bucket: string;
  fromStore: string;
  toStore: string;
  state: "copying" | "flipping" | "deleting";
  /** Objects copied so far, and how many there are in all. */
  copied: number;
  total: number;
  /** Bytes copied so far. */
  bytes: number;
  started: number;
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
  /** Nix's `CA:` line, verbatim; `null` for an ordinary input-addressed path. */
  ca: string | null;
  /** THE PROOF'S VERDICT, persisted so a row is examined once. `unknown` for
   *  a row whose shape needs its bytes (a self-reference) and has not been
   *  read yet; `content-addressed` when the path check passed; `not-content-
   *  addressed` when the check failed and no CA is served. */
  caProof: "unknown" | "content-addressed" | "not-content-addressed";
  /** What the KEPT bytes are compressed with — `zstd`, `xz`, `bzip2` or
   *  `none`. The narinfo says it and the object's extension encodes it. */
  compression: string;
  /** `sha256:<base32>` of the kept compressed NAR file, and its byte size.
   *  `null` until the file exists (a row from before files were kept, or an
   *  object whose boot backfill has not finished); the FIFO fallback serves it
   *  meanwhile without claiming a `FileHash:`. */
  fileHash: string | null;
  fileSize: number | null;
  sigs: readonly string[];
  /** narinfo reads. What `odu surface cache stats_read` reports — a counter,
   *  never GC's clock. */
  hits: number;
  created: number;
  /**
   * WHEN SOMEBODY LAST WANTED THIS PATH — GC's clock, and the only one.
   *
   * Renewed by the `missing` query (whether the path was missing or already
   * here: a pusher asking about it is a pusher that wants it) and by a stored
   * push. NOT by a read: reads are leaving odu (PLAN 2.8), so a cache that
   * expired by read time would start evicting live paths the moment its bytes
   * are served from a CDN. A fact that will stop arriving cannot be the fact
   * retention rests on.
   */
  lastWanted: number;
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

/** The same totals for ONE NAMED bucket, with its pins — what `/metrics` reads
 *  per scrape. It lives here, beside the queries that answer it, so the storage
 *  layer does not have to import the metrics module to describe its own rows.
 *  A bucket with nothing in it still has one: a cache that stopped reporting a
 *  bucket and a bucket that went to zero look the same on a graph, and only one
 *  of them is news. */
export interface BucketGauge {
  readonly bucket: string;
  /** Rows in `object` — the paths this bucket serves. */
  readonly objects: number;
  /** Their bytes, as stored. */
  readonly bytes: number;
  /** Reads counted against those rows. Falls when a collection deletes rows,
   *  which is why `/metrics` publishes it as a gauge. */
  readonly hits: number;
  /** Pins holding closures on this bucket. */
  readonly pins: number;
}

/**
 * WHAT AUTHORITY MADE A PIN — and therefore what may take it back.
 *
 * Two words, not a token id, and the choice is about what survives: a CI
 * secret is rotated and revoked on a schedule, so a pin keyed to the token
 * that made it would stop being re-pointable by the very job whose next push
 * is supposed to re-point it. The question the rule actually asks is "may
 * this caller take back this promise", and there are two answers to it.
 *
 * Write tokens of one bucket are PEERS here: any of them may re-point a pin
 * another made, which is the same authority they already share — each can
 * push any path into the bucket.
 */
export type PinAuthor = "write" | "admin";

/** A named closure kept out of garbage collection. */
export interface PinRow {
  bucket: string;
  name: string;
  /** The closure resolved at pin time. GC also walks the bucket's own
   *  references from these roots, so a path added to the closure later is
   *  still protected. */
  rootPaths: readonly string[];
  created: number;
  /** Who made it. An admin's pin is an admin's to re-point or remove; a write
   *  token may only re-point one a write token made. */
  createdBy: PinAuthor;
}

/** What a page of paths may be ordered by. The vocabulary is the CONTRACT's
 *  ({@link PathSort} in `./surface`, which the ledger watches); what each
 *  word means in SQL is this module's, in `PATH_ORDER`. */
export type { PathSort };

/** What every page read takes: how many, from where, narrowed by what, and
 *  in which order. */
export interface PathPage {
  limit: number;
  after: string | null;
  filter: string | null;
  sort: PathSort;
  descending: boolean;
}

/** ONE PACKAGE: every version of one store-path name in a bucket, summed. */
export interface ObjectGroupRow {
  name: string;
  versions: number;
  bytes: number;
  hits: number;
  /** The newest version's push, the latest want across all of them, and the
   *  newest version's own path. */
  pushed: number;
  wanted: number;
  storePath: string;
}

export interface CacheRepo {
  putBucket(row: BucketRow): void;
  bucket(name: string): BucketRow | null;
  /** The bucket a `Host` names, if one has claimed it. The caller normalizes
   *  the header (lowercase, no port); the domain is stored that way. */
  bucketByDomain(domain: string): BucketRow | null;
  buckets(): BucketRow[];
  /**
   * EVERYTHING THAT IS THIS BUCKET'S: the row, its objects, its pins, a
   * migration record, and the tokens minted FOR IT — a token whose glob is
   * exactly this name can address nothing else, so leaving it would be a
   * credential with no bucket. A WIDER glob (`team-*`) is left alone: it
   * names the buckets beside this one too, and deleting one of them is not
   * a decision about them.
   */
  deleteBucket(name: string): void;
  /** THE MOVE RUNNING ON A BUCKET, or null. One per bucket: a second
   *  `bucket.migrate` while one is running is refused, not queued. */
  migration(bucket: string): MigrationRow | null;
  /** Every move in progress — what a boot resumes. */
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
  /** ONE READ, counted. The hit count moves; `last_wanted` does not — see
   *  {@link ObjectRow.lastWanted}. */
  countRead(bucket: string, storePath: string): void;
  /** SOMEBODY WANTS THESE PATHS: renew their retention clock. One statement
   *  for the batch, because the `missing` query asks about a whole closure and
   *  a row write per path would be a thousand of them per push. */
  want(bucket: string, storePaths: readonly string[], at: number): void;
  deleteObject(bucket: string, storePath: string): void;

  putPin(row: PinRow): void;
  pins(bucket?: string): PinRow[];
  /** How many pins each bucket holds, COUNTED BY SQL. `/metrics` asks this of
   *  every bucket at every scrape, and `pins(bucket).length` would deserialise
   *  every pin's root-path list to learn a number the database already knows. */
  pinCounts(): Map<string, number>;
  deletePin(bucket: string, name: string): boolean;

  /**
   * The uploads a bucket is holding for references. `put` refreshes the
   * REASON when a drain says something different, so a row's `since` stays
   * the moment the path first arrived.
   */

  /** Object count, nar bytes, reads and the newest push per bucket, COUNTED BY
   *  SQL. A cache with a hundred thousand objects must not answer "how big am
   *  I" by loading them — and a BOARD asks that question once per bucket per
   *  publish, which is the same argument one order of magnitude louder. */
  bucketStats(): Map<string, BucketTotals>;

  /**
   * ONE PAGE of a bucket's paths, in the order asked for — the keyset page
   * behind `cache.paths`.
   *
   * `next` is the cursor for the page AFTER this one, or `null` when this is
   * the last: a POSITION in the order just read rather than an offset, so a
   * push landing between two pages shifts nothing the reader is about to
   * read, which an `OFFSET` would. It is minted HERE, where the order is
   * known, and it names that order — replayed against another one it starts
   * again rather than answering an empty page.
   *
   * `name` narrows to one package — every version of one store-path name,
   * which is what opening a group on the board asks for.
   */
  objectsPage(bucket: string, page: PathPage & { name?: string | null }): {
    rows: ObjectRow[];
    next: string | null;
  };

  /**
   * THE SAME PAGE, AS PACKAGES — one row per store-path name, counted and
   * summed over the WHOLE bucket by SQL.
   *
   * A client cannot do this: it holds one page, so its totals would be the
   * page's and would change under the reader at "show more". The aggregate is
   * therefore the row's, and it pages by the same keyset rule — on the
   * aggregate being ordered by, with the name settling every tie.
   */
  objectGroupsPage(
    bucket: string,
    page: PathPage,
  ): { rows: ObjectGroupRow[]; next: string | null };
  /** The same, over every bucket, plus reads and the newest renewal. */
  objectTotals(): {
    objects: number;
    bytes: number;
    hits: number;
    lastWanted: number | null;
  };

  close(): void;
}

/**
 * Schema history, one entry per version, applied in order. `user_version` is
 * the index of the last applied entry, so a fresh file runs all of them and an
 * existing one runs the tail.
 */
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
  // Migration 2 — WHAT A BUCKET IS HOLDING FOR REFERENCES. Before this the
  // reason lived only in a drain's memory and died with the process, so a
  // person looking at a stalled push saw nothing until the next drain happened
  // to run.
  `
  CREATE TABLE held (
    bucket     TEXT NOT NULL,
    store_path TEXT NOT NULL,
    missing    TEXT NOT NULL,
    created    INTEGER NOT NULL,
    PRIMARY KEY (bucket, store_path)
  );
  `,
  // Migration 3 — THE FETCH A HOLD REPRESENTS. A missing reference is fetched
  // OFF the upload request; until it lands, the bucket publishes the progress
  // rather than a silent 202.
  `
  ALTER TABLE held ADD COLUMN fetching INTEGER NOT NULL DEFAULT 0;
  `,
  // Migration 4 — A NAME PER BUCKET. One domain, one bucket: the partial
  // unique index is the rule, not a check in a verb that another caller could
  // skip.
  `
  ALTER TABLE bucket ADD COLUMN domain TEXT;
  CREATE UNIQUE INDEX bucket_domain ON bucket (domain) WHERE domain IS NOT NULL;
  `,
  // Migration 5 — WHICH REFERENCES THE FETCH HAS ALREADY LANDED. A hold with a
  // count told a person how much was left, not which; the page shows both.
  // APPENDED, never inserted: migrations apply by POSITION against
  // `user_version`, so an entry added mid-array re-runs every migration after
  // it on an existing database.
  `
  ALTER TABLE held ADD COLUMN fetched TEXT NOT NULL DEFAULT '[]';
  `,
  // Migration 6 — A FAILED FETCH IS NOT "NEITHER HERE NOR UPSTREAM". The
  // last line `nix-store -r` said is stored so the hold names the real fault
  // (network, disk, lock), and a later retry clears it.
  `
  ALTER TABLE held ADD COLUMN failure TEXT;
  `,
  // Migration 7 — THE `CA:` LINE, as Nix sent it. A content-addressed rewrite
  // is importable by its own hash; without this the consumer demands a
  // signature instead.
  `
  ALTER TABLE object ADD COLUMN ca TEXT;
  `,
  // Migration 8 — THE COMPRESSED NAR IS KEPT. A push already uploads it, so
  // the file the cache proved is the file it serves: a sized object Cloudflare
  // will cache, and no re-dump per puller. Null means the file is not there
  // yet; the row is served by the FIFO fallback until the boot backfill (or a
  // re-push) produces it.
  `
  ALTER TABLE object ADD COLUMN file_hash TEXT;
  ALTER TABLE object ADD COLUMN file_size INTEGER;
  `,
  // Migration 9 — NO HOLDS. A cache that keeps what it was pushed no longer
  // waits for references: they are names in the narinfo, not paths a store must
  // hold first. The table is dropped rather than left as dead state.
  `
  DROP TABLE held;
  `,
  // Migration 10 — THE STORED COMPRESSION. An upload may be zstd, xz, bzip2
  // or none; the object is kept exactly as sent, so the row records what the
  // bytes are and the narinfo says it. Rows from before this are zstd (the
  // only thing odu ever served), hence the default.
  `
  ALTER TABLE object ADD COLUMN compression TEXT NOT NULL DEFAULT 'zstd';
  `,
  // Migration 11 — THE CA PROOF'S VERDICT, once per row. A self-referencing
  // row's proof needs its bytes; re-reading it every boot made an ordinary
  // input-addressed path a permanent startup cost. Rows that already carry a
  // CA were proved by the old flow.
  `
  ALTER TABLE object ADD COLUMN ca_proof TEXT NOT NULL DEFAULT 'unknown';
  UPDATE object SET ca_proof = 'content-addressed' WHERE ca IS NOT NULL;
  `,
  // Migration 12 — A STORE PER BUCKET. Every bucket that predates the choice
  // kept its objects on the local disk, so that is what it names.
  `
  ALTER TABLE bucket ADD COLUMN store TEXT NOT NULL DEFAULT 'local';
  `,
  // Migration 13 — RETENTION'S CLOCK IS "WANTED", NOT "READ". Reads are about
  // to leave odu (PLAN 2.8): once a CDN or a presigned URL serves the bytes,
  // `last_accessed` stops moving for exactly the paths that are busiest, and a
  // collector reading it would evict them. The column is RENAMED rather than
  // added beside: an existing row's last access is the best thing known about
  // when it was last wanted, and two columns would be two answers to one
  // question. The index follows the column.
  `
  ALTER TABLE object RENAME COLUMN last_accessed TO last_wanted;
  DROP INDEX IF EXISTS object_accessed;
  CREATE INDEX object_wanted ON object (bucket, last_wanted);
  `,
  // Migration 14 — WHO MADE A PIN. A write token may now pin (so CI can hold
  // its master closure), and re-pointing a pin releases whatever it held
  // before — which on an ADMIN's pin would be a write token undoing an
  // administrator's retention. Every pin that predates this was made with the
  // root token or an admin's role, so that is what they are.
  `
  ALTER TABLE pin ADD COLUMN created_by TEXT NOT NULL DEFAULT 'admin';
  `,
  // Migration 15 — A BUCKET MOVES BETWEEN STORES (PLAN 2.8). The move is
  // long: thousands of objects copied two at a time, and the bucket serves
  // from the OLD store until every one of them is there. That means the move
  // must survive a restart, so it is a row rather than a field in memory —
  // and a row per bucket, because a second move of the same bucket while one
  // is running is a refusal and not a queue.
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
  // Migration 16 — A PATH'S PACKAGE NAME, STORED. The board groups a bucket
  // by it (cache 4.5), and a `GROUP BY substr(store_path, …)` is a read-time
  // recomputation of a fact decided when the path was written — one no index
  // can answer, on a table that grows with every push. The backfill is the
  // same rule as `storePathParts`, said in SQL once, for rows written before
  // this. The index carries `created` so the newest version of a name is the
  // first row of its span rather than a sort.
  `
  ALTER TABLE object ADD COLUMN name TEXT NOT NULL DEFAULT '';
  UPDATE object SET name = substr(store_path, instr(store_path, '-') + 1);
  CREATE INDEX object_name ON object (bucket, name, created);
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
 * A PAGE CURSOR — `<the order>|<the ordered value>|<the key>`, minted from
 * the last row of the page just given: `pushed|<created>|<storePath>` for the
 * default order, `size|<bytes>|<name>` for packages by size.
 *
 * IT NAMES ITS OWN ORDER because it is only a position in one. Replayed
 * against a different `sort` the comparison would be a number read out of a
 * name — `NaN`, which SQLite binds as NULL, so every keyset test fails and
 * the answer is an empty page that claims the bucket ended. A cursor that
 * disagrees is treated as no cursor: the first page, which is the only thing
 * a stale one can mean.
 *
 * Opaque to a caller on purpose, and never leaves this module: both page
 * reads mint their own `next`, so no caller holds the pairing.
 */
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

/**
 * THE CURSOR FOR A PAGE'S LAST ROW — the mint {@link cursorOf} parses, and
 * the only one.
 *
 * The ordered values are named by the ORDER WORDS themselves, so the pairing
 * of a `sort` with the value a page is positioned by is decided once: both
 * page reads hand over the same record of four facts, and a fifth
 * {@link PathSort} is a type error at each of them rather than a cursor that
 * quietly carries the wrong number.
 */
const cursorFor = (
  sort: PathSort,
  last: Record<PathSort, string | number>,
  key: string,
): string => `${sort}|${last[sort]}|${key}`;

/** THE SUBSTRING A PAGE IS NARROWED BY, or `null` for the whole bucket. An
 *  absent filter and an empty box are one question, and a read that spelled
 *  that out at each of the places it asks could answer them differently. */
const narrowing = (filter: string | null): string | null =>
  filter === null || filter === "" ? null : filter;

/**
 * WHAT EACH ORDER IS, IN SQL — the column a row is ordered by, the one a
 * GROUP is ordered by, and whether the cursor's value is a number.
 *
 * `size` is `nar_size` rather than the stored `file_size`, because the number
 * the board prints beside a path is its NAR's, and an order that disagreed
 * with the column it is drawn under is worse than no order at all.
 *
 * `name` compares case-insensitively: byte order puts every capitalised
 * package ahead of every lowercase one (`ImageMagick`, `R`, then `acl`),
 * which is not what a header saying A→Z means to a reader.
 */
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
});

const pinOf = (row: Row): PinRow => ({
  bucket: text(row, "bucket"),
  name: text(row, "name"),
  rootPaths: list(row, "root_paths"),
  created: integer(row, "created"),
  createdBy: text(row, "created_by") as PinRow["createdBy"],
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
        `INSERT INTO object (bucket, store_path, name, hash, nar_hash, nar_size, refs,
           deriver, ca, ca_proof, compression, file_hash, file_size, sigs, hits, created, last_wanted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bucket, store_path) DO UPDATE SET hash = excluded.hash,
           nar_hash = excluded.nar_hash, nar_size = excluded.nar_size,
           refs = excluded.refs, deriver = excluded.deriver,
           ca = excluded.ca, ca_proof = excluded.ca_proof,
           compression = excluded.compression,
           file_hash = excluded.file_hash,
           file_size = excluded.file_size, sigs = excluded.sigs`,
        [
          row.bucket,
          row.storePath,
          // THE PACKAGE NAME, WRITTEN ONCE, HERE. It is decided by the store
          // path and never changes, so re-deriving it inside every `GROUP BY`
          // was a read-time recomputation of a write-time fact — and an
          // expression no index could answer, on a table that grows with
          // every push.
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
    want(bucket, storePaths, at) {
      if (storePaths.length === 0) return;
      // ONE statement for the batch: a push asks about its whole closure, and
      // a thousand-path closure must not be a thousand writes.
      const holes = storePaths.map(() => "?").join(", ");
      db.run(
        `UPDATE object SET last_wanted = ? WHERE bucket = ? AND store_path IN (${holes})`,
        [at, bucket, ...storePaths],
      );
    },
    deleteObject(bucket, storePath) {
      db.run("DELETE FROM object WHERE bucket = ? AND store_path = ?", [bucket, storePath]);
    },

    putPin(row) {
      db.run(
        `INSERT INTO pin (bucket, name, root_paths, created, created_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(bucket, name) DO UPDATE SET root_paths = excluded.root_paths,
           created = excluded.created, created_by = excluded.created_by`,
        [row.bucket, row.name, JSON.stringify(row.rootPaths), row.created, row.createdBy],
      );
    },
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
        // THE KEYSET, in the order being read: the ordered column decides, and
        // the store path settles a tie so no row is read twice or skipped.
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
        // THE CURSOR IS MINTED WHERE THE ORDER IS KNOWN, so a caller never
        // holds the pairing of a position with the order it is a position in.
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
      // THE KEYSET IS ON THE AGGREGATE, so it is a HAVING: the count, the sums
      // and the two clocks exist only after the grouping, and a WHERE could
      // not see them.
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
      const found = db
        .query(
          "SELECT name, COUNT(*) AS versions, " +
            "COALESCE(SUM(nar_size), 0) AS bytes, COALESCE(SUM(hits), 0) AS hits, " +
            "MAX(created) AS pushed, MAX(last_wanted) AS wanted, " +
            // THE NEWEST VERSION'S OWN PATH, by a subquery rather than a bare
            // column: SQLite hands a bare column the max row's value only when
            // there is exactly ONE min/max in the select, and there are two.
            // It reads the same span of `object_name` the grouping does, and
            // it carries the FILTER, so a filtered group's hash is a path the
            // filter matched rather than one it hid.
            "(SELECT inner.store_path FROM object AS inner " +
            "WHERE inner.bucket = object.bucket AND inner.name = object.name " +
            (filter === null ? "" : "AND instr(inner.store_path, ?) > 0 ") +
            "ORDER BY inner.created DESC, inner.store_path DESC LIMIT 1) AS store_path " +
            `FROM object WHERE ${where.join(" AND ")} GROUP BY name ` +
            (having.length === 0 ? "" : `HAVING ${having.join(" AND ")} `) +
            `ORDER BY ${order.group} ${way}, name ${way} LIMIT ?`,
        )
        .all(...((filter === null ? params : [filter, ...params]) as never[])) as Row[];
      const more = found.length > page.limit;
      const rows = (more ? found.slice(0, page.limit) : found).map((row) => ({
        name: text(row, "name"),
        versions: integer(row, "versions"),
        bytes: integer(row, "bytes"),
        hits: integer(row, "hits"),
        pushed: integer(row, "pushed"),
        wanted: integer(row, "wanted"),
        storePath: text(row, "store_path"),
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
      db.run("DELETE FROM pin WHERE bucket = ? AND name = ?", [bucket, name]);
      return true;
    },

    close() {
      db.close();
    },
  };
}
