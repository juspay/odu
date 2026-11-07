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
import { type DirectStore, directUploads, type ObjectStore, TEMP, type UploadedPart } from "@odu/objects";
import { type KeptFile, keptFileOf, objectFactsOf } from "./fileHash";
import { writeAll } from "./sink";
import { verifyNarFile, verifyNarStream } from "./store";
import type { BucketRow } from "./db";
import { ODU_BUCKET_FIELD, ODU_ORIGIN_FIELD, type UploadMode, type UploadPlan } from "./paths";
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
import { PRESIGN_SECONDS } from "./surface";

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
      /** 400 for a proof this push could not make; 404 for a bucket that
       *  stopped existing while the push was being verified — the answer
       *  `admit` gives every request that arrives one moment later. */
      status: 400 | 404;
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
 * WHERE A NAR'S BYTES GO (PLAN 2.9) — the wire's own question, declared in
 * `./paths` so the client and this file read one spelling of it, and answered
 * here.
 *
 * `direct`: the STORE takes the bytes, through URLs odu signs, and odu reads
 * the object back, proves it and copies it into place. `staged`: they cross
 * this process into the staging directory, as every push did before 2.9.
 *
 * THE STORE DECIDES, not a flag. A store that cannot presign a write (disk —
 * its objects are files on odu's own machine) has nobody to send a client to,
 * so its buckets stay staged; an S3 store's never are. The client is TOLD
 * which, per path, so there is nothing to guess and nothing to configure.
 */
export type { UploadMode, UploadPlan } from "./paths";

/** A presigned part, or why there is none. `status` is the answer the route
 *  sends: 404 for an upload this daemon does not hold (it restarted, or the
 *  client is a minute too late), which the client answers by beginning
 *  again. */
export type DirectPart =
  | { ok: true; url: string }
  | { ok: false; status: 400 | 404; message: string };

/** What a direct upload's completion came to: the object is in the store
 *  under its temp key, this long, in this many parts. */
export type DirectComplete =
  | { ok: true; parts: number; bytes: number }
  | { ok: false; status: 400 | 404; message: string };

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
export function nixCacheInfo(of: { origin: string; bucket: string }): string {
  return (
    "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 41\n" +
    `${ODU_ORIGIN_FIELD}: ${of.origin}\n${ODU_BUCKET_FIELD}: ${of.bucket}\n`
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
  /** How this bucket's store takes a NAR's bytes. The capability is the
   *  STORE's, asked here so no route ever peeks at one. */
  uploadMode(bucket: BucketRow): UploadMode;
  /**
   * BEGIN ONE NAR'S UPLOAD. On a staged bucket it answers `{mode:"staged"}`
   * and holds nothing; on a direct one it reserves a temp key and hands back
   * the URLs that write it. `floor` is the client's own `--part-size`, which
   * in direct mode raises the part size rather than capping it.
   */
  beginDirect(bucket: BucketRow, file: string, floor: number | null): Promise<UploadPlan>;
  /** The URL that writes part `index` (0-based) of an upload this daemon
   *  holds. The store's multipart upload is opened here, on the first part
   *  asked for — a one-part NAR never opens one. */
  directPart(bucket: BucketRow, file: string, upload: string, index: number): Promise<DirectPart>;
  /** Finish a direct upload: complete the store's multipart upload when there
   *  was one, then CONFIRM the object is there. A `parts` of none is the
   *  single-object PUT, which has nothing to join. */
  completeDirect(
    bucket: BucketRow,
    file: string,
    upload: string,
    parts: readonly UploadedPart[],
  ): Promise<DirectComplete>;
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

  // ── THE DIRECT UPLOAD (PLAN 2.9) ──────────────────────────────────────
  //
  // The bytes never reach this process. What it keeps instead is one record
  // per upload in flight: which temp key the client is writing, which store
  // holds it, and — once the client says it is done — that the object is
  // there, so the narinfo that follows knows what to read back and prove.
  //
  // The record is this DAEMON's, not the database's. An upload that outlives
  // a restart is lost on purpose: the client is told (404) and begins again,
  // which costs it one NAR and spares a persisted table whose only content is
  // a minute of other people's intentions. The temp objects and open uploads
  // such a restart leaves are the BOOT sweep's, which runs before the mount
  // and so cannot race a live push (`cache.ts`'s `boot`).
  //
  // Which stores can do this at all is `@odu/objects`' question, asked once
  // through `directUploads` — the list of members lives with the interface
  // that declares them, not here.

  interface DirectUpload {
    readonly id: string;
    readonly bucket: string;
    readonly file: string;
    /**
     * THE TEMP KEY THE CLIENT WRITES — and the one odu proves afterwards.
     *
     * Unique per upload, so two pushers of one path never write each other's
     * bytes. And writable ONLY as parts of {@link DirectUpload.upload}: odu
     * presigns nothing else for it, so completing that upload leaves a key no
     * URL odu ever signed can touch. That is what makes the readback a proof
     * of the bytes the copy will move, rather than of a key somebody may
     * still rewrite.
     */
    readonly key: string;
    readonly store: DirectStore;
    /** The store's multipart upload, opened when this record was made. */
    readonly upload: string;
    readonly partSize: number;
    /**
     * WHEN THIS UPLOAD LAST MOVED — not when it began. The sweep's clock is
     * LITTER (an hour since anybody touched a thing), and a push's clock is
     * PROGRESS (a part at a time, as fast as the client's link allows). A
     * closure big enough to take longer than the hour would otherwise be
     * reaped mid-flight, deleting the temp object under a client still
     * sending parts. The staged path keeps the same distinction with its
     * `.uploading` marker.
     */
    touched: number;
  }

  /** Uploads in flight, by their handle. */
  const directs = new Map<string, DirectUpload>();
  /** The upload whose object is IN THE STORE, by `<bucket>/<file>` — what the
   *  narinfo that follows reads back. A second upload of one name replaces
   *  the first: the last bytes the client said it finished are the ones it is
   *  about to claim. */
  const landed = new Map<string, DirectUpload>();

  const directKey = (bucket: string, file: string): string => `${bucket}/${file}`;

  /** The record this request names, or null — a handle from before a restart,
   *  from another bucket, or for another NAR is no upload of ours. */
  function heldUpload(bucket: BucketRow, file: string, upload: string): DirectUpload | null {
    const direct = directs.get(upload);
    return direct !== undefined && direct.bucket === bucket.name && direct.file === file
      ? direct
      : null;
  }

  /** Let an upload go: its record, its claim on the name, and the bytes it
   *  left in the store. Called when a narinfo has had its answer out of it,
   *  and when the sweep finds one nobody finished. */
  async function dropUpload(direct: DirectUpload): Promise<void> {
    directs.delete(direct.id);
    if (landed.get(directKey(direct.bucket, direct.file))?.id === direct.id) {
      landed.delete(directKey(direct.bucket, direct.file));
    }
    await direct.store.abortUpload(direct.key, direct.upload).catch(() => {});
    await direct.store.delete(direct.key).catch(() => {});
  }

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
   * THE SAME PROOF, OVER AN OBJECT THE CLIENT PUT IN THE STORE ITSELF (PLAN
   * 2.9).
   *
   * ODU NEVER SIGNS A HASH IT DID NOT TAKE. The bytes went where odu cannot
   * watch them, so they are read BACK — streamed out of the store, through
   * the same decompress-and-hash as a staged file — and only then copied into
   * place and recorded. That readback is the cost of the whole feature, and
   * it is one store→odu transfer on the downlink against an upload that no
   * longer crosses the machine at all.
   *
   * The temp object is this request's either way: kept bytes are a copy of
   * it, refused bytes are deleted with it, and nothing under `nar/<file>`
   * exists until the copy wrote it.
   */
  async function proveDirect(
    bucket: BucketRow,
    hash: string,
    info: NarInfo,
    direct: DirectUpload,
  ): Promise<NarinfoOutcome> {
    const refuse = async (message: string, reason: string): Promise<Refusal> => {
      log?.("cache.nar.verify_failed", {
        bucket: bucket.name,
        file: direct.file,
        mode: "direct",
        path: info.storePath,
        reason,
      });
      return { ok: false, status: 400, message, detail: await detailOf(bucket, info, hash) };
    };
    try {
      const object = await direct.store.get(direct.key);
      if (object === null) {
        return await refuse(
          `the narinfo names ${info.url}, which was never uploaded to this bucket`,
          "absent",
        );
      }
      const selfHashPart = info.references.includes(info.storePath)
        ? storePathHash(info.storePath)
        : null;
      const checked = await verifyNarStream(object, info.compression, selfHashPart);
      // THE REASON IS A TOKEN, the message is the sentence: `reason` is what
      // an operator groups these lines by, and the decompressor's stderr has
      // a cardinality of one per upload.
      //
      // `short_read` IS NOT `unreadable`. The temp key is one the client still
      // holds a presigned PUT for, so a rewrite between the GET that measured
      // the object and the GETs that read it leaves a window short — the
      // bytes proved are gone, which is the client racing its own upload, not
      // a NAR odu cannot read (issue #160).
      if (!checked.ok) {
        return await refuse(
          `${info.url}: ${checked.message}`,
          checked.changed === true ? "short_read" : "unreadable",
        );
      }
      if (checked.narHash !== info.narHash) {
        return await refuse(
          `${info.url} hashes to ${checked.narHash} but the narinfo says ` +
            `${info.narHash} — the upload was truncated or corrupted`,
          "nar_hash_mismatch",
        );
      }
      // THE BYTES THAT WERE PROVED, AND NO OTHERS. The client still holds a
      // presigned PUT for this temp key, so the copy below is bound to the
      // VERSION this verify read: a rewrite between the two is refused, not
      // copied under the facts of bytes that are gone.
      return await recordSerially(bucket, info, checked.selfHash, (current) =>
        keepCopied(
          current,
          info,
          direct,
          { fileHash: checked.fileHash, fileSize: checked.fileSize },
          object.etag,
        ),
      );
    } finally {
      await dropUpload(direct);
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
    // A DIRECT UPLOAD NOBODY FINISHED, the same hour later: its record goes,
    // its multipart upload is aborted and its temp object deleted. The store's
    // own sweep would reach the bytes eventually; this reaches the RECORD,
    // which is this process's and which nothing else would ever free.
    for (const direct of [...directs.values()]) {
      if (direct.touched >= cutoff) continue;
      await dropUpload(direct);
      joined.delete(directKey(direct.bucket, direct.file));
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
  function openAt(
    path: string,
    limit: number | null,
    /** What landed, once it is under its final name — the bytes a whole NAR
     *  upload carried, for the event that says one arrived. */
    done?: (bytes: number) => void,
  ): Upload {
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
        done?.(written);
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
    const bytes = joinedInfo?.size ?? 0;
    joined.set(`${bucket.name}/${file}`, { session, parts: total, bytes });
    log?.("cache.nar.uploaded", { bucket: bucket.name, file, mode: "staged", parts: total, bytes });
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

  /**
   * THE SAME STEP FOR A DIRECT UPLOAD: make the proved temp object the
   * bucket's NAR, inside the store, with the facts THIS proof measured.
   *
   * The bytes do not move through odu and the facts are not the store's to
   * learn — it never read them — so the copy carries them, exactly as the
   * staged path hands `put` an `expected`. First kept still wins: the copy is
   * conditional, and an `exists` answers with the object that was already
   * there.
   *
   * WHAT BINDS THE PROOF TO THE COPY, in two layers.
   *
   * The FIRST is structural and holds on every service: odu presigns nothing
   * for the temp key but PARTS of one multipart upload, and completing that
   * upload kills them, so from the completion onwards no URL anybody holds
   * can write the key this proof read. That is the guarantee.
   *
   * The SECOND is `version`, the ETag the readback was answered from, sent as
   * `sourceIfMatch`. AWS and versitygw hold the copy to it; R2 does not
   * implement the source condition on `UploadPartCopy`, so it is defence and
   * not the guarantee. It still FAILS CLOSED: a store that answers a read
   * with no version at all is one this proof cannot be checked against, and
   * the push is refused rather than copied on trust.
   */
  async function keepCopied(
    bucket: BucketRow,
    info: NarInfo,
    direct: DirectUpload,
    file: KeptFile,
    version: string | undefined,
  ): Promise<KeptFile | Refusal> {
    // THE BUCKET MOVED STORES while this upload was in flight (`bucket.migrate`,
    // PLAN 2.8). The bytes are in the store the move is emptying, and a copy
    // is one store's operation — so this push is refused rather than landed
    // somewhere the move will take it. The client's next push finds the new
    // store and uploads there.
    const store = storeOf(bucket);
    if (store !== direct.store) {
      log?.("cache.object.put_failed", {
        bucket: bucket.name,
        path: info.storePath,
        reason: "store_changed",
      });
      return {
        ok: false,
        status: 400,
        message:
          `${bucket.name} changed stores while ${info.storePath} was uploading — ` +
          "its bytes went to the old one; push it again",
      };
    }
    // NO VERSION, NO COPY. A store that answered the readback without naming
    // which object it answered from cannot be held to it, and this is a proof
    // the whole private-bucket story rests on — so the push is refused rather
    // than the precondition quietly dropped.
    if (version === undefined) {
      log?.("cache.nar.verify_failed", {
        bucket: bucket.name,
        file: basename(info.url),
        mode: "direct",
        path: info.storePath,
        reason: "unversioned_source",
      });
      return {
        ok: false,
        status: 400,
        message:
          `${info.url} was read from a store that named no version for it — ` +
          "odu will not copy a proof it cannot bind",
      };
    }
    const refused: Refusal = {
      ok: false,
      status: 400,
      message: `${info.storePath} could not be stored: the object store refused it`,
    };
    const key = objectKey(bucket.name, info.narHash, info.compression);
    try {
      const decided = await direct.store.copy(direct.key, key, {
        facts: objectFactsOf(file),
        contentType: NAR_CONTENT_TYPE,
        cacheControl: NAR_CACHE_CONTROL,
        sourceIfMatch: version,
      });
      if (decided === "stored") return file;
      if (decided === "exists") {
        const kept = await direct.store.facts(key);
        return kept === null ? refused : keptFileOf(kept);
      }
      // THE SOURCE WAS REWRITTEN between the verify and the copy — somebody
      // with the presigned URL put other bytes there. Nothing is kept, and
      // the push is told, because this is the one refusal that is about the
      // CLIENT rather than about the store.
      if (decided === "source_changed") {
        log?.("cache.nar.verify_failed", {
          bucket: bucket.name,
          file: basename(info.url),
          mode: "direct",
          path: info.storePath,
          reason: "source_changed",
        });
        return {
          ok: false,
          status: 400,
          message:
            `${info.url} was rewritten while odu was verifying it — ` +
            "the bytes it proved are not the bytes it was asked to keep",
        };
      }
      log?.("cache.object.put_failed", {
        bucket: bucket.name,
        path: info.storePath,
        reason: decided,
        key,
      });
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
      //
      // AND THE BUCKET CAN BE GONE. `bucket.delete` purges the prefix and
      // drops the rows under this same lock, so a push already past `admit`
      // can arrive here with nothing to be recorded against. Writing against
      // the snapshot would put an object and a row under a name no listing
      // reaches — never collected, never swept, and served again under a new
      // key if the name is re-created. 404 is what `admit` would have
      // answered a moment later.
      const current = bucketNow(bucket.name);
      if (current === null) {
        return { ok: false, status: 404, message: `no bucket "${bucket.name}"` };
      }
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

    uploadMode(bucket) {
      return directUploads(storeOf(bucket)) === null ? "staged" : "direct";
    },

    async beginDirect(bucket, file, floor) {
      if (!isStagedFileName(file)) throw new Error(`"${file}" is not a NAR file name`);
      await sweep();
      const store = directUploads(storeOf(bucket));
      if (store === null) return { mode: "staged" };
      // THE PART SIZE IS THE LARGER OF TWO: the store's own — never below
      // what S3 demands of every part but the last, which is the store's
      // business and not this file's — and what the client asked for. In
      // direct mode `--part-size` is a FLOOR: there is no proxy body limit
      // to stay under, and a part too SMALL is the only one a store refuses.
      const partSize = Math.max(store.partSize, floor ?? 0);
      const key = `${bucket.name}/nar/${TEMP}${randomUUID()}`;
      const direct: DirectUpload = {
        id: randomUUID(),
        bucket: bucket.name,
        file,
        key,
        store,
        upload: await store.createUpload(key),
        partSize,
        touched: now(),
      };
      directs.set(direct.id, direct);
      return {
        mode: "direct",
        upload: direct.id,
        partSize,
        // PART 0 RIDES ALONG, so a NAR that fits in one part costs the three
        // requests a plain PUT would have — and is still a PART, which is
        // what keeps the key unwritable once the upload is completed.
        part: store.presignPart(key, direct.upload, 0, PRESIGN_SECONDS).href,
      };
    },

    async directPart(bucket, file, upload, index) {
      const direct = heldUpload(bucket, file, upload);
      if (direct === null) {
        return { ok: false, status: 404, message: `no upload ${upload} for nar/${file}` };
      }
      if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_PARTS) {
        return { ok: false, status: 400, message: `"${index}" is not a part index` };
      }
      // STILL MOVING: asking for a part is this upload's sign of life, and
      // what keeps the sweep's litter clock off a push that is simply long.
      direct.touched = now();
      return {
        ok: true,
        url: direct.store.presignPart(direct.key, direct.upload, index, PRESIGN_SECONDS).href,
      };
    },

    async completeDirect(bucket, file, upload, parts) {
      const direct = heldUpload(bucket, file, upload);
      if (direct === null) {
        return { ok: false, status: 404, message: `no upload ${upload} for nar/${file}` };
      }
      // A JOIN THAT DID NOT HAPPEN ENDS THE UPLOAD. The record, the temp
      // object and the open multipart upload go now rather than an hour from
      // now, so the client's next `begin` — which is what it answers a
      // refusal with — is not racing an abandoned upload on a key of its own.
      const failed = async (message: string): Promise<DirectComplete> => {
        await dropUpload(direct);
        return { ok: false, status: 400, message };
      };
      if (parts.length < 1 || parts.length > MAX_PARTS) {
        return await failed(`${parts.length} is not a part count for one NAR`);
      }
      try {
        // The temp key is this upload's alone, so nothing can be racing for
        // it and the completion needs no precondition.
        const decided = await direct.store.completeUpload(direct.key, direct.upload, parts);
        if (decided !== "stored") {
          return await failed(`the store did not join the parts (${decided})`);
        }
      } catch (err) {
        return await failed(String((err as Error).message ?? err));
      }
      // WHAT ODU ITSELF SAW. A completion that answers 200 means the object
      // is in the store and this long — not that a client said so. From here
      // the key has NO WRITER: the part URLs die with the upload they named,
      // and odu signed nothing else for it.
      const bytes = await direct.store.head(direct.key).catch(() => null);
      if (bytes === null) {
        await dropUpload(direct);
        return {
          ok: false,
          status: 400,
          message: `nar/${file} is not in the store: the upload never landed`,
        };
      }
      landed.set(directKey(bucket.name, file), direct);
      // The same two facts a staged join records, for the same refusal line.
      joined.set(directKey(bucket.name, file), { parts: parts.length, bytes, session: null });
      log?.("cache.nar.uploaded", {
        bucket: bucket.name,
        file,
        mode: "direct",
        parts: parts.length,
        bytes,
      });
      return { ok: true, parts: parts.length, bytes };
    },

    async beginUpload(bucket, file) {
      await sweep();
      const dirForBucket = stagedDir(bucket.name);
      await mkdir(join(dirForBucket, "nar"), { recursive: true, mode: 0o700 });
      if (!isStagedFileName(file)) throw new Error(`"${file}" is not a NAR file name`);
      await touchUpload(dirForBucket, file);
      return openAt(join(dirForBucket, "nar", file), null, (bytes) => {
        log?.("cache.nar.uploaded", { bucket: bucket.name, file, mode: "staged", parts: 1, bytes });
      });
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
      const proving = serial(chain, () => {
        // THE BYTES THIS NAME HAS, wherever the client put them, read INSIDE
        // the chain: an upload it finished in the store (2.9), else whatever
        // is staged under the name. Direct first, because on a direct bucket
        // a staged file for this name could only be an older client's.
        //
        // READ HERE AND NOT BEFORE THE QUEUE. Twin store paths share a NarHash
        // and therefore this file name, and their two narinfos can both arrive
        // before either proof runs. Captured eagerly, both would hold the SAME
        // upload: the first proof consumes and deletes its temp object, and
        // the second would find nothing and refuse a path the cache does have.
        // Read here, the second finds `landed` empty, falls through to
        // `prove`, and takes the second proof of possession over the object
        // the first one kept.
        const direct = landed.get(key);
        return direct === undefined
          ? prove(bucket, hash, info, dirForBucket, name)
          : proveDirect(bucket, hash, info, direct);
      });
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
