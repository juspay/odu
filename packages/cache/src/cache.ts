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
 * **Staging is a `file://` cache, byte for byte.** An upload is written under
 * `<state>/cache/staging/<bucket>/` as `nar/<file>` and `<hash>.narinfo` — the
 * exact layout the client would have written — and then imported with
 * `nix copy --from file://<that dir>`. Nix verifies the NarHash against the
 * bytes, so a mismatched upload is a 400 and never a corrupt store path. An
 * upload whose references have not arrived yet is DEFERRED rather than refused:
 * `nix copy --to` is free to send a closure in any order, and a server that
 * insisted on one would refuse a client it had no business refusing.
 *
 * **An upload that never gets its narinfo is swept after an hour.** Without
 * that, a client killed between the two PUTs leaves a NAR on disk that nothing
 * will ever name — the cheapest possible disk leak, and the easiest to close.
 */

import { open, readdir, readFile, rm, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BlobStore, ImportOutcome, PathInfo } from "./store";
import { writeStreamToFile } from "./store";
import type { BucketRow, CacheRepo, ObjectRow, Scope, TokenRow } from "./db";
import { openCacheRepo } from "./db";
import { planGc, runGc, type GcReport } from "./gc";
import {
  fingerprintOf,
  formatNarinfo,
  generateKeypair,
  NarinfoError,
  parseNarinfo,
  signFingerprint,
  storePathHash,
  type NarInfo,
} from "./narinfo";
import {
  globMatches,
  hashToken,
  mintToken,
  mintTokenId,
  rootTokenMatches,
  tokenFacts,
  verifyToken,
  type TokenFacts,
} from "./tokens";
import { nixStore } from "./store";

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
  tokenMint(input: {
    rootToken: string;
    bucket: string;
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
 *  with: 401 for "who are you", 403 for "not with that token". */
export type AuthVerdict = { ok: true } | { ok: false; status: 401 | 403; message: string };

/** A write in progress. `commit` closes the file; `discard` removes it. */
export interface Upload {
  write(chunk: Uint8Array): Promise<void>;
  commit(): Promise<void>;
  discard(): Promise<void>;
}

export type NarinfoOutcome =
  | { ok: true; storePath: string; deferred: boolean }
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
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** How long a staged upload nobody finished survives. */
const STAGE_TTL_MS = 60 * 60 * 1000;

/** The narinfo `Compression` and URL extension odu serves. Reads are zstd on
 *  the fly; writes accept whatever a client sent. */
const SERVED_EXTENSION = "nar.zst";

export function createCache(options: CacheOptions): Cache {
  const now = options.now ?? (() => Date.now());
  const dir = join(options.stateRoot, "cache");
  const stagingRoot = join(dir, "staging");
  const repo = openCacheRepo(join(dir, "cache.sqlite"));
  const blob =
    options.blob ??
    nixStore({ gcrootsRoot: join(dir, "gcroots"), store: options.store });

  const stagedDir = (bucket: string): string => join(stagingRoot, bucket);

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

  function factsOf(bucket: BucketRow): BucketFacts {
    const objects = repo.objects(bucket.name);
    return {
      name: bucket.name,
      public: bucket.isPublic,
      retentionDays: bucket.retentionDays,
      keyName: bucket.keyName,
      publicKey: bucket.publicKey,
      upstreamKeys: bucket.upstreamKeys,
      objects: objects.length,
      bytes: objects.reduce((sum, row) => sum + row.narSize, 0),
      created: bucket.created,
    };
  }

  /** The narinfo a client reads, built from the row: the URL names the NAR by
   *  its hash, the signature is the bucket's, and the client's own signatures
   *  ride along so a path signed by a lane stays verifiable there. */
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
      sigs: row.sigs,
    };
    return formatNarinfo(info);
  }

  /** The bucket's signature over the path, computed now rather than stored:
   *  the fingerprint is a fact about the path, and a stored signature would
   *  silently survive a rotated key. */
  function sign(bucket: BucketRow, info: PathInfo, clientSigs: readonly string[]): string[] {
    const signature = signFingerprint(
      bucket.secretKey,
      fingerprintOf({
        storePath: info.storePath,
        narHash: info.narHash,
        narSize: info.narSize,
        references: info.references,
      }),
    );
    return [signature, ...clientSigs.filter((sig) => sig.split(":")[0] !== bucket.keyName)];
  }

  /** Record an imported path. Idempotent: a re-pushed path refreshes its row
   *  rather than duplicating, and keeps its hit count. */
  async function record(
    bucket: BucketRow,
    storePath: string,
    clientSigs: readonly string[],
  ): Promise<void> {
    const info = await blob.pathInfo(storePath);
    if (info === null) {
      throw new Error(`imported ${storePath} but the store does not know it`);
    }
    const existing = repo.object(bucket.name, storePath);
    const at = now();
    repo.putObject({
      bucket: bucket.name,
      storePath,
      hash: storePathHash(storePath),
      narHash: info.narHash,
      narSize: info.narSize,
      references: info.references,
      deriver: info.deriver,
      sigs: sign(bucket, info, [...clientSigs, ...info.sigs]),
      hits: existing?.hits ?? 0,
      created: existing?.created ?? at,
      lastAccessed: existing?.lastAccessed ?? at,
    });
    // The root is what keeps the machine's own GC from eating a path the cache
    // serves; without it the first `nix-collect-garbage` empties the bucket.
    await blob.retain(bucket.name, storePath);
  }

  /**
   * Import everything staged that can be imported now, in as many passes as it
   * takes. Each pass makes progress or stops: a path whose references are
   * still missing stays staged for the next narinfo that arrives.
   */
  async function drainStaged(bucket: BucketRow): Promise<void> {
    const dirForBucket = stagedDir(bucket.name);
    await writeFile(join(dirForBucket, "nix-cache-info"), NIX_CACHE_INFO).catch(() => {});
    const files = (await readdir(dirForBucket).catch(() => [] as string[])).filter((file) =>
      file.endsWith(".narinfo"),
    );
    let progressed = files.length > 0;
    while (progressed) {
      progressed = false;
      for (const file of files) {
        const path = join(dirForBucket, file);
        let info: NarInfo;
        try {
          info = parseNarinfo(await readFile(path, "utf8"));
        } catch {
          await unlink(path).catch(() => {});
          continue;
        }
        if (repo.object(bucket.name, info.storePath) !== null) {
          await unlink(path).catch(() => {});
          continue;
        }
        const outcome: ImportOutcome = await blob.import({
          dir: dirForBucket,
          storePath: info.storePath,
        });
        if (!outcome.ok) {
          if (!outcome.defer) await unlink(path).catch(() => {});
          continue;
        }
        await record(bucket, info.storePath, info.sigs);
        // The NAR this narinfo named is now inside the store; the staged copy
        // is dead weight. Other staged narinfos naming it are re-imported as
        // no-ops, so removing it is safe.
        const stagedNar = join(dirForBucket, info.url);
        await unlink(stagedNar).catch(() => {});
        await unlink(path).catch(() => {});
        progressed = true;
      }
    }
  }

  /** Remove uploads older than an hour — a client that died between the NAR PUT
   *  and the narinfo PUT leaves one behind every time. */
  async function sweepStaging(): Promise<void> {
    const buckets = await readdir(stagingRoot).catch(() => [] as string[]);
    const cutoff = now() - STAGE_TTL_MS;
    for (const bucket of buckets) {
      const dirForBucket = join(stagingRoot, bucket);
      for (const entry of await readdir(dirForBucket).catch(() => [] as string[])) {
        const path = join(dirForBucket, entry);
        const info = await stat(path).catch(() => null);
        if (info !== null && info.mtimeMs < cutoff) {
          await rm(path, { force: true, recursive: true }).catch(() => {});
        }
      }
    }
  }

  /** A bucket's full closure as the store sees it, resolved at pin time. */
  async function resolveClosure(paths: readonly string[]): Promise<string[]> {
    const seen = new Set<string>();
    const queue = [...paths];
    while (queue.length > 0) {
      const path = queue.pop() as string;
      if (seen.has(path)) continue;
      seen.add(path);
      const info = await blob.pathInfo(path);
      if (info === null) {
        throw new NarinfoError(`no such path in the store: ${path}`);
      }
      for (const reference of info.references) queue.push(reference);
    }
    return [...seen];
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
      return { ok: true, value: repo.buckets().map(factsOf) };
    },

    async tokenMint(input) {
      const root = requireRoot(input.rootToken);
      if (!root.ok) return root;
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      const token = mintToken();
      const row: TokenRow = {
        id: mintTokenId(),
        hash: hashToken(token),
        bucketGlob: bucket.name,
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
      let closure: string[];
      try {
        closure = await resolveClosure(input.paths);
      } catch (err) {
        return {
          ok: false,
          code: "bad_input",
          message: err instanceof Error ? err.message : String(err),
        };
      }
      const created = now();
      repo.putPin({ bucket: bucket.name, name: input.name, rootPaths: closure, created });
      // Every path a pin holds must be rooted in the store, or the machine's
      // own GC deletes the pin out from under the cache.
      for (const path of closure) await blob.retain(bucket.name, path);
      return {
        ok: true,
        value: { bucket: bucket.name, name: input.name, rootPaths: closure, created },
      };
    },

    async gc(input) {
      const root = requireRoot(input.rootToken);
      if (!root.ok) return root;
      const buckets =
        input.bucket === null ? repo.buckets() : [repo.bucket(input.bucket)].filter(
            (row): row is BucketRow => row !== null,
          );
      if (input.bucket !== null && buckets.length === 0) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      const plan = planGc({
        buckets,
        objects: repo.objects(),
        pins: repo.pins(),
        now: now(),
      });
      return { ok: true, value: await runGc(blob, repo, plan) };
    },

    async stats(input) {
      const root = requireRoot(input.rootToken);
      if (!root.ok) return root;
      const buckets = repo.buckets();
      const objects = repo.objects();
      return {
        ok: true,
        value: {
          buckets: buckets.map(factsOf),
          objects: objects.length,
          bytes: objects.reduce((sum, row) => sum + row.narSize, 0),
          hits: objects.reduce((sum, row) => sum + row.hits, 0),
          lastAccessed:
            objects.length === 0
              ? null
              : objects.reduce((newest, row) => Math.max(newest, row.lastAccessed), 0),
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
        return { ok: false, status: 401, message: "this bucket needs a token" };
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
      const row = repo.objectByHash(bucket.name, hash);
      return row === null ? null : narinfoFor(bucket, row);
    },

    touch(bucket, hash) {
      const row = repo.objectByHash(bucket.name, hash);
      if (row !== null) repo.touchObject(bucket.name, row.storePath, now());
    },

    async narStream(bucket, file) {
      // `nar/<hash>.nar.zst` and `nar/<hash>.nar.xz` are the same object; the
      // extension is the CLIENT's compression choice and odu always serves
      // zstd, so only the hash part is looked up.
      const at = file.indexOf(".nar");
      const base32 = at === -1 ? file : file.slice(0, at);
      const row = repo.objectByNarHash(bucket.name, `sha256:${base32}`);
      return row === null ? null : blob.dump(row.storePath);
    },

    async beginUpload(bucket, file) {
      await sweepStaging();
      const dirForBucket = stagedDir(bucket.name);
      await mkdir(join(dirForBucket, "nar"), { recursive: true });
      // The file name is the client's, and a `..` in it would write outside the
      // staging directory. Nix never sends one; nothing else may.
      const name = file.replace(/[^A-Za-z0-9._-]/g, "_");
      const path = join(dirForBucket, "nar", name);
      const handle = await open(path, "w");
      return {
        async write(chunk) {
          await handle.write(chunk);
        },
        async commit() {
          await handle.close();
        },
        async discard() {
          await handle.close().catch(() => {});
          await rm(path, { force: true }).catch(() => {});
        },
      };
    },

    async acceptNarinfo(bucket, hash, body) {
      const dirForBucket = stagedDir(bucket.name);
      await mkdir(dirForBucket, { recursive: true });
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
      await drainStaged(bucket);
      const recorded = repo.object(bucket.name, info.storePath) !== null;
      return { ok: true, storePath: info.storePath, deferred: !recorded };
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
