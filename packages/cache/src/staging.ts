/**
 * THE WRITE PATH — staging an upload, proving it, and putting the object.
 *
 * This is the part of the cache that moves on the NIX PROTOCOL's clock: what a
 * client uploads, in what order, and how a half-finished upload is reclaimed.
 * None of that changes when a bucket gains an org or the objects move to S3,
 * which is why it is not in `cache.ts` beside the administration.
 *
 * **An upload is PROVED before it is believed.** The staged pair is a
 * `file://` cache — `nar/<file>` and `<hash>.narinfo`, the layout the client
 * would have written — and `verifyNarFile` decompresses and hashes the NAR
 * against the narinfo's `NarHash`. Nothing else is imported: the cache is not a
 * Nix store, so the compressed file the pusher sent IS the object, and its
 * sha256 and length become the row's `FileHash:`/`FileSize:`.
 *
 * **A staged NAR belongs to the narinfo that claims it.** Every pusher of a
 * path uploads to the same name, so the narinfo PUT first renames that name to
 * one only it knows, then verifies and keeps THAT file: nothing another
 * request does can replace, move or delete the bytes under it. A narinfo with
 * nothing to claim is proved by the object an earlier proof kept, read in
 * place — never rebuilt at the shared name, where a concurrent verify would
 * read it half-written (kolu #2335's `zstd exited 1`).
 *
 * **Claiming is safe across processes; the queue is not.** The rename hands an
 * upload to one request on any shared filesystem, but the per-name queue that
 * lets a second narinfo see the object the first keeps is in this process —
 * replicas (planned) need it somewhere shared. The STORE is not the problem:
 * every store's put is put-if-absent, so two processes keeping one key leave
 * exactly one object either way.
 *
 * **A chunked upload's parts are its session's (`x-odu-upload`, 2.4):**
 * `F.s-<session>.part-i`, joined into `nar/F`. A client could PUT a NAR
 * literally named `F.s-<session>` and collide with them, but only by knowing
 * another upload's random session id — no more than a write token already
 * allows. A request without a session keeps the shared `F.part-i` of 2.x.
 *
 * **There is no ordering problem any more.** References are names in the
 * narinfo, not paths a store must already hold, so a closure arriving in any
 * order is all equally recordable. A narinfo without its NAR is still refused;
 * a NAR without its narinfo is an abandoned upload and is swept by file.
 *
 * **Staging is swept by FILE, and only when nothing is writing.** A client
 * killed between the two PUTs leaves a NAR that nothing will name; an in-flight
 * upload must not be swept out from under its writer.
 */

import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { basename, join, relative } from "node:path";
import type { ObjectStore } from "@odu/objects";
import { type KeptFile, keptFileOf, objectFactsOf } from "./fileHash";
import { writeAll } from "./sink";
import { verifyNarFile } from "./store";
import type { BucketRow } from "./db";
import { ODU_BUCKET_FIELD, ODU_ORIGIN_FIELD } from "./paths";
import {
  narFileName,
  isDerivationPath,
  isStagedFileName,
  isStorePathHash,
  type NarInfo,
  parseNarinfo,
  SERVED_EXTENSION,
  storePathHash,
} from "./narinfo";
import { newChain, type Chain, serial } from "./serial";

/** A write in progress. `commit` publishes it under the name the narinfo will
 *  name; `discard` removes it. */
export interface Upload {
  write(chunk: Uint8Array): Promise<UploadWrite>;
  commit(): Promise<void>;
  discard(): Promise<void>;
}

/** What a narinfo PUT came to. `status` is the answer the route sends. */
export type NarinfoOutcome =
  | { ok: true; status: 200; storePath: string }
  | {
      ok: false;
      status: 400;
      message: string;
      /** What the refusal knew, for the server's own log. */
      detail?: {
        storePath?: string;
        narinfoHash?: string;
        parts?: number;
        bytesReceived?: number;
        /** The staged file THIS proof read, under the staging root — the name
         *  it claimed, which no other request could touch — or `null` when
         *  nothing was staged and the object was the proof. */
        stagedFile?: string | null;
        /** That file's size when it was claimed: what the verify was given. */
        stagedBytes?: number;
      };
    };

/**
 * A PART THAT WENT OVER THE CEILING is answered by {@link Upload.write}
 * returning `"too-large"` rather than throwing: the route's refusal is an HTTP
 * status about the protocol, and a sentinel is one branch rather than an error
 * class crossing a stream boundary.
 */
export type UploadWrite = "ok" | "too-large";

type Refusal = Extract<NarinfoOutcome, { ok: false }>;

/** What `completeUpload` came to: every part present, or which indexes are not. */
export type CompleteUpload =
  | { ok: true; parts: number }
  | { ok: false; missing: readonly number[] };

/**
 * What a client reads first from a bucket.
 *
 * **Priority 41, one worse than cache.nixos.org's 40**, deliberately. A
 * bucket holds upstream-signed paths whenever one was created to take
 * everything, and at an equal 40 the client's own substituter ORDER decides
 * who serves them — which means this daemon's uplink serving bytes nixos.org's
 * CDN would have served from nearer, for free. A number that loses the tie
 * takes that decision away from whoever wrote the `nix.conf`. It is Attic's
 * convention for the same reason.
 *
 * **THE CACHE NAMES ITS OWN PUSH ADDRESS** (PLAN 2.8). Reads come from the
 * store now, so the daemon that takes a push can no longer be derived from
 * the substituter a client reads — an R2 domain answers `GET` and nothing
 * else. The two `Odu-` lines say where the push API is and which bucket this
 * is, in the one file a Nix client fetches before anything else, so a pusher
 * given only a substituter URL (`odu cache push --cache`) can find the rest
 * instead of a workflow hard-coding three facts about a cache it reads from.
 * Nix ignores keys it does not know, so a client is unaffected.
 */
export function nixCacheInfo(bucket: { origin: string; bucket: string }): string {
  return (
    "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 41\n" +
    `${ODU_ORIGIN_FIELD}: ${bucket.origin}\n${ODU_BUCKET_FIELD}: ${bucket.bucket}\n`
  );
}

/** An upload session as a client names it (`x-odu-upload`): a plain token,
 *  because it becomes part of a staged file name. */
export function isUploadSession(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/**
 * THE NAME A CHUNKED UPLOAD'S PARTS AND MARKER HANG OFF. With a session (2.4
 * clients), every upload owns its parts: two clients sending one NAR at
 * different zstd levels can no longer have their parts joined together. Without
 * one (a 2.x client), the parts keep the shared name they always had.
 */
function partStem(file: string, session: string | null): string {
  return session === null ? file : `${file}.s-${session}`;
}

/** How long a staged upload nobody finished survives. */
const STAGE_TTL_MS = 60 * 60 * 1000;

/** How often the staging directory is swept. Sweeping on every upload would be
 *  a readdir of every bucket on every PUT. */
const SWEEP_EVERY_MS = 60 * 1000;

/** The object key a bucket's compressed NAR lives at: the name the protocol
 *  serves it under, under this bucket's own prefix. */
export function objectKey(
  bucket: string,
  narHash: string,
  compression: string | null = "zstd",
): string {
  return narFileKey(bucket, narFileName(narHash, compression));
}

/** The same key, for a caller holding the NAR's FILE NAME rather than its
 *  hash — a collection's removal, which names the file it deleted. */
export function narFileKey(bucket: string, file: string): string {
  return `${bucket}/nar/${file}`;
}

/**
 * The object key a bucket's narinfo lives at: the same name the protocol
 * serves it under, under this bucket's own prefix.
 *
 * THE NARINFO IS AN OBJECT NOW (PLAN 2.8) as well as a row. A store that
 * fronts its own reads serves the pair — `<hash>.narinfo` and `nar/<file>` —
 * without odu in the path, and a client that never reaches this daemon must
 * find both where a Nix client looks for them. The row stays the truth; the
 * object is what the store publishes, rewritten whenever the row changes.
 */
export function narinfoKey(bucket: string, hash: string): string {
  return `${bucket}/${hash}.narinfo`;
}

/** The object key a bucket's `nix-cache-info` lives at — the first file a Nix
 *  client reads, and the one a store-fronted bucket needs most. */
export function cacheInfoKey(bucket: string): string {
  return `${bucket}/nix-cache-info`;
}

/**
 * WHAT A STORE TELLS A READER ABOUT THESE BYTES.
 *
 * A NAR is named by its own hash and can never change, so it is cacheable for
 * a year and `immutable` — a revalidation of it is a round trip that cannot
 * have a different answer. A narinfo and `nix-cache-info` CAN change (a
 * re-push adds a signature, a collection removes the path), so they get a day
 * and are purged when they move.
 */
export const NAR_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const INFO_CACHE_CONTROL = "public, max-age=86400";

/** The content types the protocol's three files are served as. */
export const NAR_CONTENT_TYPE = "application/x-nix-nar";
export const NARINFO_CONTENT_TYPE = "text/x-nix-narinfo";
export const CACHE_INFO_CONTENT_TYPE = "text/plain";

/**
 * WHERE A KEY IS READ FROM WHEN THE STORE SERVES ITSELF — the ONE place an
 * object key becomes a public address (PLAN 2.8).
 *
 * The protocol path and the object key are decoupled on purpose (see
 * `./narinfo`'s own note): they agree today and have moved apart before. A
 * second place that composed `<publicUrl>/<bucket>/<something>` by hand would
 * be the day a purge announces an address the store does not serve — the
 * failure that note warns about — so every caller comes through here.
 */
export function publicObjectUrl(publicUrl: string, key: string): string {
  return `${publicUrl}/${key}`;
}

/** Where a store-fronted bucket itself is read from: the base a client puts in
 *  `extra-substituters`, and the prefix every one of its keys hangs off. */
export function publicBucketUrl(publicUrl: string, bucket: string): string {
  return `${publicUrl}/${bucket}`;
}

export interface StagingDeps {
  /** The store a bucket's objects live in — the cache's one answer to that. */
  storeOf: (bucket: BucketRow) => ObjectStore;
  /** THE BUCKET'S ROW AS IT IS NOW, read inside the write lock.
   *
   *  A push is admitted against the row the request found, and a bucket can
   *  CHANGE STORES while that push is queued on the lock (`bucket.migrate`,
   *  PLAN 2.8). Writing into the snapshot's store would put the bytes in the
   *  store the move is emptying, and the move's own delete pass would then
   *  take them — a push that answered 200 for an object nobody has. */
  bucketNow: (name: string) => BucketRow | null;
  /** The cache's own directory; staging lives at `<dir>/staging`. */
  dir: string;
  now: () => number;
  /**
   * THE CACHE'S WRITE LOCK — the one a pin and a collection take. Keeping the
   * object and recording its row happen under it TOGETHER: a push that found
   * the object present and recorded after a collection deleted it would leave
   * a row with no bytes.
   */
  withWriteLock: <T>(work: () => Promise<T>) => Promise<T>;
  /** Put an imported path in a bucket, and answer whether it landed. Called
   *  only under {@link StagingDeps.withWriteLock}. */
  record: (
    bucket: BucketRow,
    info: NarInfo,
    file: KeptFile,
    selfHash: string | null,
  ) => Promise<boolean>;
  /** One line per operational fact; the cache's logger. */
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** The facts of the object this bucket already KEEPS for `narHash` and
   *  `compression`, or null when it keeps none. Called under the write lock.
   *  The cache answers it, because how — a row's recorded facts, or the store
   *  itself — is the database's and the backend's business, not the
   *  protocol's. */
  keptFacts: (
    bucket: BucketRow,
    narHash: string,
    compression: string | null,
  ) => Promise<KeptFile | null>;
}

export interface Staging {
  close(): Promise<void>;
  beginUpload(bucket: BucketRow, file: string): Promise<Upload>;
  beginPart(
    bucket: BucketRow,
    file: string,
    index: number,
    limit: number,
    session?: string | null,
  ): Promise<Upload>;
  completeUpload(
    bucket: BucketRow,
    file: string,
    total: number,
    session?: string | null,
  ): Promise<CompleteUpload>;
  acceptNarinfo(
    bucket: BucketRow,
    hash: string,
    body: ReadableStream<Uint8Array>,
  ): Promise<NarinfoOutcome>;
}

export function createStaging(deps: StagingDeps): Staging {
  const { storeOf, bucketNow, now, record, log, keptFacts, withWriteLock } = deps;
  const stagingRoot = join(deps.dir, "staging");
  const stagedDir = (bucket: string): string => join(stagingRoot, bucket);

  /** Uploads with an open file handle, by absolute path. The sweep must not
   *  delete one, and `commit` must not lose one. */
  const openUploads = new Set<string>();
  /** One COMPLETE at a time per staged file: two clients finishing one NAR
   *  would otherwise unlink parts each other is reading. */
  const completes = new Map<string, Chain>();
  /** One proof at a time per staged NAR name (see `acceptNarinfo`). */
  const proofs = new Map<string, Chain>();
  /** Bytes/parts of a completed chunked upload, for a refusal's log line. */
  const joined = new Map<string, { parts: number; bytes: number; session: string | null }>();
  let lastSweep = 0;

  /**
   * TAKE THE STAGED NAR FOR THIS REQUEST ALONE. Every push of a path names one
   * file — `nar/<narHash>.nar.zst`, whoever sends it — so the shared name is a
   * mailbox, not a file anybody owns: another upload can rename over it, and
   * another narinfo can adopt it, while this one is reading. A rename is
   * atomic, so exactly one request gets each upload, under a name nobody else
   * knows; the sweep skips it while it is held. `null` is "nothing staged".
   */
  async function claim(
    dirForBucket: string,
    name: string,
  ): Promise<{ path: string; size: number } | null> {
    const claimed = join(dirForBucket, "nar", `${name}.${randomUUID()}.claimed`);
    openUploads.add(claimed);
    try {
      await rename(join(dirForBucket, "nar", name), claimed);
      return { path: claimed, size: (await stat(claimed)).size };
    } catch (err) {
      openUploads.delete(claimed);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * THE INVARIANT THE PRIVATE-BUCKET STORY RESTS ON: a row is recorded only
   * when the NAR it names has been shown to carry the bytes it claims — the
   * bytes of a file this request claimed, or an object an earlier proof kept.
   */
  async function prove(
    bucket: BucketRow,
    hash: string,
    info: NarInfo,
    dirForBucket: string,
    name: string,
  ): Promise<NarinfoOutcome> {
    const refuse = async (
      message: string,
      claimed?: { path: string; size: number },
    ): Promise<Refusal> => ({
      ok: false,
      status: 400,
      message,
      detail: await detailOf(bucket, info, hash, claimed),
    });
    const claimed = await claim(dirForBucket, name);
    if (claimed === null) {
      // THE SECOND PROOF OF POSSESSION. Two store paths with identical content
      // share a NarHash, and the first to be recorded took the staged NAR with
      // it; so did an earlier push of this same path. The object is the proof.
      return recordSerially(bucket, info, null, async (current) =>
        (await keptFacts(current, info.narHash, info.compression)) ??
        refuse(`the narinfo names ${info.url}, which was never uploaded to this bucket`),
      );
    }
    try {
      const selfHashPart = info.references.includes(info.storePath)
        ? storePathHash(info.storePath)
        : null;
      const checked = await verifyNarFile(claimed.path, info.compression, selfHashPart);
      if (!checked.ok) return await refuse(`${info.url}: ${checked.message}`, claimed);
      if (checked.narHash !== info.narHash) {
        return await refuse(
          `${info.url} hashes to ${checked.narHash} but the narinfo says ` +
            `${info.narHash} — the upload was truncated or corrupted`,
          claimed,
        );
      }
      return await recordSerially(bucket, info, checked.selfHash, (current) =>
        keep(current, info, claimed.path, { fileHash: checked.fileHash, fileSize: checked.fileSize }),
      );
    } finally {
      // OURS TO REMOVE: kept, refused, or a duplicate of a kept object. A
      // REFUSED narinfo deletes the upload it named — no new power: any
      // write-token holder could already overwrite that name.
      openUploads.delete(claimed.path);
      await rm(claimed.path, { force: true }).catch(() => {});
    }
  }

  /** Remove staged FILES older than an hour — a client that died between the
   *  NAR PUT and the narinfo PUT leaves one behind every time. Per file, not
   *  per directory; open uploads are skipped outright. */
  async function sweep(): Promise<void> {
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
          // A PART OF AN UPLOAD STILL IN PROGRESS IS NOT LITTER. Its session
          // marker is touched on every part; an hour-old marker means nobody is
          // finishing it.
          const partAt = entry.lastIndexOf(".part-");
          if (partAt > 0) {
            const marker = await stat(join(at, `${entry.slice(0, partAt)}.uploading`)).catch(
              () => null,
            );
            if (marker !== null && marker.mtimeMs >= cutoff) continue;
          }
          await rm(path, { force: true }).catch(() => {});
          // A SWEPT UPLOAD'S LOG RECORD GOES WITH IT: otherwise the part/byte
          // context for a refusal outlives the parts it describes.
          const file = partAt > 0 ? entry.slice(0, partAt) : entry;
          joined.delete(`${bucket}/${file}`);
          if (entry.endsWith(".narinfo")) {
            const hash = entry.slice(0, -".narinfo".length);
            await unlink(join(dirForBucket, `${hash}.narinfo`)).catch(() => {});
          }
        }
      }
    }
  }

  /** How many parts one NAR may have. A 2 GiB NAR at 64 MiB is 32; the ceiling
   *  is for the protocol, not for a real closure. */
  const MAX_PARTS = 10_000;

  /** THE UPLOAD SESSION'S MARKER: a file beside the parts, touched on every
   *  part, so the sweep can tell an upload that is STILL RUNNING (a slow 2 GiB
   *  closure) from one abandoned an hour ago. */
  const uploadMarker = (dirForBucket: string, file: string): string =>
    join(dirForBucket, "nar", `${file}.uploading`);

  async function touchUpload(dirForBucket: string, file: string): Promise<void> {
    await writeFile(uploadMarker(dirForBucket, file), "", { mode: 0o600 }).catch(() => {});
  }

  /**
   * A WRITER AT ONE PATH: a unique temp file, renamed into place on commit, and
   * an optional byte cap that refuses a part the proxy would have refused
   * anyway.
   *
   * BUN'S FILE SINK is the primitive here, and it is the whole of an upload's
   * memory. Measured on a 2 GiB push, daemon RSS sampled every 0.5 s, idle
   * 227 MiB: `FileHandle.write` per chunk 324–1366 MiB (Node's `fs` shim);
   * `createWriteStream` + `pipeline` 379–1328 MiB (the same shim);
   * `writeSync` on a raw descriptor 304–325 MiB (blocks the loop);
   * `Bun.file(part).writer()` 299–316 MiB (this).
   */
  function openAt(path: string, limit: number | null): Upload {
    const part = `${path}.${randomUUID()}.part`;
    openUploads.add(part);
    const sink = Bun.file(part).writer({ highWaterMark: 1 << 20 });
    let written = 0;
    const release = (): void => {
      openUploads.delete(part);
    };
    return {
      async write(chunk) {
        written += chunk.length;
        if (limit !== null && written > limit) return "too-large";
        await writeAll(sink, chunk, path);
        return "ok";
      },
      async commit() {
        await sink.end();
        await rename(part, path);
        release();
      },
      async discard() {
        await Promise.resolve(sink.end()).catch(() => {});
        await rm(part, { force: true }).catch(() => {});
        release();
      },
    };
  }

  /** Join one upload's parts — under its lock, so two completes cannot
   *  unlink what the other reads. */
  async function completeNow(
    bucket: BucketRow,
    file: string,
    total: number,
    session: string | null,
  ): Promise<CompleteUpload> {
    const dirForBucket = stagedDir(bucket.name);
    const stem = partStem(file, session);
    const partPath = (index: number): string => join(dirForBucket, "nar", `${stem}.part-${index}`);
    const missing: number[] = [];
    for (let index = 0; index < total; index++) {
      const info = await stat(partPath(index)).catch(() => null);
      if (info === null || !info.isFile()) missing.push(index);
    }
    if (missing.length > 0) {
      // A SECOND COMPLETE for a file the first already joined is the state the
      // caller wanted: the parts are gone because the NAR exists. With a
      // session, only if THAT session's join is what sits there — another
      // upload's join is not this one's.
      const target = join(dirForBucket, "nar", file);
      const assembled = await stat(target).catch(() => null);
      const ours = session === null || joined.get(`${bucket.name}/${file}`)?.session === session;
      if (assembled !== null && assembled.isFile() && ours) {
        await unlink(uploadMarker(dirForBucket, stem)).catch(() => {});
        joined.set(`${bucket.name}/${file}`, { parts: total, bytes: assembled.size, session });
        return { ok: true, parts: total };
      }
      return { ok: false, missing };
    }

    // JOIN, never buffer: one read stream at a time, appended in order into a
    // temp file, then renamed. A client's dropped POST costs a rename, not a
    // second upload.
    const target = join(dirForBucket, "nar", file);
    const assembling = `${target}.${randomUUID()}.assembling`;
    openUploads.add(assembling);
    try {
      const out = createWriteStream(assembling);
      try {
        for (let index = 0; index < total; index++) {
          for await (const chunk of createReadStream(partPath(index))) {
            if (!out.write(chunk as Uint8Array)) await once(out, "drain");
          }
        }
        await new Promise<void>((resolve, reject) => {
          out.once("error", reject);
          out.end(resolve);
        });
      } finally {
        out.destroy();
      }
      await rename(assembling, target);
    } finally {
      openUploads.delete(assembling);
      await rm(assembling, { force: true }).catch(() => {});
    }
    for (let index = 0; index < total; index++) {
      await unlink(partPath(index)).catch(() => {});
    }
    await unlink(uploadMarker(dirForBucket, stem)).catch(() => {});
    const joinedInfo = await stat(target).catch(() => null);
    joined.set(`${bucket.name}/${file}`, {
      session,
      parts: total,
      bytes: joinedInfo?.size ?? 0,
    });
    return { ok: true, parts: total };
  }

  /** Take the claimed, proved file into the bucket's store. FIRST KEPT WINS:
   *  the store refuses a key that exists with `exists` and ITS facts, which
   *  are the ones the row records. Any other failure refuses the push (the
   *  bytes are not safely kept). */
  async function keep(
    bucket: BucketRow,
    info: NarInfo,
    path: string,
    file: KeptFile,
  ): Promise<KeptFile | Refusal> {
    const key = objectKey(bucket.name, info.narHash, info.compression);
    const refused: Refusal = {
      ok: false,
      status: 400,
      message: `${info.storePath} could not be stored: the object store refused it`,
    };
    try {
      const store = storeOf(bucket);
      const expected = objectFactsOf(file);
      // A STORE WHOSE OBJECTS ARE FILES links the proved file into place, no
      // copy; one with none is handed it as a Blob, which it can read again.
      // THE HEADERS A STORE WILL SERVE IT WITH travel with the put: a NAR read
      // from the store itself (PLAN 2.8) has no odu in the path to add them.
      const outcome = await (store.link?.(key, path, expected) ??
        store.put(key, Bun.file(path), expected, {
          contentType: NAR_CONTENT_TYPE,
          cacheControl: NAR_CACHE_CONTROL,
        }));
      if (outcome.ok) return keptFileOf(outcome.facts);
      if (outcome.refusal.kind === "exists") return keptFileOf(outcome.refusal.facts);
      // THE STORE KEPT NOTHING — it read other bytes than the verify did, or
      // its conditional write never decided — and its refusal names the facts.
      const { kind, ...named } = outcome.refusal;
      log?.("cache.object.put_failed", { bucket: bucket.name, path: info.storePath, reason: kind, ...named });
      return refused;
    } catch (err) {
      log?.("cache.object.put_failed", {
        bucket: bucket.name,
        path: info.storePath,
        reason: String((err as Error).message ?? err),
      });
      return refused;
    }
  }

  /** The context a refused upload carries into `cache.request.refused`. */
  async function detailOf(
    bucket: BucketRow,
    info: NarInfo,
    hash: string,
    claimed?: { path: string; size: number },
  ): Promise<NonNullable<Extract<NarinfoOutcome, { ok: false }>["detail"]>> {
    const file = basename(info.url);
    const done = joined.get(`${bucket.name}/${file}`);
    return {
      storePath: info.storePath,
      narinfoHash: hash,
      // WHICH BYTES WERE READ, so a refusal is diagnosable from the server
      // alone: a race would show as a file this proof did not claim.
      stagedFile: claimed === undefined ? null : relative(stagingRoot, claimed.path),
      ...(claimed === undefined ? {} : { stagedBytes: claimed.size }),
      ...(done === undefined ? {} : { parts: done.parts }),
      ...(claimed === undefined
        ? done === undefined
          ? {}
          : { bytesReceived: done.bytes }
        : { bytesReceived: claimed.size }),
    };
  }

  /** Keep and record under the cache's write lock: no collection between
   *  "the object is there" and the row that names it, and no two proofs of one
   *  object key (twins under different names) adopting it at once. `keep`
   *  answers the kept object's facts, or why it could not. `selfHash` is the
   *  verify's evidence about the PATH, not a fact of the object. */
  function recordSerially(
    bucket: BucketRow,
    info: NarInfo,
    selfHash: string | null,
    keep: (bucket: BucketRow) => Promise<KeptFile | Refusal>,
  ): Promise<NarinfoOutcome> {
    return withWriteLock(async () => {
      // THE ROW AS IT IS NOW, not as the request found it. This push was
      // admitted against a snapshot, and a bucket can change stores while the
      // push waits here (`bucket.migrate`, PLAN 2.8): keeping the object in
      // the snapshot's store would put it in the one the move is emptying,
      // and the move's delete pass would take it. The lock makes this read
      // and the write that follows one moment.
      const current = bucketNow(bucket.name) ?? bucket;
      const file = await keep(current);
      if ("ok" in file) return file;
      await record(current, info, file, selfHash);
      log?.("cache.import.recorded", {
        bucket: current.name,
        path: info.storePath,
        bytes: info.narSize,
        fileSize: file.fileSize,
      });
      return { ok: true, status: 200, storePath: info.storePath };
    });
  }

  return {
    async close() {
      await Promise.all([...completes.values()].map((chain) => chain.tail));
      await Promise.all([...proofs.values()].map((chain) => chain.tail));
    },

    async beginUpload(bucket, file) {
      await sweep();
      const dirForBucket = stagedDir(bucket.name);
      await mkdir(join(dirForBucket, "nar"), { recursive: true, mode: 0o700 });
      if (!isStagedFileName(file)) throw new Error(`"${file}" is not a NAR file name`);
      await touchUpload(dirForBucket, file);
      return openAt(join(dirForBucket, "nar", file), null);
    },

    async beginPart(bucket, file, index, limit, session = null) {
      if (!isStagedFileName(file)) throw new Error(`"${file}" is not a NAR file name`);
      if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_PARTS) {
        throw new Error(`"${index}" is not a part index`);
      }
      if (session !== null && !isUploadSession(session)) {
        throw new Error(`"${session}" is not an upload session`);
      }
      const dirForBucket = stagedDir(bucket.name);
      const stem = partStem(file, session);
      await mkdir(join(dirForBucket, "nar"), { recursive: true, mode: 0o700 });
      await touchUpload(dirForBucket, stem);
      return openAt(join(dirForBucket, "nar", `${stem}.part-${index}`), limit);
    },

    async completeUpload(bucket, file, total, session = null) {
      if (!isStagedFileName(file)) throw new Error(`"${file}" is not a NAR file name`);
      if (!Number.isSafeInteger(total) || total < 1 || total > MAX_PARTS) {
        throw new Error(`"${total}" is not a part count`);
      }
      if (session !== null && !isUploadSession(session)) {
        throw new Error(`"${session}" is not an upload session`);
      }
      const key = `${bucket.name}/${partStem(file, session)}`;
      let chain = completes.get(key);
      if (chain === undefined) {
        chain = newChain();
        completes.set(key, chain);
      }
      return serial(chain, () => completeNow(bucket, file, total, session));
    },

    async acceptNarinfo(bucket, hash, body) {
      if (!isStorePathHash(hash)) {
        return { ok: false, status: 400, message: `"${hash}" is not a store path hash` };
      }
      const dirForBucket = stagedDir(bucket.name);
      await mkdir(dirForBucket, { recursive: true, mode: 0o700 });
      const text = new TextDecoder().decode(await new Response(body).arrayBuffer());
      let info: NarInfo;
      try {
        info = parseNarinfo(text);
      } catch (err) {
        return {
          ok: false,
          status: 400,
          message: err instanceof Error ? err.message : String(err),
        };
      }
      if (storePathHash(info.storePath) !== hash) {
        return {
          ok: false,
          status: 400,
          message: `narinfo names ${info.storePath}, which is not ${hash}.narinfo`,
        };
      }
      if (isDerivationPath(info.storePath)) {
        return {
          ok: false,
          status: 400,
          message:
            `${info.storePath} is a derivation — a cache serves outputs; ` +
            "its references are recipes, and fetching one asks the host to build it",
        };
      }
      const derivedReference = info.references.find(isDerivationPath);
      if (derivedReference !== undefined) {
        return {
          ok: false,
          status: 400,
          message:
            `${info.storePath} references a derivation (${derivedReference}), ` +
            "which a cache never serves",
        };
      }

      const name = basename(info.url);
      if (!isStagedFileName(name)) {
        return {
          ok: false,
          status: 400,
          message: `narinfo names ${info.url}, which is not a NAR this cache staged`,
        };
      }
      // ONE PROOF PER STAGED NAME AT A TIME: a narinfo that finds nothing to
      // claim because another is proving it must see the object that one
      // keeps, not "never uploaded". Held for this request only.
      const key = `${bucket.name}/${name}`;
      let chain = proofs.get(key);
      if (chain === undefined) {
        chain = newChain();
        proofs.set(key, chain);
      }
      const proving = serial(chain, () => prove(bucket, hash, info, dirForBucket, name));
      const tail = chain.tail;
      try {
        return await proving;
      } finally {
        // A NAME NOBODY ELSE QUEUED ON is forgotten — on a refusal or a throw
        // as much as on success: a daemon sees every NAR name it will ever be
        // pushed, and a chain per name would be all of them.
        if (chain.tail === tail) proofs.delete(key);
        joined.delete(key);
      }
    },
  };
}
