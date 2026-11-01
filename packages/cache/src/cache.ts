/**
 * THE CACHE — the buckets, their keys, and the two faces over them.
 *
 * Two faces over one object, and they are deliberately in one module because
 * they must agree about one thing: what a bucket IS. The protocol face is what
 * a Nix client speaks (`./routes`); the admin face is what `odu cache` reaches
 * through the service. Between them sit the rows (`./db`), the tokens
 * (`./tokens`), the collector (`./gc`), the object store (`./objectStore`) and
 * the one-time migration.
 *
 * The WRITE PATH is not here: staging an upload, proving it and keeping the
 * object moves on the Nix protocol's clock rather than on the product's, and it
 * lives in `./staging`. This module hands it one dependency — `record` —
 * because a pin and a collection take the same write lock, and a second lock
 * there would be a second answer to "who may change what is retained".
 *
 * **The root token is a field, not a file.** `rootToken` arrives from the
 * composition root, which reads `$ODU_ROOT_TOKEN`. There is no fallback to a
 * file on disk and no "first run mints one": a cache that administers itself on
 * first contact is a cache anybody on the machine can create buckets in.
 */

import { statfs } from "node:fs/promises";
import { join } from "node:path";
import type { BucketRow, BucketTotals, ObjectRow, Scope, TokenRow } from "./db";
import { cursorFor, openCacheRepo } from "./db";
import { planGc, runGc, type GcReport } from "./gc";
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
  compressionExtension,
  signFingerprint,
  storePathHash,
} from "./narinfo";
import { newChain, serial } from "./serial";
import { CACHE_MOUNT } from "./paths";
import { PATH_PAGE_SIZE } from "./surface";
import {
  createStaging,
  objectKey,
  type CompleteUpload,
  type NarinfoOutcome,
  type Upload,
} from "./staging";
import { diskObjectStore, type ObjectStore } from "./objectStore";
import { contentAddressOf } from "./storePath";
import { verifyNarFile } from "./store";
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
}

export interface CacheStats {
  buckets: readonly BucketFacts[];
  objects: number;
  bytes: number;
  hits: number;
  lastAccessed: number | null;
}

/** Why an admin call was refused. The service maps these onto its own refusal
 *  codes; the package does not import the contract. */
export type CacheRefusalCode =
  | "no_root_token"
  | "unknown_bucket"
  | "bucket_exists"
  | "bad_input";

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
  pin(input: { authority: Authority;
    bucket: string;
    name: string;
    paths: readonly string[];
  }): Promise<CacheOutcome<PinFacts>>;
  gc(input: { authority: Authority; bucket: string | null }): Promise<CacheOutcome<GcReport>>;
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
  lastAccessed: number;
}

/** The verdict on a presented credential. `status` is what the route answers
 *  with: 401 for "who are you", 403 for "not with that token", and 404 for an
 *  anonymous read of a PRIVATE bucket — a 401 there would confirm the bucket
 *  exists, which is exactly what a private name must not leak. */
export type AuthVerdict = { ok: true } | { ok: false; status: 401 | 403 | 404; message: string };

export type NarSource =
  | { kind: "file"; storePath: string; path: string; size: number }
  | { kind: "stream"; storePath: string; stream: ReadableStream<Uint8Array>; size: number }
  /** THE ONE-TIME MIGRATION: the old Nix store still has this row's path and
   *  its object has not been produced yet. Removed when that store is. */
  | { kind: "legacy"; storePath: string; stream: ReadableStream<Uint8Array> };

/** What one boot's SYNCHRONOUS work found: before mount, no pushes can race. */
export interface BootReport {
  /** Rows whose path proved its own `fixed:r:sha256` CA. */
  caProved: number;
  /** Object files with no row (a crash between put and record). */
  orphansSwept: number;
  /** Abandoned `.tmp-*` files older than this boot. */
  tempSwept: number;
}

/** What the one-time self-CA pass found. */
export interface SelfProofReport {
  rows: number;
  proved: number;
  refused: number;
  unreadable: number;
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
  /** The admin face. */
  admin: CacheAdmin;
  /** BEFORE MOUNT: prove `CA:`, sweep orphan objects and abandoned temp files.
   *  Nothing is writing yet, so a sweep cannot race a put. */
  boot(): Promise<BootReport>;
  /** AFTER MOUNT, AS A ROW-OWNED BACKGROUND TASK: prove self-referencing rows
   *  from their kept bytes, ONCE per row (the verdict is persisted). */
  proveSelf(): Promise<SelfProofReport>;
  /** AFTER MOUNT, AS A ROW-OWNED BACKGROUND TASK: migrate objects the old store
   *  still owns, two at a time, resuming after a disk pause. */
  migrate(): Promise<MigrationReport>;
  /** Join the row's background work, then close the database. */
  close(): Promise<void>;
}

export interface CacheOptions {
  /** The per-user state root; the cache owns `<stateRoot>/cache`. */
  stateRoot: string;
  /** `$ODU_ROOT_TOKEN`, or null when the operator supplied none. */
  rootToken: string | null;
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
  /** Injected by the suite; production is the disk under the cache's dir. */
  objects?: ObjectStore;
  now?: () => number;
  /** ONE structured line per operational fact (serve, import, boot, refusal).
   *  The row hands the daemon's logger here; a suite that does not care omits
   *  it. No per-chunk lines: a NAR read is one line. */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** The floor between two READ-driven publications. Reads are the only change
 *  that arrives thousands of times a minute, and a hit count that moved a second
 *  ago is as true for a reader as one that moved a millisecond ago. */
export const HITS_REFRESH_MS = 1000;

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
  const objects = options.objects ?? diskObjectStore({ dir });

  /**
   * ONE writer at a time, across `record`, `pin` and `gc`.
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
      url: `nar/${row.narHash.replace(/^sha256:/, "")}.${compressionExtension(row.compression)}`,
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

  /** Record an imported path. Idempotent: a re-pushed path refreshes its row
   *  rather than duplicating, and keeps its hit count.
   *
   * The signature the BUCKET made is not stored — it is computed at read — so
   * the row holds only the CLIENT's signatures, deduplicated by full
   * `name:base64` string: Nix hands the same signature back from
   * `path-info` that it took from the narinfo, and a row with it twice would
   * put it twice in every answer.
   */
  function record(
    bucket: BucketRow,
    info: NarInfo,
    file: { fileHash: string; fileSize: number },
    selfHash: string | null,
  ): Promise<boolean> {
    return withWriteLock(() => recordNow(bucket, info, file, selfHash));
  }

  async function recordNow(
    bucket: BucketRow,
    info: NarInfo,
    file: { fileHash: string; fileSize: number },
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
      // A re-push is an access: the pusher wants the path to stay.
      lastAccessed: at,
    });
    return true;
  }

  // The write path, wired to the ONE lock: `record` is the dependency staging
  // takes, and it is the locked one, so a pin cannot interleave with a record.
  const staging = createStaging({
    objects,
    dir,
    now,
    record,
    log: options.log,
    recorded(bucket, narHash, compression) {
      const row = repo.objectByNarHashCompression(bucket.name, narHash, compression);
      return row === null || row.fileHash === null || row.fileSize === null
        ? null
        : { fileHash: row.fileHash, fileSize: row.fileSize };
    },
  });
  /** THE MIGRATION'S THROTTLE: two old-store dumps at a time, never more. */
  const migrationSlots = createSlots(2);
  /** Paths whose transition serve was refused, logged once each. */
  const unavailableLogged = new Set<string>();
  /** The row's background migration, so close can join it before the DB goes. */
  let migrationTask: Promise<MigrationReport> | null = null;
  let selfTask: Promise<SelfProofReport> | null = null;
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
      };
      repo.putBucket(bucket);
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

    async pin(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      if (input.name.trim() === "") {
        return { ok: false, code: "bad_input", message: "a pin needs a name, e.g. release-1.2" };
      }
      if (input.paths.length === 0) {
        return { ok: false, code: "bad_input", message: "a pin needs at least one path" };
      }
      return withWriteLock(() => pinNow(bucket, input));
    },

    async gc(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const buckets =
        input.bucket === null
          ? repo.buckets()
          : [repo.bucket(input.bucket)].filter((row): row is BucketRow => row !== null);
      if (input.bucket !== null && buckets.length === 0) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      // The whole collection — plan, release, delete — under the one write
      // lock, so a pin or a re-push cannot land between the plan and the
      // delete and lose a path it had just promised to keep.
      return withWriteLock(async () => {
        const plan = planGc({
          buckets,
          objects: repo.objects(),
          pins: repo.pins(),
          now: now(),
        });
        const report = await runGc(repo, plan, objects);
        // Every bucket the sweep touched answers a different object count now.
        notify();
        return { ok: true as const, value: report };
      });
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
            lastAccessed: row.lastAccessed,
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

  async function pinNow(
    bucket: BucketRow,
    input: { name: string; paths: readonly string[] },
  ): Promise<CacheOutcome<PinFacts>> {
    // THE CLOSURE IS THE BUCKET'S OWN ROWS: a pin holds what this cache
    // serves, so the references are followed in the metadata, not asked of a
    // Nix store the server no longer has.
    const rows = new Map(repo.objects(bucket.name).map((row) => [row.storePath, row]));
    const reached = new Set<string>();
    const queue = [...input.paths];
    while (queue.length > 0) {
      const path = queue.pop() as string;
      if (reached.has(path)) continue;
      const row = rows.get(path);
      if (row === undefined) continue;
      reached.add(path);
      for (const reference of row.references) {
        const full = reference.startsWith("/nix/store/") ? reference : `/nix/store/${reference}`;
        queue.push(full);
      }
    }
    const absent = input.paths.filter((path) => !reached.has(path));
    if (absent.length > 0) {
      return {
        ok: false,
        code: "bad_input",
        message: `no such path in the bucket: ${absent.join(", ")}`,
      };
    }
    const created = now();
    repo.putPin({
      bucket: bucket.name,
      name: input.name,
      rootPaths: [...reached],
      created,
    });
    // A pin changes `pinnedPaths`, which is a column of the bucket's row — so
    // this is the third mutator that NOTIFIES, beside create and gc.
    notify();
    return {
      ok: true,
      value: { bucket: bucket.name, name: input.name, rootPaths: [...reached], created },
    };
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
        const path = objects.localPath(objectKey(row.bucket, row.narHash, row.compression));
        if (path === null) {
          unreadable += 1;
          continue;
        }
        const checked = await Promise.race([
          verifyNarFile(path, row.compression, storePathHash(row.storePath)),
          stopSignal.promise.then(() => null),
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
          // A READ, not an empty put: a put racing a delete would store 0 bytes.
          const stored = await objects.facts(key);
          if (stored !== null) {
            repo.putObject({ ...row, fileHash: stored.sha256, fileSize: stored.size });
            migrated += 1;
            return;
          }
          const dump = legacy.dump(row.storePath);
          const writing = migrationSlots.withSlot(() =>
            objects.put(objectKey(row.bucket, row.narHash, row.compression), dump),
          );
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
          repo.putObject({ ...row, fileHash: facts.sha256, fileSize: facts.size });
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

    log: (event, fields) => options.log?.(event, fields),

    touch(bucket, hash) {
      if (!isStorePathHash(hash)) return;
      const row = repo.objectByHash(bucket.name, hash);
      if (row === null) return;
      repo.touchObject(bucket.name, row.storePath, now());
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
      const key = objectKey(bucket.name, narHash, row.compression);
      const size = await objects.head(key);
      if (size !== null) {
        const path = objects.localPath(key);
        if (path !== null) return { kind: "file", storePath: row.storePath, path, size };
        const object = await objects.get(key);
        if (object !== null) {
          return { kind: "stream", storePath: row.storePath, stream: object.stream, size };
        }
      }
      // THE ONE-TIME TRANSITION. A row from before objects were kept has no
      // object yet; the old Nix store serves it until the boot migration lands
      // it. When that store is gone this branch is unreachable and the route
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
      for (const { path, sigs } of paths) {
        if (repo.object(bucket.name, path) !== null) continue;
        const upstream = (sigs ?? []).some((sig) => {
          const key = keyNameOf(sig);
          return key !== null && bucket.upstreamKeys.includes(key);
        });
        (upstream ? skipped : missing).push(path);
      }
      return { missing, skipped };
    },

    admin,

    // ONE `bucketStats()` for the whole snapshot: the query is a GROUP BY over
    // every object, and the default parameter would run it once per bucket — so
    // a push into a cache with B buckets would cost B full scans per publish.
    snapshot: () => {
      const counted = repo.bucketStats();
      return repo.buckets().map((bucket) => factsOf(bucket, counted));
    },

    async boot() {
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
      const tempSwept = (await objects.sweepTemp?.(now())) ?? 0;
      const owned = new Set(
        repo.objects().map((row) => objectKey(row.bucket, row.narHash, row.compression)),
      );
      let orphansSwept = 0;
      for (const object of await objects.list("")) {
        if (owned.has(object.key)) continue;
        await objects.delete(object.key);
        orphansSwept += 1;
      }
      if (orphansSwept > 0 || tempSwept > 0) {
        options.log?.("cache.boot.orphans", { swept: orphansSwept, temp: tempSwept });
      }
      return { caProved, orphansSwept, tempSwept };
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
      // REFUSE THE QUEUE FIRST: a job waiting for a slot belongs to this row,
      // and none of them may start after it closed. Then join the ones already
      // running, before the database closes.
      migrationSlots.close();
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
