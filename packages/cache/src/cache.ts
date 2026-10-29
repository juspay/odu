/**
 * THE CACHE — one bucket namespace, its protocol operations, and its admin.
 *
 * Two faces over one object, and they are deliberately in one module because
 * they must agree about one thing: what a bucket IS. The protocol face is what
 * a Nix client speaks (`./routes`); the admin face is what `odu cache` reaches
 * through the service. Between them sit the blob store (`./store`), the rows
 * (`./db`), the tokens (`./tokens`) and the collector (`./gc`).
 *
 * **The root token is a field, not a file.** `rootToken` arrives from the
 * composition root, which reads `$ODU_ROOT_TOKEN`. There is no fallback to a
 * file on disk and no "first run mints one": a cache that administers itself on
 * first contact is a cache anybody on the machine can create buckets in.
 *
 * **An upload is PROVED before it is believed.** The staged pair is a
 * `file://` cache — `nar/<file>` and `<hash>.narinfo`, the layout the client
 * would have written — and `nix copy --from file://<dir>` imports it. But Nix
 * only verifies the NarHash when it actually fetches, and it fetches NOTHING
 * when the path is already valid in the destination store: it copies zero
 * paths and exits 0. On a single machine — where the cache's store is the
 * host's — that is the normal case, so "Nix verified it" is true exactly when
 * it does not matter. So {@link verifyNarFile} hashes the uploaded NAR against
 * the narinfo's `NarHash` BEFORE any import is attempted. Without that, a
 * write token for any bucket could publish any path the store happens to hold,
 * including another bucket's private ones, with a narinfo alone.
 *
 * **A failed import is not a 200.** The narinfo PUT answers 200 only when the
 * path is recorded, 202 when it is waiting on a reference that has not arrived
 * (an ordering fact, not an error — `nix copy --to` may send a closure in any
 * order), and 400 with Nix's own sentence for everything else.
 *
 * **Staging is swept by FILE, and only when nothing is writing.** A client
 * killed between the two PUTs leaves a NAR that nothing will name; an in-flight
 * upload must not be swept out from under its writer.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type BlobStore,
  nixStore,
  verifyNarFile,
  writeStreamToFile,
} from "./store";
import type { BucketRow, CacheRepo, ObjectRow, Scope, TokenRow } from "./db";
import { openCacheRepo } from "./db";
import { planGc, runGc, type GcReport } from "./gc";
import {
  fingerprintOf,
  formatNarinfo,
  generateKeypair,
  isStagedFileName,
  isStorePathHash,
  type NarInfo,
  parseNarinfo,
  signFingerprint,
  storePathHash,
} from "./narinfo";
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

/** The admin face, structurally the service's `CacheAdmin` port. */
export interface CacheAdmin {
  create(input: {
    rootToken: string;
    name: string;
    public: boolean;
    retentionDays: number;
    upstreamKeys: readonly string[];
  }): Promise<CacheOutcome<BucketFacts>>;
  list(input: { rootToken: string }): Promise<CacheOutcome<readonly BucketFacts[]>>;
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
  describe(input: { bucket: string }): Promise<CacheOutcome<BucketFacts>>;
  tokenMint(input: {
    rootToken: string;
    bucket: string;
    /** A glob, so one token can cover `team-*`. Absent means the bucket. */
    bucketGlob: string | null;
    scope: Scope;
    expiresDays: number | null;
  }): Promise<CacheOutcome<TokenMinted>>;
  tokenList(input: {
    rootToken: string;
    bucket: string | null;
  }): Promise<CacheOutcome<readonly TokenFacts[]>>;
  tokenRevoke(input: {
    rootToken: string;
    id: string;
  }): Promise<CacheOutcome<{ id: string; revoked: boolean }>>;
  pin(input: {
    rootToken: string;
    bucket: string;
    name: string;
    paths: readonly string[];
  }): Promise<CacheOutcome<PinFacts>>;
  gc(input: { rootToken: string; bucket: string | null }): Promise<CacheOutcome<GcReport>>;
  stats(input: { rootToken: string }): Promise<CacheOutcome<CacheStats>>;
}

/** The verdict on a presented credential. `status` is what the route answers
 *  with: 401 for "who are you", 403 for "not with that token", and 404 for an
 *  anonymous read of a PRIVATE bucket — a 401 there would confirm the bucket
 *  exists, which is exactly what a private name must not leak. */
export type AuthVerdict = { ok: true } | { ok: false; status: 401 | 403 | 404; message: string };

/** A write in progress. `commit` publishes it under the name the narinfo will
 *  name; `discard` removes it. */
export interface Upload {
  write(chunk: Uint8Array): Promise<void>;
  commit(): Promise<void>;
  discard(): Promise<void>;
}

/** What a narinfo PUT came to. `status` is the answer the route sends. */
export type NarinfoOutcome =
  /** Recorded: the bucket serves this path. */
  | { ok: true; status: 200; storePath: string }
  /** Accepted, but waiting on references that are not in the store yet. */
  | { ok: true; status: 202; storePath: string; missing: readonly string[] }
  /** Refused, with the sentence to put in the body. */
  | { ok: false; status: 400; message: string };

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

/** `StoreDir`, `WantMassQuery` and `Priority` — the three lines every Nix
 *  client reads first, and the reason a bucket answers `nix-cache-info` at all. */
export const NIX_CACHE_INFO = "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n";

/** A bucket name is a path segment on the wire, so it is a DNS-ish label and
 *  nothing else: lowercase, digits, dashes. A name with a `/` in it would be a
 *  second route, and one with a `.` would collide with `<hash>.narinfo`. */
export const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** How long a staged upload nobody finished survives. */
const STAGE_TTL_MS = 60 * 60 * 1000;

/** How often the staging directory is swept. Sweeping on every upload would be
 *  a readdir of every bucket on every PUT. */
const SWEEP_EVERY_MS = 60 * 1000;

/** The narinfo `Compression` and URL extension odu serves. Reads are zstd on
 *  the fly; writes accept whatever a client sent. */
const SERVED_EXTENSION = "nar.zst";

/** One staged narinfo waiting for its turn, and what it is waiting on. */
interface Pending {
  hash: string;
  info: NarInfo;
  /** References Nix said were not valid. Empty means "not attempted yet". */
  waitingOn: readonly string[];
}

export function createCache(options: CacheOptions): Cache {
  const now = options.now ?? (() => Date.now());
  const dir = join(options.stateRoot, "cache");
  const stagingRoot = join(dir, "staging");
  const repo = openCacheRepo(join(dir, "cache.sqlite"));
  const blob =
    options.blob ??
    nixStore({ gcrootsRoot: join(dir, "gcroots"), store: options.store });

  const stagedDir = (bucket: string): string => join(stagingRoot, bucket);

  /** Uploads with an open file handle, by absolute path. The sweep must not
   *  delete one, and `commit` must not lose one. */
  const openUploads = new Set<string>();
  /** One drain at a time per bucket: two narinfo PUTs for one bucket must not
   *  import, unlink and record the same staged pair concurrently. */
  const drains = new Map<string, Promise<void>>();
  /** The staged narinfos this process knows about, by bucket then by hash. */
  const pending = new Map<string, Map<string, Pending>>();
  let lastSweep = 0;

  function requireRoot(rootToken: string): CacheOutcome<null> {
    if (!rootTokenMatches(options.rootToken, rootToken)) {
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
    counted: Map<string, { objects: number; bytes: number }> = repo.bucketStats(),
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
  async function record(
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
      (sig) => sig.slice(0, sig.indexOf(":")) !== bucket.keyName,
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

  /**
   * THE INVARIANT THE PRIVATE-BUCKET STORY RESTS ON: a narinfo is imported
   * only when the NAR it names is present in THIS bucket's staging directory
   * and hashes to the `NarHash` it claims.
   *
   * Without it, `nix copy --from` answers "0 paths copied, exit 0" for a path
   * already valid in the destination store — never opening the NAR — so a
   * token for one bucket could publish any path the server's store holds.
   */
  async function provedStagedNar(
    dirForBucket: string,
    info: NarInfo,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const name = basename(info.url);
    if (!isStagedFileName(name)) {
      return { ok: false, message: `narinfo names ${info.url}, which is not a NAR this cache staged` };
    }
    const path = join(dirForBucket, "nar", name);
    const present = await stat(path).catch(() => null);
    if (present === null) {
      return {
        ok: false,
        message: `the narinfo names ${info.url}, which was never uploaded to this bucket`,
      };
    }
    const checked = await verifyNarFile(path, info.compression);
    if (!checked.ok) {
      return { ok: false, message: `${info.url}: ${checked.message}` };
    }
    if (checked.narHash !== info.narHash) {
      return {
        ok: false,
        message:
          `${info.url} hashes to ${checked.narHash} but the narinfo says ` +
          `${info.narHash} — the upload was truncated or corrupted`,
      };
    }
    return { ok: true };
  }

  /** The staged narinfos this process knows about, loaded once from disk. A
   *  restart must not lose an upload that was merely early. */
  async function ensurePending(bucket: BucketRow): Promise<Map<string, Pending>> {
    const known = pending.get(bucket.name);
    if (known !== undefined) return known;
    const map = new Map<string, Pending>();
    pending.set(bucket.name, map);
    const dirForBucket = stagedDir(bucket.name);
    for (const file of await readdir(dirForBucket).catch(() => [] as string[])) {
      if (!file.endsWith(".narinfo")) continue;
      const hash = file.slice(0, -".narinfo".length);
      try {
        const info = parseNarinfo(await readFile(join(dirForBucket, file), "utf8"));
        // `waitingOn: []` means "never attempted", which is exactly right for a
        // narinfo this process did not see arrive.
        map.set(hash, { hash, info, waitingOn: [] });
      } catch {
        await unlink(join(dirForBucket, file)).catch(() => {});
      }
    }
    return map;
  }

  /** One import, and the row that follows it. */
  async function attempt(
    bucket: BucketRow,
    dirForBucket: string,
    entry: Pending,
  ): Promise<"recorded" | { missing: readonly string[] } | { failed: string }> {
    const proved = await provedStagedNar(dirForBucket, entry.info);
    if (!proved.ok) return { failed: proved.message };
    const outcome = await blob.import({ dir: dirForBucket, storePath: entry.info.storePath });
    if (!outcome.ok) {
      return outcome.missing.length > 0 ? { missing: outcome.missing } : { failed: outcome.message };
    }
    await record(bucket, entry.info.storePath, entry.info.narHash, entry.info.sigs);
    return "recorded";
  }

  /** Is the staged NAR named by `url` still wanted by some OTHER staged
   *  narinfo? Two store paths with identical content share one NAR file, so
   *  the first import must not take the file the second still needs. */
  function narStillWanted(map: Map<string, Pending>, url: string, except: string): boolean {
    const name = basename(url);
    for (const [hash, entry] of map) {
      if (hash === except) continue;
      if (basename(entry.info.url) === name) return true;
    }
    return false;
  }

  /**
   * Import what can be imported, ONE AT A TIME per bucket, and only the
   * narinfos a newly-valid path can unblock.
   *
   * `seed` names the store paths whose validity just changed. A pass imports
   * those, then anything that was waiting on a path that pass recorded, until
   * nothing new becomes importable — so a closure arriving out of order
   * settles in one call and costs one `nix copy` per path, not one per path
   * per PUT.
   */
  async function drain(bucket: BucketRow, seed: readonly string[]): Promise<void> {
    const map = await ensurePending(bucket);
    const dirForBucket = stagedDir(bucket.name);
    await mkdir(dirForBucket, { recursive: true, mode: 0o700 });
    await writeFile(join(dirForBucket, "nix-cache-info"), NIX_CACHE_INFO).catch(() => {});

    let changed = [...seed];
    while (changed.length > 0) {
      const candidates = [...map.values()].filter((entry) =>
        entry.waitingOn.length === 0
          ? changed.includes(entry.info.storePath) || seed.includes(entry.info.storePath)
          : entry.waitingOn.some((reference) => changed.includes(reference)),
      );
      if (candidates.length === 0) return;
      const recorded: string[] = [];
      for (const entry of candidates) {
        const result = await attempt(bucket, dirForBucket, entry);
        if (result === "recorded") {
          map.delete(entry.hash);
          const staged = join(dirForBucket, "nar", basename(entry.info.url));
          if (!narStillWanted(map, entry.info.url, entry.hash)) {
            await unlink(staged).catch(() => {});
          }
          await unlink(join(dirForBucket, `${entry.hash}.narinfo`)).catch(() => {});
          recorded.push(entry.info.storePath);
          continue;
        }
        if ("missing" in result) {
          entry.waitingOn = result.missing;
          continue;
        }
        // A refusal is the client's: the bytes never came, or they were wrong.
        // Drop it so it cannot be retried forever, and let the PUT answer 400.
        map.delete(entry.hash);
        await unlink(join(dirForBucket, `${entry.hash}.narinfo`)).catch(() => {});
      }
      changed = recorded;
    }
  }

  /** One drain at a time per bucket. */
  function queuedDrain(bucket: BucketRow, seed: readonly string[]): Promise<void> {
    const previous = drains.get(bucket.name) ?? Promise.resolve();
    const next = previous.then(
      () => drain(bucket, seed),
      () => drain(bucket, seed),
    );
    drains.set(
      bucket.name,
      next.catch(() => {}),
    );
    return next;
  }

  /** Remove staged FILES older than an hour — a client that died between the
   *  NAR PUT and the narinfo PUT leaves one behind every time.
   *
   * Per file, not per directory: `nar/` is a directory whose own mtime says
   * nothing about the uploads inside it, and removing it would take an upload
   * in progress with it. Open uploads are skipped outright. */
  async function sweepStaging(): Promise<void> {
    if (now() - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = now();
    const cutoff = now() - STAGE_TTL_MS;
    for (const bucket of await readdir(stagingRoot).catch(() => [] as string[])) {
      const dirForBucket = join(stagingRoot, bucket);
      for (const sub of ["", "nar"]) {
        const at = sub === "" ? dirForBucket : join(dirForBucket, sub);
        for (const entry of await readdir(at).catch(() => [] as string[])) {
          const path = join(at, entry);
          if (openUploads.has(path)) continue;
          const info = await stat(path).catch(() => null);
          if (info === null || !info.isFile() || info.mtimeMs >= cutoff) continue;
          await rm(path, { force: true }).catch(() => {});
        }
      }
    }
  }

  const admin: CacheAdmin = {
    async create(input) {
      const root = requireRoot(input.rootToken);
      if (!root.ok) return root;
      if (!BUCKET_NAME.test(input.name)) {
        return {
          ok: false,
          code: "bad_input",
          message: `"${input.name}" is not a bucket name — lowercase letters, digits and dashes`,
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
      return { ok: true, value: factsOf(bucket) };
    },

    async list(input) {
      const root = requireRoot(input.rootToken);
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
      return { ok: true, value: factsOf(bucket) };
    },

    async tokenMint(input) {
      const root = requireRoot(input.rootToken);
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
      const root = requireRoot(input.rootToken);
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
      const root = requireRoot(input.rootToken);
      if (!root.ok) return root;
      const revoked = repo.setTokenRevoked(input.id, true);
      if (!revoked) {
        return { ok: false, code: "bad_input", message: `no token "${input.id}"` };
      }
      return { ok: true, value: { id: input.id, revoked: true } };
    },

    async pin(input) {
      const root = requireRoot(input.rootToken);
      if (!root.ok) return root;
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      if (input.paths.length === 0) {
        return { ok: false, code: "bad_input", message: "a pin needs at least one path" };
      }
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
      // Every path a pin holds must be rooted in the store, or the machine's
      // own GC deletes the pin out from under the cache.
      for (const path of reached) await blob.retain(bucket.name, path);
      return {
        ok: true,
        value: { bucket: bucket.name, name: input.name, rootPaths: [...reached], created },
      };
    },

    async gc(input) {
      const root = requireRoot(input.rootToken);
      if (!root.ok) return root;
      const buckets =
        input.bucket === null
          ? repo.buckets()
          : [repo.bucket(input.bucket)].filter((row): row is BucketRow => row !== null);
      if (input.bucket !== null && buckets.length === 0) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      const plan = planGc({
        buckets,
        objects: repo.objects(),
        pins: repo.pins(),
        now: now(),
      });
      return { ok: true, value: await runGc(blob, repo, plan, now()) };
    },

    async stats(input) {
      const root = requireRoot(input.rootToken);
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
      if (row !== null) repo.touchObject(bucket.name, row.storePath, now());
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

    async beginUpload(bucket, file) {
      await sweepStaging();
      const dirForBucket = stagedDir(bucket.name);
      await mkdir(join(dirForBucket, "nar"), { recursive: true, mode: 0o700 });
      // The route has already refused a name it does not recognise; this is the
      // wall behind that one, because a `..` here would write outside staging.
      const name = isStagedFileName(file) ? file : file.replace(/[^A-Za-z0-9._-]/g, "_");
      const path = join(dirForBucket, "nar", name);
      // A UNIQUE temp name, renamed into place on commit. Two store paths with
      // identical content share a NAR name, and two `open(path, "w")` handles
      // on one file truncate each other; the bytes are identical by
      // construction, so an atomic rename is the whole fix.
      const part = `${path}.${randomUUID()}.part`;
      openUploads.add(part);
      const handle = await open(part, "w", 0o600);
      const release = (): void => {
        openUploads.delete(part);
      };
      return {
        async write(chunk) {
          await handle.write(chunk);
        },
        async commit() {
          await handle.close();
          await rename(part, path);
          release();
        },
        async discard() {
          await handle.close().catch(() => {});
          await rm(part, { force: true }).catch(() => {});
          release();
        },
      };
    },

    async acceptNarinfo(bucket, hash, body) {
      if (!isStorePathHash(hash)) {
        return { ok: false, status: 400, message: `"${hash}" is not a store path hash` };
      }
      const dirForBucket = stagedDir(bucket.name);
      await mkdir(dirForBucket, { recursive: true, mode: 0o700 });
      const path = join(dirForBucket, `${hash}.narinfo`);
      await writeStreamToFile(body, path);
      let info: NarInfo;
      try {
        info = parseNarinfo(await readFile(path, "utf8"));
      } catch (err) {
        await unlink(path).catch(() => {});
        return {
          ok: false,
          status: 400,
          message: err instanceof Error ? err.message : String(err),
        };
      }
      if (storePathHash(info.storePath) !== hash) {
        await unlink(path).catch(() => {});
        return {
          ok: false,
          status: 400,
          message: `narinfo names ${info.storePath}, which is not ${hash}.narinfo`,
        };
      }

      // The bytes are proved BEFORE the narinfo is queued, so a narinfo with no
      // NAR behind it can never be imported by a later drain.
      const proved = await provedStagedNar(dirForBucket, info);
      if (!proved.ok) {
        await unlink(path).catch(() => {});
        return { ok: false, status: 400, message: proved.message };
      }

      const map = await ensurePending(bucket);
      const entry: Pending = { hash, info, waitingOn: [] };
      map.set(hash, entry);
      await queuedDrain(bucket, [info.storePath]);

      if (repo.object(bucket.name, info.storePath) !== null) {
        return { ok: true, status: 200, storePath: info.storePath };
      }
      const still = map.get(hash);
      if (still !== undefined && still.waitingOn.length > 0) {
        return { ok: true, status: 202, storePath: info.storePath, missing: still.waitingOn };
      }
      return {
        ok: false,
        status: 400,
        message: `${info.storePath} could not be imported: the upload was refused`,
      };
    },

    missing(bucket, paths) {
      const missing: string[] = [];
      const skipped: string[] = [];
      for (const { path, sigs } of paths) {
        if (repo.object(bucket.name, path) !== null) continue;
        const upstream = (sigs ?? []).some((sig) =>
          bucket.upstreamKeys.includes(sig.slice(0, sig.indexOf(":"))),
        );
        (upstream ? skipped : missing).push(path);
      }
      return { missing, skipped };
    },

    admin,

    close() {
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
export function credentialOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer !== null) return (bearer[1] as string).trim();
  const basic = /^Basic\s+(.+)$/i.exec(header);
  if (basic !== null) {
    let decoded: string;
    try {
      decoded = Buffer.from((basic[1] as string).trim(), "base64").toString("utf8");
    } catch {
      return null;
    }
    const at = decoded.indexOf(":");
    return at === -1 ? null : decoded.slice(at + 1);
  }
  return null;
}
