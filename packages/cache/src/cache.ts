/**
 * THE CACHE — the buckets, their keys, and the two faces over them.
 *
 * Two faces over one object, and they are deliberately in one module because
 * they must agree about one thing: what a bucket IS. The protocol face is what
 * a Nix client speaks (`./routes`); the admin face is what `odu cache` reaches
 * through the service. Between them sit the rows (`./db`), the tokens
 * (`./tokens`), the collector (`./gc`) and the blob store (`./store`).
 *
 * The WRITE PATH is not here: staging an upload, proving it and importing it
 * in order moves on the Nix protocol's clock rather than on the product's, and
 * it lives in `./staging`. This module hands it one dependency — `record` —
 * because a pin and a collection take the same write lock, and a second lock
 * there would be a second answer to "who may change what is retained".
 *
 * **The root token is a field, not a file.** `rootToken` arrives from the
 * composition root, which reads `$ODU_ROOT_TOKEN`. There is no fallback to a
 * file on disk and no "first run mints one": a cache that administers itself on
 * first contact is a cache anybody on the machine can create buckets in.
 */

import { join } from "node:path";
import { type BlobStore, nixStore } from "./store";
import type { BucketRow, BucketTotals, ObjectRow, Scope, TokenRow } from "./db";
import { cursorFor, openCacheRepo } from "./db";
import { planGc, runGc, type GcReport } from "./gc";
import {
  fingerprintOf,
  formatNarinfo,
  generateKeypair,
  isStorePathHash,
  keyNameOf,
  type NarInfo,
  SERVED_EXTENSION,
  signFingerprint,
  storePathHash,
} from "./narinfo";
import { newChain, serial } from "./serial";
import { CACHE_MOUNT } from "./paths";
import { PATH_PAGE_SIZE } from "./surface";
import { createStaging, type NarinfoOutcome, type Upload } from "./staging";
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

export interface Cache {
  /** The protocol face. */
  bucket(name: string): BucketRow | null;
  authorize(header: string | undefined, bucket: BucketRow, need: Scope): AuthVerdict;
  narinfoText(bucket: BucketRow, hash: string): string | null;
  touch(bucket: BucketRow, hash: string): void;
  narStream(bucket: BucketRow, file: string): Promise<ReadableStream<Uint8Array> | null>;
  beginUpload(bucket: BucketRow, file: string): Promise<Upload>;
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
  close(): void;
}

export interface CacheOptions {
  /** The per-user state root; the cache owns `<stateRoot>/cache`. */
  stateRoot: string;
  /** `$ODU_ROOT_TOKEN`, or null when the operator supplied none. */
  rootToken: string | null;
  /** `--store` URI for every nix call; null is the daemon. */
  store: string | null;
  /** Injected by the suite; production uses the Nix store. */
  blob?: BlobStore;
  now?: () => number;
}

/** The floor between two READ-driven publications. Reads are the only change
 *  that arrives thousands of times a minute, and a hit count that moved a second
 *  ago is as true for a reader as one that moved a millisecond ago. */
export const HITS_REFRESH_MS = 1000;

/** A bucket name is a path segment on the wire, so it is a DNS-ish label and
 *  nothing else: lowercase, digits, dashes. A name with a `/` in it would be a
 *  second route, and one with a `.` would collide with `<hash>.narinfo`. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function createCache(options: CacheOptions): Cache {
  const now = options.now ?? (() => Date.now());
  const dir = join(options.stateRoot, "cache");
  const repo = openCacheRepo(join(dir, "cache.sqlite"));
  const blob =
    options.blob ??
    nixStore({ gcrootsRoot: join(dir, "gcroots"), store: options.store });

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
      url: `nar/${row.narHash.replace(/^sha256:/, "")}.${SERVED_EXTENSION}`,
      compression: "zstd",
      fileHash: null,
      fileSize: null,
      narHash: row.narHash,
      narSize: row.narSize,
      references: row.references,
      deriver: row.deriver,
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
    storePath: string,
    expectedNarHash: string,
    clientSigs: readonly string[],
  ): Promise<boolean> {
    return withWriteLock(() => recordNow(bucket, storePath, expectedNarHash, clientSigs));
  }

  async function recordNow(
    bucket: BucketRow,
    storePath: string,
    expectedNarHash: string,
    clientSigs: readonly string[],
  ): Promise<boolean> {
    const info = await blob.pathInfo(storePath);
    if (info === null) {
      throw new Error(`imported ${storePath} but the store does not know it`);
    }
    // Defence in depth: the bytes were hashed before the import, and this is
    // the store agreeing afterwards.
    if (info.narHash !== expectedNarHash) {
      throw new Error(
        `${storePath} is ${info.narHash} in the store but the narinfo said ${expectedNarHash}`,
      );
    }
    const existing = repo.object(bucket.name, storePath);
    const at = now();
    const sigs = [...new Set([...clientSigs, ...info.sigs])].filter(
      (sig) => keyNameOf(sig) !== bucket.keyName,
    );
    repo.putObject({
      bucket: bucket.name,
      storePath,
      hash: storePathHash(storePath),
      narHash: info.narHash,
      narSize: info.narSize,
      references: info.references,
      deriver: info.deriver,
      sigs,
      hits: existing?.hits ?? 0,
      created: existing?.created ?? at,
      // A re-push is an access: the pusher wants the path to stay.
      lastAccessed: at,
    });
    // The root is what keeps the machine's own GC from eating a path the cache
    // serves; without it the first `nix-collect-garbage` empties the bucket.
    await blob.retain(bucket.name, storePath);
    return true;
  }

  // The write path, wired to the ONE lock: `record` is the dependency staging
  // takes, and it is the locked one, so a pin cannot interleave with an import.
  const staging = createStaging({ repo, blob, dir, now, record });

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
        },
      };
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
        const report = await runGc(blob, repo, plan);
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
    // ONE `nix path-info -r` for the whole closure, not one process per path.
    const closure = await blob.closure(input.paths);
    const reached = new Set(closure.map((info) => info.storePath));
    const absent = input.paths.filter((path) => !reached.has(path));
    if (absent.length > 0) {
      return {
        ok: false,
        code: "bad_input",
        message: `no such path in the store: ${absent.join(", ")}`,
      };
    }
    const created = now();
    repo.putPin({
      bucket: bucket.name,
      name: input.name,
      rootPaths: [...reached],
      created,
    });
    // Every path a pin holds must be rooted in the store, or the machine's own
    // GC deletes the pin out from under the cache.
    for (const path of reached) await blob.retain(bucket.name, path);
    // A pin changes `pinnedPaths`, which is a column of the bucket's row — so
    // this is the third mutator that NOTIFIES, beside create and gc, rather
    // than one the surface has to remember to publish for.
    notify();
    return {
      ok: true,
      value: { bucket: bucket.name, name: input.name, rootPaths: [...reached], created },
    };
  }

  return {
    bucket: (name) => repo.bucket(name),

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
      const message = {
        unknown: "that token is not one this service minted",
        revoked: "that token has been revoked",
        expired: "that token has expired",
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

    touch(bucket, hash) {
      if (!isStorePathHash(hash)) return;
      const row = repo.objectByHash(bucket.name, hash);
      if (row === null) return;
      repo.touchObject(bucket.name, row.storePath, now());
      notifyReaders();
    },

    async narStream(bucket, file) {
      // `nar/<hash>.nar.zst` and `nar/<hash>.nar.xz` are the same object; the
      // extension is the CLIENT's compression choice and odu always serves
      // zstd, so only the hash part is looked up.
      const at = file.indexOf(".nar");
      const hash = at === -1 ? file : file.slice(0, at);
      const row = repo.objectByNarHash(bucket.name, `sha256:${hash}`);
      return row === null ? null : blob.dump(row.storePath);
    },

    // The write path is `./staging`'s; this face is the one the routes speak,
    // and it is the same object either way.
    beginUpload: (bucket, file) => staging.beginUpload(bucket, file),
    async acceptNarinfo(bucket, hash, body) {
      const outcome = await staging.acceptNarinfo(bucket, hash, body);
      // A PUSH LANDED — the one change nobody outside the cache can see, and
      // the reason this listener exists at all.
      if (outcome.ok) notify();
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

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    close() {
      // The trailing-edge timer is the cache's, so the cache ends it. A timer
      // that outlived `close()` would publish into a closed database.
      if (trailing !== null) clearTimeout(trailing);
      trailing = null;
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
