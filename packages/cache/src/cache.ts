/**
 * THE CACHE — the buckets, their keys, and the two faces over them.
 *
 * Two faces over one object, and they are deliberately in one module because
 * they must agree about one thing: what a bucket IS. The protocol face is what
 * a Nix client speaks (`./routes`); the admin face is what `odu cache` reaches
 * through the service. Between them sit the rows (`./db`), the tokens
 * (`./tokens`), the collector (`./gc`), the object stores (`@odu/objects`,
 * one per declared store, chosen per bucket) and the one-time migration.
 *
 * The WRITE PATH is not here: staging an upload, proving it and keeping the
 * object moves on the Nix protocol's clock rather than on the product's, and it
 * lives in `./staging`. This module hands it the write lock and `record`,
 * because a pin and a collection take the same lock, and a second lock there
 * would be a second answer to "who may change what is retained".
 *
 * **The root token is a field, not a file.** `rootToken` arrives from the
 * composition root, which reads `$ODU_ROOT_TOKEN`. There is no fallback to a
 * file on disk and no "first run mints one": a cache that administers itself on
 * first contact is a cache anybody on the machine can create buckets in.
 */

import { statfs } from "node:fs/promises";
import { join } from "node:path";
import type {
  BucketRow,
  BucketTotals,
  MigrationRow,
  ObjectRow,
  PinAuthor,
  Scope,
  TokenRow,
} from "./db";
import { cursorFor, openCacheRepo } from "./db";
import {
  closureOf,
  type GcBucketPlan,
  type GcCollection,
  type GcRemoval,
  GC_PREVIEW_PATHS,
  type GcPreview,
  planGc,
  previewGc,
  runGc,
  sweepOrphans,
} from "./gc";
import { migrationKeys, runMigration } from "./migrateStore";
import {
  fingerprintOf,
  formatNarinfo,
  generateKeypair,
  isDerivationPath,
  isStorePathHash,
  keyNameOf,
  compressionOfFile,
  canonicalNarHash,
  type NarInfo,
  narFileName,
  signFingerprint,
  storePathHash,
} from "./narinfo";
import { newChain, serial } from "./serial";
import { CACHE_MOUNT } from "./paths";
import { LOCAL_STORE, PATH_PAGE_SIZE } from "./surface";
import {
  cacheInfoKey,
  CACHE_INFO_CONTENT_TYPE,
  createStaging,
  INFO_CACHE_CONTROL,
  NAR_CACHE_CONTROL,
  NAR_CONTENT_TYPE,
  narinfoKey,
  NARINFO_CONTENT_TYPE,
  nixCacheInfo,
  objectKey,
  type CompleteUpload,
  type NarinfoOutcome,
  type Upload,
} from "./staging";
import {
  type ByteRange,
  factsCounter,
  type ObjectFacts,
  type ObjectStore,
  type PutOutcome,
  sameFacts,
} from "@odu/objects";
import { type KeptFile, keptFileOf } from "./fileHash";
import { contentAddressOf } from "./storePath";
import { verifyNarStream } from "./store";
import { createSlots } from "./slots";
import {
  globMatches,
  hashToken,
  mintToken,
  mintTokenId,
  rootTokenMatches,
  type TokenFacts,
  tokenFacts,
  verifyToken,
} from "./tokens";

/** What a bucket looks like to a caller. No secret key, ever. */
export interface BucketFacts {
  name: string;
  public: boolean;
  retentionDays: number;
  keyName: string;
  publicKey: string;
  upstreamKeys: readonly string[];
  /** The name this bucket is served at, when it has one. */
  domain: string | null;
  objects: number;
  bytes: number;
  created: number;
  /** When the newest narinfo landed; `null` for a bucket nothing was pushed
   *  to. */
  lastPush: number | null;
  /** narinfo reads, summed over the bucket's objects. */
  hits: number;
  /** The declared store its objects live in. */
  store: string;
  /** THE MOVE RUNNING ON THIS BUCKET, or null. While it is not null the
   *  bucket is still served from `store`; the move's own `to` is where it is
   *  going (PLAN 2.8). */
  migration: MigrationFacts | null;
}

/** A store-to-store move, as a subscriber watches it. */
export interface MigrationFacts {
  /** The store it is moving to. */
  to: string;
  /** `copying` while the new store is being filled, `flipping` for the moment
   *  the bucket changes hands under the write lock, `deleting` while the old
   *  store gives its copies up. */
  state: "copying" | "flipping" | "deleting";
  copied: number;
  total: number;
  bytes: number;
}

/**
 * What `describe` answers: a bucket's PUBLIC identity and nothing else.
 *
 * Not `BucketFacts`. `describe` takes no credential, and a bucket's object
 * count, byte total, retention and upstream key names are facts about the
 * operator's cache rather than about the substituter a client is pointed at.
 * `odu cache use` needs the URL and the key; a private bucket's EXISTENCE is
 * still something this answers, which is why PR 2 gates `describe` for a
 * private bucket behind a login — the contract must not inherit a leak the
 * route layer was careful to close.
 */
export interface BucketIdentity {
  name: string;
  public: boolean;
  publicKey: string;
  /** The name a client substitutes from, when the bucket has one. */
  domain: string | null;
  /** The store its objects live in. Not a secret — the row publishes it
   *  already — and the one fact the caller needs to say whether the reads
   *  come from odu or from the store's own domain. */
  store: string;
}

export interface TokenMinted {
  /** The plaintext, shown ONCE. */
  token: string;
  facts: TokenFacts;
}

export interface PinFacts {
  bucket: string;
  name: string;
  rootPaths: readonly string[];
  created: number;
  /** The authority that made it — what decides who may re-point it. */
  createdBy: PinAuthor;
}

export interface CacheStats {
  buckets: readonly BucketFacts[];
  objects: number;
  bytes: number;
  hits: number;
  /** The newest renewal across the whole cache — the clock GC reads. */
  lastWanted: number | null;
}

/** Why an admin call was refused. The service maps these onto its own refusal
 *  codes; the package does not import the contract. */
export type CacheRefusalCode =
  | "no_root_token"
  | "unknown_bucket"
  | "bucket_exists"
  | "bad_input"
  /** The credential is real and may not do THIS — a write token asked to
   *  re-point an administrator's pin. */
  | "not_permitted"
  | "unknown_store";

export type CacheOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: CacheRefusalCode; message: string };

/**
 * HOW A CALL WAS AUTHORISED — and the union is the point.
 *
 * The row builds it, once, from the caller's principal: an operator's ROOT
 * TOKEN, or a signed-in person whose ROLE the row already checked. The engine
 * does not know what a role means — this package's row decides what an `admin`
 * may do, and this is that decision's arrival at the data.
 *
 * THE ROLE ARM IS SEALED. It carries a key of a symbol this module does not
 * export, so no code outside this package can word-process one: the only way to
 * obtain the arm is {@link roleAuthority}, which nothing but the row calls. A
 * boolean a caller could set would be a claim the engine cannot check.
 */
const roleSeal: unique symbol = Symbol("odu:cache/role");

export type Authority =
  | { readonly kind: "root"; readonly rootToken: string }
  | { readonly kind: "role"; readonly login: string; readonly [roleSeal]: true };

/** The ROLE arm — minted here and nowhere else, because `roleSeal` is private. */
export function roleAuthority(login: string): Authority {
  return { kind: "role", login, [roleSeal]: true };
}

/** The admin face, structurally the service's `CacheAdmin` port. */
export interface CacheAdmin {
  /** Where the protocol is mounted under the origin — `./paths`, re-exported
   *  here because this is the object the composition root hands the service,
   *  and the service is what prefixes a bucket's substituter URL. */
  readonly mount: string;
  create(input: { authority: Authority;
    name: string;
    public: boolean;
    retentionDays: number;
    upstreamKeys: readonly string[];
    /** A declared store's name; absent is `local`, the daemon's disk. */
    store?: string;
  }): Promise<CacheOutcome<BucketFacts>>;
  list(input: { authority: Authority }): Promise<CacheOutcome<readonly BucketFacts[]>>;
  /**
   * One bucket's PUBLIC identity — its URL and the key a client has to trust —
   * with no root token.
   *
   * `odu cache use` needs exactly this, and nothing else: the substituter
   * address and the public key are what a bucket publishes to every client
   * that talks to it, so demanding the operator's root token for them would
   * make a read-only question into an administrative one. The NAME is the
   * capability, the same way it is in the substituter URL.
   */
  describe(input: { bucket: string }): Promise<CacheOutcome<BucketIdentity>>;
  /**
   * GIVE A BUCKET A NAME, or take it away (`null`). One domain, one bucket;
   * the row answers by that `Host` and the substituter URL becomes the name.
   */
  domain(input: {
    authority: Authority;
    bucket: string;
    domain: string | null;
  }): Promise<CacheOutcome<BucketFacts>>;
  tokenMint(input: { authority: Authority;
    bucket: string;
    /** A glob, so one token can cover `team-*`. Absent means the bucket. */
    bucketGlob: string | null;
    scope: Scope;
    expiresDays: number | null;
  }): Promise<CacheOutcome<TokenMinted>>;
  tokenList(input: { authority: Authority;
    bucket: string | null;
  }): Promise<CacheOutcome<readonly TokenFacts[]>>;
  tokenRevoke(input: { authority: Authority;
    id: string;
  }): Promise<CacheOutcome<{ id: string; revoked: boolean }>>;
  /**
   * HOW LONG THIS BUCKET KEEPS WHAT NOBODY WANTS, in days from `lastWanted`.
   * A bucket is created with the default and changes its mind here; zero
   * expires everything that is not referenced or pinned.
   */
  retention(input: {
    authority: Authority;
    bucket: string;
    retentionDays: number;
  }): Promise<CacheOutcome<BucketFacts>>;
  /**
   * MOVE THIS BUCKET'S OBJECTS TO ANOTHER STORE (PLAN 2.8).
   *
   * Answers as soon as the move is RECORDED, not when it finishes: the copy
   * runs in the background and its progress is on the bucket's own row, which
   * the board already follows. The bucket is served from the old store the
   * whole time and changes hands in one moment under the write lock.
   *
   * Refused for an unknown store, for the store it already lives in, and for
   * a bucket that is already moving.
   */
  migrateStore(input: {
    authority: Authority;
    bucket: string;
    store: string;
  }): Promise<CacheOutcome<BucketFacts>>;
  pin(input: { authority: Authority;
    bucket: string;
    name: string;
    paths: readonly string[];
  }): Promise<CacheOutcome<PinFacts>>;
  /** Every pin this bucket holds, and WHAT each one holds: the closure it
   *  resolved at pin time. */
  pinList(input: {
    authority: Authority;
    bucket: string;
  }): Promise<CacheOutcome<readonly PinFacts[]>>;
  /** Let a pin go. The paths it held become ordinary rows, collected on the
   *  next run if retention has passed them. */
  pinDelete(input: {
    authority: Authority;
    bucket: string;
    name: string;
  }): Promise<CacheOutcome<{ bucket: string; name: string }>>;
  gc(input: {
    authority: Authority;
    bucket: string | null;
  }): Promise<CacheOutcome<GcCollection>>;
  /** THE SAME DECISION, WITHOUT DOING IT — what the next collection would
   *  evict, path by path, and what it would reclaim. */
  gcPlan(input: {
    authority: Authority;
    bucket: string | null;
  }): Promise<CacheOutcome<GcPreview>>;
  stats(input: { authority: Authority }): Promise<CacheOutcome<CacheStats>>;
  /**
   * ONE PAGE of a bucket's stored paths, newest first.
   *
   * No root token: the same reasoning as `describe`. A bucket's PATH LIST is
   * what the substituter already serves one narinfo at a time to anyone who can
   * read the bucket, so a listing that demanded the operator's secret would be
   * a credential on a question the protocol answers for free.
   */
  paths(input: {
    bucket: string;
    filter: string | null;
    after: string | null;
  }): Promise<CacheOutcome<{ paths: readonly PathPageRow[]; next: string | null }>>;
}

/** One stored path, as `paths` lists it. */
export interface PathPageRow {
  storePath: string;
  narSize: number;
  created: number;
  hits: number;
  /** When a push or a `missing` query last said somebody wants it. */
  lastWanted: number;
}

/** The verdict on a presented credential. `status` is what the route answers
 *  with: 401 for "who are you", 403 for "not with that token", and 404 for an
 *  anonymous read of a PRIVATE bucket — a 401 there would confirm the bucket
 *  exists, which is exactly what a private name must not leak. */
export type AuthVerdict = { ok: true } | { ok: false; status: 401 | 403 | 404; message: string };

export type NarSource =
  /** A KEPT OBJECT, in whichever store its bucket lives: the whole size, and
   *  a read of any range of it. Every store answers the same way. */
  | {
      kind: "object";
      storePath: string;
      size: number;
      read(range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;
    }
  /** THE ONE-TIME MIGRATION: the old Nix store still has this row's path and
   *  its object has not been produced yet. Removed when that store is. */
  | { kind: "legacy"; storePath: string; stream: ReadableStream<Uint8Array> }
  /**
   * THE STORE SERVES IT, NOT ODU (PLAN 2.8). The bucket's objects live in a
   * store that hands out URLs of its own, so the route answers a redirect to
   * one that expires and the bytes never cross this machine. odu still
   * decided that this caller may read this bucket — the URL is minted only
   * after that — which is why a PRIVATE bucket can be served this way at all.
   */
  | { kind: "redirect"; storePath: string; size: number; url: URL };

/** Why the cache cannot be mounted. A value naming the fact, rendered once at
 *  the row's boundary. */
export type CacheMountRefusal = {
  kind: "undeclared_store";
  bucket: string;
  store: string;
  declared: readonly string[];
};

export function mountRefusalMessage(refusal: CacheMountRefusal): string {
  return (
    `the bucket "${refusal.bucket}" keeps its objects in the store "${refusal.store}", ` +
    `which this daemon does not declare (declared: ${refusal.declared.join(", ")}) — ` +
    "declare it again, or the bucket's objects cannot be served"
  );
}

/** What one boot's SYNCHRONOUS work found: before mount, no pushes can race. */
export interface BootReport {
  /** Rows whose path proved its own `fixed:r:sha256` CA. */
  caProved: number;
  /** Object files with no row (a crash between put and record). */
  orphansSwept: number;
  /** What dead puts left from before this boot: `.tmp-*` names, and on S3
   *  incomplete multipart uploads. */
  tempSwept: number;
}

/** What the one-time self-CA pass found. */
export interface SelfProofReport {
  rows: number;
  proved: number;
  refused: number;
  unreadable: number;
}

/** What the narinfo backfill wrote: every bucket's rows walked, the objects
 *  it had to write, and the ones no store would take. */
export interface ObjectBackfillReport {
  rows: number;
  written: number;
  failures: number;
}

/** What the row-owned background migration did. */
export interface MigrationReport {
  migrated: number;
  failures: number;
  /** True only when every row has its object. */
  complete: boolean;
  /** Why it is paused for space, if it ended that way. */
  paused: string | null;
}

export interface Cache {
  /** The protocol face. */
  bucket(name: string): BucketRow | null;
  /** The bucket a HOST names, or null. The caller lowercases and strips the
   *  port; a domain is stored as the name a client types. */
  bucketByDomain(host: string): BucketRow | null;
  authorize(header: string | undefined, bucket: BucketRow, need: Scope): AuthVerdict;
  narinfoText(bucket: BucketRow, hash: string): string | null;
  /** `nix-cache-info` for one bucket, by name — the three lines a Nix client
   *  reads first and the two `Odu-` lines that say where this bucket is
   *  pushed to. One rendering for the ROUTE and for the object written to the
   *  store, so a reader that reaches odu and one that reaches only the store
   *  cannot be told different things. */
  cacheInfoText(bucket: string): string;
  touch(bucket: BucketRow, hash: string): void;
  /** ONE operational line; the row hands the daemon's logger to the cache. */
  log(event: string, fields: Record<string, unknown>): void;
  narSource(bucket: BucketRow, file: string): Promise<NarSource | null>;
  beginUpload(bucket: BucketRow, file: string): Promise<Upload>;
  /** One part of a chunked NAR, under the part ceiling. A retry overwrites the
   *  same index, so a dropped request costs one part. `session` (2.4) makes
   *  the parts this upload's own; null keeps the shared names 2.x sends. */
  beginPart(
    bucket: BucketRow,
    file: string,
    index: number,
    limit: number,
    session?: string | null,
  ): Promise<Upload>;
  /** Join the parts into the NAR the narinfo will name. `missing` non-empty
   *  means the client's count is ahead of what arrived. */
  completeUpload(
    bucket: BucketRow,
    file: string,
    total: number,
    session?: string | null,
  ): Promise<CompleteUpload>;
  acceptNarinfo(bucket: BucketRow, hash: string, body: ReadableStream<Uint8Array>): Promise<NarinfoOutcome>;
  /** Which of `paths` the bucket needs. `skipped` is the subset it will never
   *  take because an upstream key signed it — reported separately so `odu cache
   *  push` can say "upstream" rather than "already there". */
  missing(
    bucket: BucketRow,
    paths: readonly { path: string; sigs?: readonly string[] }[],
  ): { missing: readonly string[]; skipped: readonly string[] };
  /**
   * EVERY BUCKET'S ROW, without a credential — what a SUBSCRIBER reads.
   *
   * The root token guards ADMINISTRATION, not the board: who may subscribe is
   * the transport's decision (loopback today; a session in PR 3), and demanding
   * the operator's secret from a reader would make the cache unrenderable
   * without handing it out. It carries the same facts `admin.list` answers, and
   * no more.
   */
  snapshot(): readonly BucketFacts[];
  /**
   * SOMETHING A SUBSCRIBER WOULD SEE MOVED — a narinfo landed, a bucket was
   * created, a closure was pinned or collected, or reads accumulated.
   *
   * Reads are COALESCED here rather than at the subscriber: a bucket being
   * fetched from is a counter moving thousands of times a minute, and a
   * publish per read would be a broadcast storm dressed as freshness. At most
   * one notification a second, and only when the counters actually moved.
   *
   * The returned function unsubscribes. There is exactly one subscriber — the
   * row that publishes `buckets` — so this is a listener and not an emitter.
   */
  onChange(listener: () => void): () => void;
  /**
   * COLLECT EVERY BUCKET, with no caller to authorise — the SCHEDULE's entry
   * point, and nothing else's.
   *
   * A timer is not a principal: handing the row a fabricated root token so it
   * could call its own admin verb would be an authority invented to satisfy a
   * check. The verb authorises and then calls this; the schedule calls it
   * directly.
   */
  collect(): Promise<GcCollection>;
  /**
   * PIN A CLOSURE ON A BUCKET'S OWN AUTHORITY — what the protocol route
   * offers a WRITE token, and the one pin verb that is not administration.
   *
   * The scope rule, and why it is write rather than admin: a write token can
   * already keep any closure alive forever by pushing it again, because a
   * stored push renews `lastWanted`. A pin it may create or re-point grants it
   * no retention it lacks — it makes the same promise once instead of nightly
   * — and it still cannot read a private bucket, delete a pin, or administer
   * anything. DELETING a pin stays admin's: that is giving up retention
   * somebody else asked for.
   */
  pinAs(
    bucket: BucketRow,
    input: { name: string; paths: readonly string[] },
  ): Promise<CacheOutcome<PinFacts>>;
  /** The admin face. */
  admin: CacheAdmin;
  /** BEFORE MOUNT: prove `CA:`, sweep orphan objects and abandoned temp files.
   *  Nothing is writing yet, so a sweep cannot race a put. */
  boot(): Promise<{ ok: true; report: BootReport } | { ok: false; refusal: CacheMountRefusal }>;
  /** AFTER MOUNT, AS A ROW-OWNED BACKGROUND TASK: prove self-referencing rows
   *  from their kept bytes, ONCE per row (the verdict is persisted). */
  proveSelf(): Promise<SelfProofReport>;
  /** AFTER MOUNT, AS A ROW-OWNED BACKGROUND TASK: migrate objects the old store
   *  still owns, two at a time, resuming after a disk pause. */
  migrate(): Promise<MigrationReport>;
  /** AFTER MOUNT, AS A ROW-OWNED BACKGROUND TASK: write every bucket's
   *  narinfo and `nix-cache-info` objects, two at a time, skipping the ones
   *  already there (PLAN 2.8). Idempotent, so a restart resumes it. */
  backfillObjects(): Promise<ObjectBackfillReport>;
  /** AFTER MOUNT: pick up every store-to-store move a restart interrupted
   *  (PLAN 2.8). Answers when they are all finished. */
  resumeMigrations(): Promise<void>;
  /** Join the row's background work, then close the database. */
  close(): Promise<void>;
}

export interface CacheOptions {
  /** The per-user state root; the cache owns `<stateRoot>/cache`. */
  stateRoot: string;
  /** `$ODU_ROOT_TOKEN`, or null when the operator supplied none. */
  rootToken: string | null;
  /**
   * WHERE THIS DAEMON IS REACHED — the proxy's origin when one stands in
   * front, the bound one otherwise, which is the same string the row builds a
   * bucket's `pushUrl` from.
   *
   * The cache needs it because `nix-cache-info` NAMES IT (PLAN 2.8): reads
   * come from the store, so the push address can no longer be derived from
   * the substituter, and the file a Nix client reads first is where the cache
   * states it. Required rather than defaulted: a cache that guessed loopback
   * here would send every pusher to its own machine.
   */
  publicOrigin: string;
  /** THE OLD NIX STORE, read only during the one-time migration. `null` on a
   *  fresh deployment; the row never needs a store otherwise. */
  legacyStore?: {
    dump(storePath: string): ReadableStream<Uint8Array>;
    /** The old store's own facts for a row: the NarHash the migration must
     *  match before keeping bytes, and the CA its narinfo could not prove. */
    pathInfo?(storePath: string): Promise<{ ca: string | null; narHash: string } | null>;
  } | null;
  /** Pause the migration below this many free bytes (default 10 GiB). */
  migrationFreeFloor?: number;
  /** How long a paused migration waits before re-checking free space. */
  migrationRetryMs?: number;
  /** Injected by the suite for the disk-floor test. */
  freeBytes?: () => Promise<number | null>;
  /** THE STORES, by declared name, `local` among them — the row builds them
   *  from the operator's declarations (`./stores` `objectStores`), and a suite
   *  passes its own. The cache never builds a store. */
  stores: ReadonlyMap<string, ObjectStore>;
  /**
   * THE STORES THE WORLD CAN READ DIRECTLY — those whose declaration carries
   * a `publicUrl` (PLAN 2.8).
   *
   * A bound domain covers the WHOLE store, every prefix in it, because that
   * is what binding a custom domain to an S3 bucket means. So a PRIVATE
   * bucket on one of these would have its narinfos and its NARs readable by
   * anyone who can guess its name, whatever odu's own routes decide — which
   * is why `create` and `migrate` refuse the combination rather than
   * documenting it.
   */
  frontedStores?: ReadonlySet<string>;
  now?: () => number;
  /** ONE structured line per operational fact (serve, import, boot, refusal).
   *  The row hands the daemon's logger here; a suite that does not care omits
   *  it. No per-chunk lines: a NAR read is one line. */
  log?: (event: string, fields: Record<string, unknown>) => void;
  /**
   * AN ADDRESS WHOSE BYTES ARE NO LONGER WHAT THEY WERE, so whoever fronts
   * the store can be told.
   *
   * Two callers. A finished MOVE leaves the previous store's copies deleted;
   * a RE-PUSH rewrites a narinfo object that was cacheable for a day. The ROW
   * knows where a bucket is reachable from and the cache does not, so the
   * cache names the paths and the row builds the URLs — the same division the
   * collector's announcement uses.
   */
  purged?: (input: {
    bucket: string;
    store: string;
    reason: "migrate" | "repush";
    removals: readonly GcRemoval[];
    /** The bucket's `nix-cache-info`, when that is what changed — a move
     *  deletes it with everything else, and a `Priority:` edit rewrites it. */
    cacheInfo?: boolean;
  }) => void;
}

/** The floor between two READ-driven publications. Reads are the only change
 *  that arrives thousands of times a minute, and a hit count that moved a second
 *  ago is as true for a reader as one that moved a millisecond ago. */
export const HITS_REFRESH_MS = 1000;

/**
 * HOW LONG A REDIRECTED NAR URL LIVES — ten minutes, Attic's number for the
 * same redirect.
 *
 * It is a copy budget, not a session: a client that followed the redirect is
 * already downloading, and a resumed download re-asks odu. Long enough for a
 * multi-gigabyte NAR on a slow link to start, short enough that a URL
 * someone pasted out of a log is dead before it is useful.
 */
export const PRESIGN_SECONDS = 600;

/** A bucket name is a path segment on the wire, so it is a DNS-ish label and
 *  nothing else: lowercase, digits, dashes. A name with a `/` in it would be a
 *  second route, and one with a `.` would collide with `<hash>.narinfo`. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A bucket's public NAME: a lowercase DNS hostname, no scheme, no port. The
 *  last label is alphanumeric so `cache.` and `-x` are refused. */
const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function createCache(options: CacheOptions): Cache {
  const now = options.now ?? (() => Date.now());
  const dir = join(options.stateRoot, "cache");
  const repo = openCacheRepo(join(dir, "cache.sqlite"));
  const { stores } = options;
  /** The stores a client can read without odu — empty unless the operator
   *  bound a domain to one. */
  const fronted = options.frontedStores ?? new Set<string>();
  /**
   * THE ONE PLACE A BUCKET BECOMES ITS STORE, from the row's own `store` fact.
   * Every bucket's store was proved declared at boot and at create, so a
   * missing one here is a broken invariant, not a refusal.
   */
  const storeOf = (bucket: Pick<BucketRow, "name" | "store">): ObjectStore => {
    const store = stores.get(bucket.store);
    if (store === undefined) throw new Error(`bucket "${bucket.name}" names an undeclared store`);
    return store;
  };
  /** The same, for a caller holding only a bucket's NAME (an object row's). */
  const objectsOf = (name: string): ObjectStore => {
    const bucket = repo.bucket(name);
    if (bucket === null) throw new Error(`no bucket "${name}"`);
    return storeOf(bucket);
  };

  /**
   * ONE writer at a time, across keep-and-record (staging's), `pin` and `gc`.
   *
   * Those three are the only things that change what is retained, and they are
   * the three that must not interleave: a collection that planned while a pin
   * was in flight would delete the path the pin had just promised to keep, and
   * a `record` between a plan and a delete is the same race from the other
   * side. The lock is taken for the whole of each, so the loser sees the
   * winner's result rather than a half-applied one.
   */
  const writers = newChain();
  const withWriteLock = <T>(work: () => Promise<T>): Promise<T> => serial(writers, work);

  /**
   * MAY THIS CALL ADMINISTER A BUCKET?
   *
   * Two answers, and exactly one applies. A `role` authority is one the ROW
   * already decided: it read the connection's principal and found an `admin` or
   * an `owner`, so there is no operator secret to compare — a daemon with an
   * identity provider mounted need not have a root token at all. Otherwise the
   * root token is the rule, which is loopback mode and the operator's bootstrap.
   */
  function requireRoot(input: { authority: Authority }): CacheOutcome<null> {
    if (input.authority.kind === "role") {
      // THE SEAL, not the word: `kind` is a string a cast can write, and the
      // symbol is not obtainable outside this module.
      if (roleSeal in input.authority && input.authority[roleSeal] === true) {
        return { ok: true, value: null };
      }
      return {
        ok: false,
        code: "no_root_token",
        message: "this authority was not minted by the cache row",
      };
    }
    if (!rootTokenMatches(options.rootToken, input.authority.rootToken)) {
      return {
        ok: false,
        code: "no_root_token",
        message:
          options.rootToken === null
            ? "this service was started without a root token, so no cache " +
              "administration is possible — set $ODU_ROOT_TOKEN and restart it"
            : "the root token does not match this service's $ODU_ROOT_TOKEN",
      };
    }
    return { ok: true, value: null };
  }

  /**
   * WOULD THIS BUCKET'S BYTES BE WORLD-READABLE BY MERELY LIVING THERE?
   *
   * A store's `publicUrl` is a domain bound to the whole S3 bucket, so every
   * prefix in it answers to anyone who knows a name — odu's own routes do not
   * come into it. A PRIVATE bucket on such a store is therefore private in
   * name only, and the refusal is here rather than in the documentation
   * because odu holds both facts at the moment of the choice.
   */
  const exposure = (isPublic: boolean, store: string): CacheOutcome<never> | null =>
    isPublic || !fronted.has(store)
      ? null
      : {
          ok: false,
          code: "bad_input",
          message:
            `the store "${store}" publishes its objects at a public URL, so a private ` +
            "bucket on it would be readable by anyone who knows its name — make the " +
            "bucket public, or choose a store with no publicUrl",
        };

  const migrationFactsOf = (bucket: string): MigrationFacts | null => {
    const row = repo.migration(bucket);
    return row === null
      ? null
      : { to: row.toStore, state: row.state, copied: row.copied, total: row.total, bytes: row.bytes };
  };

  /** What writing one of the protocol's text objects came to: a first write,
   *  bytes that were already there, or a REWRITE whose old text an edge may
   *  still be serving. */
  type WriteOutcome = "written" | "same" | "rewritten";

  function factsOf(
    bucket: BucketRow,
    counted: Map<string, BucketTotals> = repo.bucketStats(),
  ): BucketFacts {
    const counts = counted.get(bucket.name);
    return {
      name: bucket.name,
      public: bucket.isPublic,
      retentionDays: bucket.retentionDays,
      keyName: bucket.keyName,
      publicKey: bucket.publicKey,
      upstreamKeys: bucket.upstreamKeys,
      domain: bucket.domain,
      objects: counts?.objects ?? 0,
      bytes: counts?.bytes ?? 0,
      created: bucket.created,
      lastPush: counts?.lastPush ?? null,
      hits: counts?.hits ?? 0,
      store: bucket.store,
      // THE MOVE, IF ONE IS RUNNING — read per bucket, because a bucket moves
      // between stores perhaps twice in its life and a join for the usual
      // answer would be a cost every page pays for a row that is almost
      // always absent.
      migration: migrationFactsOf(bucket.name),
    };
  }

  /** The bucket's signature over one path, computed AT READ TIME. A stored
   *  signature would silently survive a rotated key; one ed25519 sign per
   *  narinfo GET is nothing. */
  function signatureOf(bucket: BucketRow, row: ObjectRow): string {
    return signFingerprint(
      bucket.secretKey,
      fingerprintOf({
        storePath: row.storePath,
        narHash: row.narHash,
        narSize: row.narSize,
        references: row.references,
      }),
    );
  }

  /** The narinfo a client reads: the bucket's signature first, then the
   *  client's own, so a path signed on a lane stays verifiable there. */
  function narinfoFor(bucket: BucketRow, row: ObjectRow): string {
    const info: NarInfo = {
      storePath: row.storePath,
      url: `nar/${narFileName(row.narHash, row.compression)}`,
      compression: row.compression,
      fileHash: row.fileHash,
      fileSize: row.fileSize,
      narHash: row.narHash,
      narSize: row.narSize,
      references: row.references,
      deriver: row.deriver,
      ca: row.caProof === "content-addressed" ? row.ca : null,
      sigs: [signatureOf(bucket, row), ...row.sigs],
    };
    return formatNarinfo(info);
  }

  /**
   * THE PROTOCOL'S TEXT FILES AS OBJECTS (PLAN 2.8) — a narinfo and
   * `nix-cache-info`, written where the store can serve them without odu.
   *
   * `put` is CONDITIONAL — first writer wins — which is exactly right for a
   * NAR, whose key names its own bytes, and exactly wrong for a narinfo that a
   * re-push rewrote with one more signature. So this one compares: the kept
   * object's facts come back on the refusal, identical bytes are left alone,
   * and different ones are deleted and written again.
   *
   * A FAILURE HERE NEVER FAILS THE PUSH. The row is the truth and odu still
   * renders the narinfo from it; the object is the store's copy, and the
   * backfill (`backfillObjects`) writes any that a failed put left behind.
   */
  async function writeText(
    objects: ObjectStore,
    key: string,
    text: string,
    contentType: string,
  ): Promise<WriteOutcome> {
    const bytes = new TextEncoder().encode(text);
    const counter = factsCounter();
    counter.update(bytes);
    const facts = counter.facts();
    const put = (): Promise<PutOutcome> =>
      objects.put(key, new Blob([bytes]), facts, {
        contentType,
        cacheControl: INFO_CACHE_CONTROL,
      });
    const first = await put();
    if (first.ok) return "written";
    if (first.refusal.kind === "exists" && sameFacts(first.refusal.facts, facts)) return "same";
    await objects.delete(key);
    const again = await put();
    if (!again.ok) throw new Error(`${key} could not be written: ${again.refusal.kind}`);
    // A REWRITE, NOT A FIRST WRITE: an edge may be holding the text this just
    // replaced, for the day `INFO_CACHE_CONTROL` gave it. The caller purges.
    return "rewritten";
  }

  /**
   * ONE OF THE PROTOCOL'S TEXT OBJECTS, written or confirmed.
   *
   * A FAILURE HERE NEVER FAILS THE CALLER. The row is the truth and odu
   * renders from it; the object is the store's copy, and the backfill writes
   * what a failed put left behind. The caller announces a `"rewritten"`,
   * because only it knows which address changed.
   */
  async function keepTextObject(
    bucket: BucketRow,
    what: { key: string; text: string; contentType: string },
  ): Promise<WriteOutcome | "failed"> {
    try {
      return await writeText(storeOf(bucket), what.key, what.text, what.contentType);
    } catch (err) {
      options.log?.("cache.narinfo.object_failed", {
        bucket: bucket.name,
        path: what.key,
        reason: String((err as Error).message ?? err),
      });
      return "failed";
    }
  }

  /** The bucket's narinfo object for one row. A rewrite is announced: the
   *  superseded text is cacheable for a day, and odu's own render is already
   *  correct. One narinfo, no NAR — a NAR is named by its own bytes and never
   *  changes, so purging it would be a cold cache for nothing. */
  async function keepNarinfoObject(
    bucket: BucketRow,
    row: ObjectRow,
  ): Promise<WriteOutcome | "failed"> {
    const outcome = await keepTextObject(bucket, {
      key: narinfoKey(bucket.name, row.hash),
      text: narinfoFor(bucket, row),
      contentType: NARINFO_CONTENT_TYPE,
    });
    if (outcome === "rewritten") {
      options.purged?.({
        bucket: bucket.name,
        store: bucket.store,
        reason: "repush",
        removals: [{ storePath: row.storePath, hash: row.hash, narFile: null }],
      });
    }
    return outcome;
  }

  /** THE ONE RENDERING of a bucket's `nix-cache-info` — what the route
   *  answers and what the object in the store holds. The origin is this
   *  daemon's (`publicOrigin`), which is the address `odu cache push` has to
   *  reach; the substituter a reader came from may be a store's domain that
   *  takes no PUT at all. */
  const cacheInfoText = (bucket: string): string =>
    nixCacheInfo({ origin: options.publicOrigin, bucket });

  /**
   * `nix-cache-info` for one bucket, written when the bucket is created and
   * confirmed on every backfill.
   *
   * IT IS NOT A CONSTANT ANY MORE (PLAN 2.8): the text carries this daemon's
   * origin and this bucket's name, so moving the deployment behind a new
   * `$ODU_PUBLIC_ORIGIN` changes it. `writeText` compares the STORED SHA256
   * the store already keeps rather than the length — the two origins a move
   * is between can be the same number of characters — and a rewrite is
   * purged like a narinfo's, because the old text was cacheable for a day and
   * names an address that no longer takes a push.
   */
  async function keepCacheInfoObject(bucket: BucketRow): Promise<void> {
    const outcome = await keepTextObject(bucket, {
      key: cacheInfoKey(bucket.name),
      text: cacheInfoText(bucket.name),
      contentType: CACHE_INFO_CONTENT_TYPE,
    });
    if (outcome === "rewritten") {
      options.purged?.({
        bucket: bucket.name,
        store: bucket.store,
        reason: "repush",
        removals: [],
        cacheInfo: true,
      });
    }
  }

  /** Record an imported path. Idempotent: a re-pushed path refreshes its row
   *  rather than duplicating, and keeps its hit count.
   *
   * The signature the BUCKET made is not stored — it is computed at read — so
   * the row holds only the CLIENT's signatures, deduplicated by full
   * `name:base64` string: Nix hands the same signature back from
   * `path-info` that it took from the narinfo, and a row with it twice would
   * put it twice in every answer.
   */
  async function recordNow(
    bucket: BucketRow,
    info: NarInfo,
    file: KeptFile,
    selfHash: string | null,
  ): Promise<boolean> {
    const existing = repo.object(bucket.name, info.storePath);
    const at = now();
    const sigs = [...new Set(info.sigs)].filter((sig) => keyNameOf(sig) !== bucket.keyName);
    // CA IS PROVED FROM THE PATH, not taken from the pusher and not asked of a
    // store: the row already holds (name, narHash, references, self), and Nix's
    // formula reproduces the path or it does not. An old input-addressed row
    // stays null, honestly.
    const computed = contentAddressOf({
      storePath: info.storePath,
      narHash: info.narHash,
      references: info.references,
      selfHash,
    });
    // A SECOND narinfo PUT for a self-referencing CA row has no staged NAR to
    // prove from; `selfHash` is null. The SAME NarHash means the bytes the row
    // already proved are the bytes being named — keep that verdict rather than
    // flipping it to a final "not content-addressed".
    const keep =
      computed === null &&
      selfHash === null &&
      existing !== null &&
      existing.narHash === info.narHash &&
      existing.ca !== null;
    const ca = keep ? existing.ca : computed;
    const caProof = keep
      ? existing.caProof
      : ca === null
        ? "not-content-addressed"
        : "content-addressed";
    repo.putObject({
      bucket: bucket.name,
      storePath: info.storePath,
      hash: storePathHash(info.storePath),
      narHash: info.narHash,
      narSize: info.narSize,
      references: info.references,
      deriver: info.deriver,
      ca,
      caProof,
      compression: info.compression ?? "none",
      fileHash: file.fileHash,
      fileSize: file.fileSize,
      sigs,
      hits: existing?.hits ?? 0,
      created: existing?.created ?? at,
      // A STORED PUSH IS A WANT, and the clock retention reads: the pusher
      // has just said this path matters to it.
      lastWanted: at,
    });
    // THE STORE'S COPY OF THE NARINFO, rewritten from the row that has just
    // landed (PLAN 2.8): a re-push that added a signature must not leave the
    // store serving the old text. The row is already recorded, so a store that
    // refuses this is a stale object the backfill picks up — never a push that
    // 400s for bytes it kept.
    const recorded = repo.object(bucket.name, info.storePath);
    if (recorded !== null) await keepNarinfoObject(bucket, recorded);
    return true;
  }

  // The write path, wired to the ONE lock: staging keeps an object and records
  // its row under it, so neither a pin nor a collection lands in between.
  const staging = createStaging({
    storeOf,
    // READ UNDER THE LOCK: which store a push writes to is decided from the
    // row as it is then, never from the snapshot the request was admitted
    // against (PLAN 2.8's move).
    bucketNow: (name) => repo.bucket(name),
    dir,
    now,
    withWriteLock,
    record: recordNow,
    log: options.log,
    // A KEPT OBJECT'S FACTS, READ — never re-hashed when a row already has
    // them: the row an earlier proof recorded, confirmed by the stored size.
    // An object with no row (a crash between keep and record) is asked of the
    // store, which for S3 is a stored checksum rather than a read of the bytes.
    async keptFacts(bucket, narHash, compression) {
      const key = objectKey(bucket.name, narHash, compression);
      const objects = storeOf(bucket);
      const size = await objects.head(key);
      if (size === null) return null;
      const row = repo.objectByNarHashCompression(bucket.name, narHash, compression ?? "none");
      if (row !== null && row.fileHash !== null && row.fileSize === size) {
        return { fileHash: row.fileHash, fileSize: size };
      }
      const stored = await objects.facts(key);
      return stored === null ? null : keptFileOf(stored);
    },
  });
  /** THE MIGRATION'S THROTTLE: two old-store dumps at a time, never more. */
  const migrationSlots = createSlots(2);
  /** THE BACKFILL'S THROTTLE, its own: two narinfo objects at a time, so a
   *  catch-up pass cannot crowd out the migration's dumps. */
  const backfillSlots = createSlots(2);
  /** THE STORE-TO-STORE MOVES RUNNING NOW, by bucket — so `close` can join
   *  them and a start cannot begin the same one twice. */
  const storeMoves = new Map<string, Promise<void>>();
  /** Two objects in flight per move, the same throttle the rest of the row's
   *  background work uses. */
  const moveSlots = createSlots(2);

  /** Start — or resume — one bucket's move, row-owned. */
  const startMigration = (row: MigrationRow): Promise<void> => {
    const running = storeMoves.get(row.bucket);
    if (running !== undefined) return running;
    const task = runMigration(row, {
      repo,
      storeNamed: (name) => stores.get(name) as ObjectStore,
      withWriteLock,
      slots: moveSlots,
      now,
      notify,
      ...(options.log === undefined ? {} : { log: options.log }),
      ...(options.purged === undefined ? {} : { purged: options.purged }),
      stopping: () => stopping,
    }).finally(() => {
      storeMoves.delete(row.bucket);
    });
    storeMoves.set(row.bucket, task);
    return task;
  };
  /** Paths whose transition serve was refused, logged once each. */
  const unavailableLogged = new Set<string>();
  /** The row's background migration, so close can join it before the DB goes. */
  let migrationTask: Promise<MigrationReport> | null = null;
  let selfTask: Promise<SelfProofReport> | null = null;
  let backfillTask: Promise<ObjectBackfillReport> | null = null;
  let stopping = false;
  /** Resolves on close: a migration sleeping on disk or waiting on a dump can
   *  end without waiting for that promise to settle. */
  const stopSignal = Promise.withResolvers<void>();

  // ── who hears about a change ──────────────────────────────────────────────
  //
  // ONE listener: the row that publishes `buckets` to whatever is watching. The
  // cache knows when a push lands, when a bucket appears and when reads
  // accumulate — and nothing outside it does — so the notification is emitted
  // here rather than polled for.
  //
  // READS ARE THROTTLED, and with a TRAILING edge. A bucket being fetched from
  // moves a counter thousands of times a minute, so a publish per read is a
  // broadcast storm dressed as freshness — but a leading edge alone drops the
  // reads after the first of each window, and a burst that then stops leaves the
  // board showing a number that never existed. So the first read of a window
  // publishes, a read at the end of it ARMS a timer, and the timer fires once
  // the burst has been quiet for a window. The timer is the cache's, and
  // `close()` clears it: nothing outlives the activation.
  const listeners = new Set<() => void>();
  let lastReadNotify = Number.NEGATIVE_INFINITY;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const notifyReaders = (): void => {
    const at = now();
    if (at - lastReadNotify >= HITS_REFRESH_MS) {
      lastReadNotify = at;
      notify();
      return;
    }
    if (trailing !== null) return;
    trailing = setTimeout(() => {
      trailing = null;
      lastReadNotify = now();
      notify();
    }, HITS_REFRESH_MS);
  };

  const admin: CacheAdmin = {
    mount: CACHE_MOUNT,
    async create(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      if (!BUCKET_NAME.test(input.name)) {
        return {
          ok: false,
          code: "bad_input",
          message:
            input.name === ""
              ? "a bucket needs a name — lowercase letters, digits and dashes, e.g. my-project"
              : `"${input.name}" is not a bucket name — lowercase letters, digits and dashes`,
        };
      }
      if (!Number.isSafeInteger(input.retentionDays) || input.retentionDays < 0) {
        return {
          ok: false,
          code: "bad_input",
          message: "retention must be a whole number of days, zero or more",
        };
      }
      if (repo.bucket(input.name) !== null) {
        return { ok: false, code: "bucket_exists", message: `bucket "${input.name}" already exists` };
      }
      const store = input.store ?? LOCAL_STORE;
      if (!stores.has(store)) {
        return {
          ok: false,
          code: "unknown_store",
          message: `no store "${store}" — this daemon declares ${[...stores.keys()].join(", ")}`,
        };
      }
      const exposed = exposure(input.public, store);
      if (exposed !== null) return exposed;
      const keypair = generateKeypair(`${input.name}-1`);
      const bucket: BucketRow = {
        name: input.name,
        isPublic: input.public,
        retentionDays: input.retentionDays,
        keyName: keypair.name,
        secretKey: keypair.secretKey,
        publicKey: keypair.publicKey,
        upstreamKeys: input.upstreamKeys,
        created: now(),
        domain: null,
        store,
      };
      repo.putBucket(bucket);
      // `nix-cache-info` AS AN OBJECT, from the moment the bucket exists: a
      // store that fronts its own reads is asked for it before anything else,
      // and a bucket whose first push had not happened yet would answer 404
      // to every client that found it. Its text is a constant, so this is the
      // only time it is written (the backfill confirms it).
      await keepCacheInfoObject(bucket);
      // A bucket that appeared is a row that appeared.
      notify();
      return { ok: true, value: factsOf(bucket) };
    },

    async list(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      // ONE count query for every bucket, not one per bucket.
      const counted = repo.bucketStats();
      return { ok: true, value: repo.buckets().map((bucket) => factsOf(bucket, counted)) };
    },

    async describe(input) {
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      // The substituter's own identity: its name, whether it is public, and the
      // key a client trusts. Not the object count, the bytes, the retention or
      // the upstream key names — those are the operator's, and this verb takes
      // no credential.
      return {
        ok: true,
        value: {
          name: bucket.name,
          public: bucket.isPublic,
          publicKey: bucket.publicKey,
          domain: bucket.domain,
          store: bucket.store,
        },
      };
    },

    async domain(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      const domain = input.domain === null ? null : input.domain.trim().toLowerCase();
      if (domain !== null && !DOMAIN.test(domain)) {
        return {
          ok: false,
          code: "bad_input",
          message:
            `"${input.domain}" is not a domain name — a lowercase DNS name ` +
            "like cache.example.org, with no scheme and no port",
        };
      }
      if (domain !== null) {
        const holder = repo.bucketByDomain(domain);
        if (holder !== null && holder.name !== bucket.name) {
          return {
            ok: false,
            code: "bad_input",
            message: `"${domain}" already names the bucket "${holder.name}"`,
          };
        }
      }
      const next: BucketRow = { ...bucket, domain };
      repo.putBucket(next);
      notify();
      return { ok: true, value: factsOf(next) };
    },

    async tokenMint(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      if (input.expiresDays !== null && (!Number.isSafeInteger(input.expiresDays) || input.expiresDays <= 0)) {
        return {
          ok: false,
          code: "bad_input",
          message: "an expiry must be a whole number of days, one or more",
        };
      }
      const glob = input.bucketGlob ?? bucket.name;
      if (!/^[a-z0-9*-]+(,[a-z0-9*-]+)*$/.test(glob)) {
        return {
          ok: false,
          code: "bad_input",
          message: `"${glob}" is not a bucket glob — names, dashes and \`*\`, comma-separated`,
        };
      }
      const token = mintToken();
      const row: TokenRow = {
        id: mintTokenId(),
        hash: hashToken(token),
        bucketGlob: glob,
        scope: input.scope,
        expires: input.expiresDays === null ? null : now() + input.expiresDays * 24 * 60 * 60 * 1000,
        lastUsed: null,
        revoked: false,
        created: now(),
      };
      repo.putToken(row);
      return { ok: true, value: { token, facts: tokenFacts(row) } };
    },

    async tokenList(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const rows = repo.tokens();
      return {
        ok: true,
        value: rows
          .filter((row) => input.bucket === null || globMatches(row.bucketGlob, input.bucket))
          .map(tokenFacts),
      };
    },

    async tokenRevoke(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const revoked = repo.setTokenRevoked(input.id, true);
      if (!revoked) {
        return { ok: false, code: "bad_input", message: `no token "${input.id}"` };
      }
      return { ok: true, value: { id: input.id, revoked: true } };
    },

    async retention(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      if (!Number.isSafeInteger(input.retentionDays) || input.retentionDays < 0) {
        return {
          ok: false,
          code: "bad_input",
          message: "retention must be a whole number of days, zero or more",
        };
      }
      const next: BucketRow = { ...bucket, retentionDays: input.retentionDays };
      repo.putBucket(next);
      notify();
      return { ok: true, value: factsOf(next) };
    },

    async migrateStore(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      if (!stores.has(input.store)) {
        return {
          ok: false,
          code: "unknown_store",
          message: `no store "${input.store}" — this daemon declares ${[...stores.keys()].join(", ")}`,
        };
      }
      if (input.store === bucket.store) {
        return {
          ok: false,
          code: "bad_input",
          message: `"${bucket.name}" already keeps its objects in "${input.store}"`,
        };
      }
      const exposed = exposure(bucket.isPublic, input.store);
      if (exposed !== null) return exposed;
      // ONE MOVE PER BUCKET. A second one would be two copiers writing the
      // same keys into two stores and one of them flipping the bucket under
      // the other; a refusal says which one is running.
      const running = repo.migration(bucket.name);
      if (running !== null) {
        return {
          ok: false,
          code: "bad_input",
          message:
            `"${bucket.name}" is already moving to "${running.toStore}" ` +
            `(${running.copied} of ${running.total} objects copied)`,
        };
      }
      const row: MigrationRow = {
        bucket: bucket.name,
        fromStore: bucket.store,
        toStore: input.store,
        state: "copying",
        copied: 0,
        total: migrationKeys(repo, bucket.name).length,
        bytes: 0,
        started: now(),
      };
      repo.putMigration(row);
      options.log?.("cache.bucket.migrate.start", {
        bucket: row.bucket,
        from: row.fromStore,
        to: row.toStore,
        total: row.total,
      });
      notify();
      // THE ANSWER IS THE ROW, NOT THE OUTCOME: the copy is minutes of work
      // on a bucket of any size, and a verb that waited for it would be a
      // board control that times out. Progress is on the row.
      startMigration(row);
      return { ok: true, value: factsOf(repo.bucket(bucket.name) as BucketRow) };
    },

    async pin(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      return pinChecked(bucket, input, "admin");
    },

    async pinList(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      return { ok: true, value: repo.pins(bucket.name) };
    },

    async pinDelete(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      // UNDER THE WRITE LOCK, like every other change to what is retained: a
      // collection planning while this pin disappears must see one state or
      // the other, never a pin half-gone.
      return withWriteLock(async () => {
        if (!repo.deletePin(bucket.name, input.name)) {
          return {
            ok: false as const,
            code: "bad_input" as const,
            message: `no pin "${input.name}" in ${bucket.name}`,
          };
        }
        notify();
        return { ok: true as const, value: { bucket: bucket.name, name: input.name } };
      });
    },

    async gc(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const chosen = bucketsFor(input.bucket);
      if (!chosen.ok) return chosen;
      // A NAMED BUCKET IS NOT A SWEEP: see `collectNow`.
      return { ok: true, value: await collectNow(chosen.value, input.bucket === null) };
    },

    async gcPlan(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const chosen = bucketsFor(input.bucket);
      if (!chosen.ok) return chosen;
      // UNDER THE SAME LOCK as the collection it previews: a dry run taken
      // while a push was half-recorded would answer about a state that never
      // existed, and the lock is already how this row reads "what is retained".
      return withWriteLock(async () => ({
        ok: true as const,
        value: previewGc(planFor(chosen.value), GC_PREVIEW_PATHS),
      }));
    },

    async paths(input) {
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      const page = repo.objectsPage(bucket.name, {
        limit: PATH_PAGE_SIZE,
        after: input.after,
        filter: input.filter,
      });
      const last = page.rows.at(-1);
      return {
        ok: true,
        value: {
          paths: page.rows.map((row) => ({
            storePath: row.storePath,
            narSize: row.narSize,
            created: row.created,
            hits: row.hits,
            lastWanted: row.lastWanted,
          })),
          next: page.more && last !== undefined ? cursorFor(last) : null,
        },
      };
    },

    async stats(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      // ONE count query for every bucket, not one per bucket.
      const counted = repo.bucketStats();
      return {
        ok: true,
        value: {
          buckets: repo.buckets().map((bucket) => factsOf(bucket, counted)),
          ...repo.objectTotals(),
        },
      };
    },
  };

  /** A pin, checked and taken under the write lock — the body of BOTH doors:
   *  the administrative verb, and the protocol route a write token reaches
   *  (see {@link Cache.pinAs}). The sentences a person reads are here once. */
  async function pinChecked(
    bucket: BucketRow,
    input: { name: string; paths: readonly string[] },
    by: PinAuthor,
  ): Promise<CacheOutcome<PinFacts>> {
    // THE NAME IS TRIMMED ONCE, here, and what follows is that name: the
    // table's key is `(bucket, name)`, so a `"rel "` checked against `rel`
    // and then STORED with its space would be a second pin — and re-pointing
    // that releases nothing, which is the one thing re-pointing is for.
    const name = input.name.trim();
    if (name === "") {
      return { ok: false, code: "bad_input", message: "a pin needs a name, e.g. release-1.2" };
    }
    if (input.paths.length === 0) {
      return { ok: false, code: "bad_input", message: "a pin needs at least one path" };
    }
    // RE-POINTING IS RELEASING: the roots a pin held before are let go in the
    // same statement, so a write token re-pointing an ADMIN's pin would undo
    // an administrator's retention with a credential that may not delete one.
    // A write token makes its own pins and re-points those; everything else
    // in this bucket is an admin's to move.
    //
    // UNDER THE LOCK, with the write it guards: read outside it, the answer
    // could be about a pin an admin made a moment ago.
    return withWriteLock(async () => {
      const held = repo.pins(bucket.name).find((pin) => pin.name === name);
      if (by === "write" && held !== undefined && held.createdBy === "admin") {
        return {
          ok: false as const,
          code: "not_permitted" as const,
          message:
            `the pin "${held.name}" was made by an administrator — a write token may ` +
            "re-point only a pin a write token made, because re-pointing releases " +
            "whatever the pin held before",
        };
      }
      return pinNow(bucket, { name, paths: input.paths }, by);
    });
  }

  async function pinNow(
    bucket: BucketRow,
    input: { name: string; paths: readonly string[] },
    by: PinAuthor,
  ): Promise<CacheOutcome<PinFacts>> {
    // THE CLOSURE IS THE BUCKET'S OWN ROWS, walked by the COLLECTOR'S own
    // function: a pin promises exactly what GC protects, and two walks with
    // two rules is a pin that holds paths the collector lets go. The
    // references are followed in the metadata, never asked of a Nix store
    // the server no longer has.
    const rows = new Map(repo.objects(bucket.name).map((row) => [row.storePath, row]));
    const absent = input.paths.filter((path) => !rows.has(path));
    if (absent.length > 0) {
      return {
        ok: false,
        code: "bad_input",
        message: `no such path in the bucket: ${absent.join(", ")}`,
      };
    }
    const reached = [...closureOf(input.paths, rows)].filter((path) => rows.has(path));
    const created = now();
    repo.putPin({
      bucket: bucket.name,
      name: input.name,
      rootPaths: reached,
      created,
      createdBy: by,
    });
    // A pin changes `pinnedPaths`, which is a column of the bucket's row — so
    // this is the third mutator that NOTIFIES, beside create and gc.
    notify();
    return {
      ok: true,
      value: {
        bucket: bucket.name,
        name: input.name,
        rootPaths: reached,
        created,
        createdBy: by,
      },
    };
  }

  /** The buckets a verb names: one, or every one. An unknown name is the
   *  refusal; `null` is "all of them" and cannot be unknown. */
  function bucketsFor(name: string | null): CacheOutcome<readonly BucketRow[]> {
    if (name === null) return { ok: true, value: repo.buckets() };
    const bucket = repo.bucket(name);
    if (bucket === null) {
      return { ok: false, code: "unknown_bucket", message: `no bucket "${name}"` };
    }
    return { ok: true, value: [bucket] };
  }

  /** THE ONE PLACE A PLAN IS MADE, so the dry run and the collection cannot
   *  answer differently about the same buckets. */
  const planFor = (buckets: readonly BucketRow[]): GcBucketPlan[] =>
    planGc({ buckets, objects: repo.objects(), pins: repo.pins(), now: now() });

  /**
   * The whole collection — plan, delete, and (for a collection of EVERY
   * bucket) the orphan sweep — under the one write lock, so a pin or a
   * re-push cannot land between the plan and the delete and lose a path it
   * had just promised to keep.
   *
   * `sweep` is false for one named bucket: orphans appear when a push dies,
   * not when retention passes, so the button a person presses twice must not
   * pay a full paged LIST of the store each time. The schedule collects every
   * bucket, and that is when the sweep rides along.
   */
  async function collectNow(
    buckets: readonly BucketRow[],
    sweep: boolean,
  ): Promise<GcCollection> {
    return withWriteLock(async () => {
      const collected = await runGc(repo, planFor(buckets), objectsOf);
      const { report } = collected;
      if (sweep) {
        for (const bucket of buckets) {
          const swept = await sweepOrphans(repo, bucket.name, storeOf(bucket));
          const entry = report.buckets.find((one) => one.bucket === bucket.name);
          if (entry !== undefined) entry.orphans = swept;
          report.orphans += swept;
        }
      }
      // Every bucket the collection touched answers a different count now.
      if (report.evicted > 0 || report.orphans > 0) notify();
      options.log?.("cache.gc", {
        evicted: report.evicted,
        kept: report.kept,
        orphans: report.orphans,
        bytes: report.bytes,
      });
      return collected;
    });
  }

  async function proveSelfNow(): Promise<SelfProofReport> {
    const rows = repo.objects().filter(
      (row) => row.caProof === "unknown" && row.references.includes(row.storePath),
    );
    if (rows.length === 0) {
      return { rows: 0, proved: 0, refused: 0, unreadable: 0 };
    }
    options.log?.("cache.self_ca.start", {
      rows: rows.length,
      bytes: rows.reduce((sum, row) => sum + (row.fileSize ?? row.narSize), 0),
    });
    let next = 0;
    let proved = 0;
    let refused = 0;
    let unreadable = 0;
    let done = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (stopping) return;
        const row = rows[next++];
        if (row === undefined) return;
        // FROM THE STORE, whichever it is: the kept bytes, streamed.
        const object = await objectsOf(row.bucket)
          .get(objectKey(row.bucket, row.narHash, row.compression))
          .catch(() => null);
        if (object === null) {
          unreadable += 1;
          continue;
        }
        const checked = await Promise.race([
          verifyNarStream(object, row.compression, storePathHash(row.storePath)),
          stopSignal.promise.then(() => {
            void object.stream.cancel().catch(() => {});
            return null;
          }),
        ]);
        if (checked === null || stopping) return;
        done += 1;
        if (!checked.ok || checked.selfHash === null) {
          unreadable += 1;
        } else {
          const ca = contentAddressOf({
            storePath: row.storePath,
            narHash: row.narHash,
            references: row.references,
            selfHash: checked.selfHash,
          });
          repo.putObject({
            ...row,
            ca,
            caProof: ca === null ? "not-content-addressed" : "content-addressed",
          });
          if (ca === null) refused += 1;
          else proved += 1;
        }
        if (done % 100 === 0) {
          options.log?.("cache.self_ca.progress", { done, of: rows.length });
        }
      }
    };
    await Promise.all([worker(), worker()]);
    if (proved > 0) notify();
    options.log?.("cache.self_ca.complete", {
      rows: rows.length,
      proved,
      refused,
      unreadable,
    });
    return { rows: rows.length, proved, refused, unreadable };
  }

  async function migrateNow(): Promise<MigrationReport> {
      const missing = repo.objects().filter((row) => row.fileHash === null);
      if (missing.length === 0) {
        return { migrated: 0, failures: 0, complete: true, paused: null };
      }
      const legacy = options.legacyStore;
      if (legacy === undefined || legacy === null) {
        // NO OLD STORE: the rows stay objectless, and the route answers 404
        // rather than inventing bytes. The line names the count.
        options.log?.("cache.migration.incomplete", {
          remaining: missing.length,
          reason: "no old store is configured",
        });
        return { migrated: 0, failures: missing.length, complete: false, paused: null };
      }
      const floor = options.migrationFreeFloor ?? 10 * 1024 * 1024 * 1024;
      const retryMs = options.migrationRetryMs ?? 60_000;
      const free = options.freeBytes ?? (async () => {
        const stats = await statfs(join(dir, "objects")).catch(() => null);
        return stats === null ? null : stats.bavail * stats.bsize;
      });
      const available = await free().catch(() => null);
      options.log?.("cache.migration.start", {
        objects: missing.length,
        narBytes: missing.reduce((sum, row) => sum + row.narSize, 0),
        freeBytes: available,
      });

      let next = 0;
      let migrated = 0;
      let failures = 0;
      let paused: string | null = null;
      const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));

      const migrateOne = async (row: (typeof missing)[number]): Promise<void> => {
        // THE DISK FLOOR, RE-CHECKED AND WAITED OUT rather than ending the run:
        // space that returns in a minute should resume without a restart.
        for (;;) {
          if (stopping) return;
          const bytes = await free().catch(() => null);
          if (bytes === null || bytes >= floor) break;
          if (paused === null) {
            paused = `free space ${Math.round(bytes / 1024 ** 2)} MiB is below the ${Math.round(
              floor / 1024 ** 2,
            )} MiB floor`;
            options.log?.("cache.migration.pause", { reason: paused, at: row.storePath });
          }
          await Promise.race([sleep(retryMs), stopSignal.promise]);
        }
        if (stopping) return;
        if (paused !== null) {
          options.log?.("cache.migration.resume", { at: row.storePath });
          paused = null;
        }
        try {
          if (stopping) return;
          const known =
            legacy.pathInfo === undefined
              ? undefined
              : await legacy.pathInfo(row.storePath).catch(() => null);
          if (known === null) {
            failures += 1;
            options.log?.("cache.migration.object_failed", {
              bucket: row.bucket,
              path: row.storePath,
              reason: "the old store does not have this path",
            });
            return;
          }
          // A REBUILT PATH CAN WEAR THE SAME NAME WITH DIFFERENT BYTES. The row
          // was signed over one NarHash; keep only bytes the old store says
          // carry that hash.
          if (
            known !== undefined &&
            canonicalNarHash(known.narHash) !== row.narHash
          ) {
            failures += 1;
            options.log?.("cache.migration.object_failed", {
              bucket: row.bucket,
              path: row.storePath,
              reason: `the old store has ${known.narHash} but the row is ${row.narHash}`,
            });
            return;
          }
          // A TWIN MAY HAVE LANDED THE SAME OBJECT: ask before spawning a dump
          // whose bytes would be thrown away.
          const key = objectKey(row.bucket, row.narHash, row.compression);
          const objects = objectsOf(row.bucket);
          // A READ, not an empty put: a put racing a delete would store 0 bytes.
          const stored = await objects.facts(key);
          if (stored !== null) {
            repo.putObject({ ...row, ...keptFileOf(stored) });
            migrated += 1;
            return;
          }
          const dump = legacy.dump(row.storePath);
          // FIRST KEPT WINS: a twin that landed the key meanwhile is refused
          // with `exists`, and its facts are the row's.
          const writing = migrationSlots.withSlot(async (): Promise<ObjectFacts> => {
            const outcome = await objects.put(key, dump, undefined, {
              contentType: NAR_CONTENT_TYPE,
              cacheControl: NAR_CACHE_CONTROL,
            });
            if (outcome.ok) return outcome.facts;
            if (outcome.refusal.kind === "exists") return outcome.refusal.facts;
            throw new Error(`${key}: the store kept nothing (${outcome.refusal.kind})`);
          });
          // A losing write is not left running: cancelling the stream kills the
          // dump pipeline's process group.
          void writing.catch(() => {});
          const facts = await Promise.race([
            writing,
            stopSignal.promise.then(() => {
              void dump.cancel().catch(() => {});
              return null;
            }),
          ]);
          if (facts === null || stopping) return;
          repo.putObject({ ...row, ...keptFileOf(facts) });
          migrated += 1;
          if (migrated % 100 === 0) {
            options.log?.("cache.migration.progress", {
              migrated,
              remaining: repo.objects().filter((one) => one.fileHash === null).length,
            });
          }
        } catch (err) {
          failures += 1;
          options.log?.("cache.migration.object_failed", {
            bucket: row.bucket,
            path: row.storePath,
            reason: String((err as Error).message ?? err),
          });
        }
      };

      // REAL CONCURRENCY: two workers share the queue; each is inside the
      // row's fetch-slot bound while it dumps and puts.
      const workers = Array.from({ length: Math.min(2, missing.length) }, async () => {
        for (;;) {
          if (stopping) return;
          const row = missing[next++];
          if (row === undefined) return;
          await migrateOne(row);
        }
      });
      await Promise.all(workers);

      const complete = repo.objects().every((row) => row.fileHash !== null);
      const remaining = repo.objects().filter((row) => row.fileHash === null).length;
      if (complete && migrated > 0) {
        // THE LINE THE OPERATOR WAITS FOR before deleting the old store.
        options.log?.("cache.migration.complete", {
          migrated,
          note: "the old store is no longer read and can be deleted",
        });
      } else if (!complete) {
        options.log?.("cache.migration.incomplete", { migrated, failed: failures, remaining });
      }
    return { migrated, failures, complete, paused };
  }

  /**
   * EVERY BUCKET'S NARINFO AND `nix-cache-info` AS OBJECTS — the one-time
   * pass that catches up what was pushed before 2.8, and the repair for any
   * object a failed put left behind.
   *
   * Forked after the mount beside the legacy migration, and for the same
   * reason: kolu's bucket holds sixteen thousand rows, and a boot that wrote
   * them all before serving would be a cache that is down for minutes. Two at
   * a time, so a store sees the same concurrency a migration gives it.
   *
   * RESUMABLE because it is IDEMPOTENT: a row whose object is already there
   * with the rendered text's length is skipped on one HEAD, so a daemon
   * restarted half way through costs a walk and not a rewrite. The size test
   * is the cheap one; `keepNarinfoObject` compares the bytes themselves for
   * any row that fails it.
   */
  async function backfillNow(): Promise<ObjectBackfillReport> {
    const buckets = repo.buckets();
    let rows = 0;
    let written = 0;
    let failures = 0;
    for (const bucket of buckets) {
      if (stopping) break;
      await keepCacheInfoObject(bucket);
      const all = repo.objects(bucket.name);
      rows += all.length;
      let done = 0;
      let inBucket = 0;
      const one = async (row: ObjectRow): Promise<void> => {
        if (stopping) return;
        // THE BUCKET AS IT IS NOW, like a push's: this pass can run for
        // minutes, and a `bucket.migrate` that flipped in the middle of it
        // would otherwise have objects written into the store it is emptying.
        const at = repo.bucket(bucket.name) ?? bucket;
        const key = narinfoKey(at.name, row.hash);
        const text = narinfoFor(at, row);
        const size = await storeOf(at).head(key).catch(() => null);
        // NOT A ROW WHOSE OBJECT THE LEGACY MIGRATION HAS NOT LANDED: with no
        // `FileHash` the narinfo omits it, and the `URL:` it names is not in
        // the store — on a store-fronted bucket that is a narinfo the store
        // serves and a NAR that 404s. The pass that lands the object writes
        // it. (Guarded here rather than returned, so `done` keeps counting
        // and `remaining` still reaches zero.)
        if (row.fileHash !== null && size !== new TextEncoder().encode(text).length) {
          const outcome = await keepNarinfoObject(at, row);
          if (outcome === "failed") failures += 1;
          else if (outcome !== "same") {
            written += 1;
            inBucket += 1;
          }
        }
        done += 1;
        // ONE LINE PER FIVE HUNDRED ROWS: a line per object would be sixteen
        // thousand lines for one bucket's catch-up.
        if (done % 500 === 0) {
          options.log?.("cache.narinfo.backfill", {
            bucket: bucket.name,
            written: inBucket,
            remaining: all.length - done,
          });
        }
      };
      await Promise.all(
        all.map((row) =>
          backfillSlots.withSlot(() => one(row)).catch(() => {
            failures += 1;
          }),
        ),
      );
      options.log?.("cache.narinfo.backfill", {
        bucket: bucket.name,
        written: inBucket,
        remaining: all.length - done,
      });
    }
    return { rows, written, failures };
  }

  return {
    bucket: (name) => repo.bucket(name),

    bucketByDomain: (host) => repo.bucketByDomain(host),

    authorize(header, bucket, need) {
      const presented = credentialOf(header);
      if (presented === null) {
        if (need === "read" && bucket.isPublic) return { ok: true };
        // NOT a 401 for a private bucket: "you need a token" confirms the
        // bucket exists, and a private name must not be enumerable. A caller
        // who HAS a token and is refused gets 403, which leaks nothing it did
        // not already know.
        return {
          ok: false,
          status: bucket.isPublic ? 401 : 404,
          message: bucket.isPublic ? "this bucket needs a token" : "no such bucket",
        };
      }
      if (rootTokenMatches(options.rootToken, presented)) return { ok: true };
      const verdict = verifyToken(repo, presented, bucket.name, need, now());
      if (verdict.ok) return { ok: true };
      const message =
        verdict.reason === "expired"
          ? `that token expired on ${new Date(verdict.expiredAt).toISOString().slice(0, 10)}`
          : {
              unknown: "that token is not one this service minted",
              revoked: "that token has been revoked",
              wrong_bucket: `that token cannot reach "${bucket.name}"`,
              insufficient: `that token cannot ${need === "read" ? "read" : "write"} here`,
            }[verdict.reason];
      return { ok: false, status: 403, message };
    },

    narinfoText(bucket, hash) {
      if (!isStorePathHash(hash)) return null;
      const row = repo.objectByHash(bucket.name, hash);
      return row === null ? null : narinfoFor(bucket, row);
    },

    cacheInfoText: (bucket) => cacheInfoText(bucket),

    log: (event, fields) => options.log?.(event, fields),

    touch(bucket, hash) {
      if (!isStorePathHash(hash)) return;
      const row = repo.objectByHash(bucket.name, hash);
      if (row === null) return;
      // COUNTED, NOT RENEWED. A read moves the hit counter and nothing else:
      // retention runs on `lastWanted`, which a push and the `missing` query
      // set, because reads are leaving odu (PLAN 2.8) and a clock that is
      // about to stop ticking cannot be the one GC reads.
      repo.countRead(bucket.name, row.storePath);
      notifyReaders();
    },

    async narSource(bucket, file) {
      // THE EXTENSION NAMES THE COMPRESSION, and twins can share a NarHash with
      // different bytes: look up the pair, not the hash alone. A single row
      // still answers a client that spelled the wrong extension, because its
      // bytes are unambiguous.
      const at = file.indexOf(".nar");
      const hash = at === -1 ? file : file.slice(0, at);
      const narHash = `sha256:${hash}`;
      const compression = compressionOfFile(file);
      if (compression === null) return null;
      const row =
        repo.objectByNarHashCompression(bucket.name, narHash, compression) ??
        (() => {
          const twins = repo.objectsByNarHash(bucket.name, narHash);
          return twins.length === 1 ? (twins[0] as ObjectRow) : null;
        })();
      if (row === null) return null;
      // A KEPT ROW ALREADY KNOWS ITS OBJECT'S SIZE (`FileSize`, written when
      // the object was kept), so nothing is asked of the store before the
      // read: no HEAD, one round trip to the first byte on S3. An object that
      // is gone after all is the read's answer — null, a 404 — decided once.
      if (row.fileHash !== null && row.fileSize !== null) {
        const key = objectKey(bucket.name, narHash, row.compression);
        const objects = storeOf(bucket);
        // THE STORE HANDS OUT ITS OWN URLS (PLAN 2.8): odu has just decided
        // that this caller may read this bucket, and from here on the bytes
        // are between the client and the store. The URL expires, so a
        // private bucket's NAR is reachable for ten minutes by whoever was
        // authorised and not at all by anyone else. A store with no such
        // capability — the disk — is streamed by odu as it always was.
        if (objects.presignGet !== undefined) {
          return {
            kind: "redirect",
            storePath: row.storePath,
            size: row.fileSize,
            url: objects.presignGet(key, PRESIGN_SECONDS),
          };
        }
        return {
          kind: "object",
          storePath: row.storePath,
          size: row.fileSize,
          read: async (range) => (await objects.get(key, range))?.stream ?? null,
        };
      }
      // THE ONE-TIME TRANSITION. A row from before objects were kept has no
      // object yet (no `FileHash`); the old Nix store serves it until the boot
      // migration lands it. When that store is gone this branch is unreachable and the route
      // is a 404, not a silent dump.
      const legacy = options.legacyStore;
      if (legacy === undefined || legacy === null) return null;
      // THE OLD STORE MAY NOT HAVE IT (the upstream closure was never copied,
      // or the store is gone). A 404 is honest; a 200 whose stream errors is
      // not. One line per path, not per client retry.
      if (legacy.pathInfo !== undefined) {
        const known = await legacy.pathInfo(row.storePath).catch(() => null);
        if (known === null) {
          if (!unavailableLogged.has(row.storePath)) {
            unavailableLogged.add(row.storePath);
            options.log?.("cache.nar.unavailable", {
              bucket: bucket.name,
              path: row.storePath,
              reason: "no object and the old store does not have the path",
            });
          }
          return null;
        }
      }
      return { kind: "legacy", storePath: row.storePath, stream: legacy.dump(row.storePath) };
    },

    // The write path is `./staging`'s; this face is the one the routes speak,
    // and it is the same object either way.
    beginUpload: (bucket, file) => staging.beginUpload(bucket, file),
    beginPart: (bucket, file, index, limit, session) =>
      staging.beginPart(bucket, file, index, limit, session),
    completeUpload: (bucket, file, total, session) =>
      staging.completeUpload(bucket, file, total, session),
    async acceptNarinfo(bucket, hash, body) {
      const outcome = await staging.acceptNarinfo(bucket, hash, body);
      // A PUSH LANDED OR WAS REFUSED — the changes nobody outside the cache
      // can see, and the reason this listener exists at all. The publisher
      // diffs, so a refusal that changed nothing costs one comparison.
      notify();
      return outcome;
    },

    missing(bucket, paths) {
      const missing: string[] = [];
      const skipped: string[] = [];
      /** The paths this bucket HAS and the asker wants. */
      const wanted: string[] = [];
      for (const { path, sigs } of paths) {
        if (repo.object(bucket.name, path) !== null) {
          wanted.push(path);
          continue;
        }
        const upstream = (sigs ?? []).some((sig) => {
          const key = keyNameOf(sig);
          return key !== null && bucket.upstreamKeys.includes(key);
        });
        (upstream ? skipped : missing).push(path);
      }
      // THE QUESTION IS THE RENEWAL. A pusher asking "do you have these"
      // is a build that wants them: the paths it is about to push arrive as
      // rows with a fresh clock, and the ones already here — the whole point
      // of a cache hit — have theirs renewed by the asking. Without this, the
      // paths a CI job hits every day would expire while it kept hitting them,
      // because the hit is a `missing` answer and never a read.
      repo.want(bucket.name, wanted, now());
      return { missing, skipped };
    },

    collect: () => collectNow(repo.buckets(), true),

    pinAs: (bucket, input) => pinChecked(bucket, input, "write"),

    admin,

    // ONE `bucketStats()` for the whole snapshot: the query is a GROUP BY over
    // every object, and the default parameter would run it once per bucket — so
    // a push into a cache with B buckets would cost B full scans per publish.
    snapshot: () => {
      const counted = repo.bucketStats();
      return repo.buckets().map((bucket) => factsOf(bucket, counted));
    },

    async boot() {
      // 0. EVERY BUCKET'S STORE IS DECLARED, or the row does not mount: a
      // bucket whose objects nobody can reach would answer 404 for every path
      // it has, which reads as data loss rather than as a missing line of
      // configuration.
      for (const bucket of repo.buckets()) {
        if (!stores.has(bucket.store)) {
          return {
            ok: false as const,
            refusal: {
              kind: "undeclared_store" as const,
              bucket: bucket.name,
              store: bucket.store,
              declared: [...stores.keys()],
            },
          };
        }
      }

      // 1. CA IS PROVED FROM THE PATH. Pure and instant: no store query, no
      // pusher line. A self-reference's modulo hash comes from its bytes in 1b.
      let caProved = 0;
      for (const row of repo.objects().filter(
        (one) => one.caProof === "unknown" && !one.references.includes(one.storePath),
      )) {
        const ca = contentAddressOf({
          storePath: row.storePath,
          narHash: row.narHash,
          references: row.references,
        });
        repo.putObject({
          ...row,
          ca,
          caProof: ca === null ? "not-content-addressed" : "content-addressed",
        });
        if (ca !== null) caProved += 1;
      }
      if (caProved > 0) {
        options.log?.("cache.boot.ca", { proved: caProved });
        notify();
      }

      // 2. NOBODY IS WRITING YET: an object with no row is a crash between put
      // and record; a `.tmp-*` older than this boot is a put that died. Both
      // are swept BEFORE the mount, so the sweep cannot race a live push.
      // PER BUCKET, under its own prefix in its own store: a store may be
      // shared, and only a bucket's prefix is the cache's to sweep.
      // A BUCKET'S OBJECTS ARE THREE KINDS NOW (PLAN 2.8): the NARs, the
      // narinfo beside each one, and the bucket's own `nix-cache-info`. A
      // sweep that knew only the NARs would delete the other two every boot
      // and the backfill would write them again — a cache that fights itself.
      const owned = new Set([
        ...repo.objects().flatMap((row) => [
          objectKey(row.bucket, row.narHash, row.compression),
          narinfoKey(row.bucket, row.hash),
        ]),
        ...repo.buckets().map((bucket) => cacheInfoKey(bucket.name)),
      ]);
      let tempSwept = 0;
      let orphansSwept = 0;
      for (const bucket of repo.buckets()) {
        const objects = storeOf(bucket);
        tempSwept += await objects.sweepTemp(bucket.name, now());
        for (const object of await objects.list(bucket.name)) {
          if (owned.has(object.key)) continue;
          await objects.delete(object.key);
          orphansSwept += 1;
        }
      }
      if (orphansSwept > 0 || tempSwept > 0) {
        options.log?.("cache.boot.orphans", { swept: orphansSwept, temp: tempSwept });
      }
      return { ok: true as const, report: { caProved, orphansSwept, tempSwept } };
    },

    proveSelf() {
      const task = proveSelfNow();
      selfTask = task;
      return task;
    },

    migrate() {
      const task = migrateNow();
      migrationTask = task;
      return task;
    },

    backfillObjects() {
      const task = backfillNow();
      backfillTask = task;
      return task;
    },

    async resumeMigrations() {
      // A MOVE IS A ROW, so a restart finds the unfinished ones by reading
      // them. Each resumes from the state it reached: copying walks the keys
      // again (skipping what is already there), flipping redoes the delta and
      // the flip, deleting lets the old copies go.
      await Promise.all(repo.migrations().map((row) => startMigration(row)));
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async close() {
      // The trailing-edge timer is the cache's, so the cache ends it. A timer
      // that outlived `close()` would publish into a closed database.
      if (trailing !== null) clearTimeout(trailing);
      trailing = null;
      stopping = true;
      stopSignal.resolve();
      // JOIN the row's migration before the database closes: its in-flight put
      // may be one disk write away from a row.
      if (migrationTask !== null) await migrationTask.catch(() => {});
      if (selfTask !== null) await selfTask.catch(() => {});
      if (backfillTask !== null) await backfillTask.catch(() => {});
      // JOIN EVERY STORE-TO-STORE MOVE: each checks `stopping` between keys,
      // so this is the time its current copy takes and no more.
      await Promise.all([...storeMoves.values()].map((task) => task.catch(() => {})));
      // REFUSE THE QUEUE FIRST: a job waiting for a slot belongs to this row,
      // and none of them may start after it closed. Then join the ones already
      // running, before the database closes.
      migrationSlots.close();
      backfillSlots.close();
      moveSlots.close();
      await staging.close();
      listeners.clear();
      repo.close();
    },
  };
}

/**
 * The credential out of an `Authorization` header: `Bearer <token>`, or Basic
 * with any username and the token as the password.
 *
 * Basic is not a courtesy — it is the ONLY way Nix authenticates. `nix copy`
 * speaks it through curl on every request, uploads included, which is why a
 * cache that accepted only Bearer would be a cache no Nix client could write
 * to.
 */
/** Is this the whitespace a header can hold? Space and tab, and nothing else:
 *  a field value cannot contain CR or LF (RFC 9110 §5.5, and Node's parser
 *  rejects it before a route sees it), so the rest of `\s` is unreachable
 *  input and treating it as part of the scheme is the safe reading. */
const headerSpace = (ch: string): boolean => ch === " " || ch === "\t";

/**
 * The credential in an `Authorization` header, or null.
 *
 * Parsed by hand rather than with `/^Bearer\s+(.+)$/i`. Two adjacent
 * quantifiers over a header we do not control is a polynomial backtracking
 * hazard — a header of ten thousand spaces makes the engine try every split of
 * `\s+` against `(.+)$` — and the header is the one string on this face that
 * arrives before anything has been authenticated.
 */
function credentialOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  let at = 0;
  while (at < header.length && !headerSpace(header[at] as string)) at++;
  const scheme = header.slice(0, at).toLowerCase();
  if (at === header.length) return null; // a scheme with no whitespace after it
  let payloadAt = at;
  while (payloadAt < header.length && headerSpace(header[payloadAt] as string)) payloadAt++;
  const payload = header.slice(payloadAt).trim();
  if (scheme === "bearer") return payload;
  if (scheme !== "basic") return null;
  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64").toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  return colon === -1 ? null : decoded.slice(colon + 1);
}
