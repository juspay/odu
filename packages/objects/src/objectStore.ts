/**
 * AN OBJECT STORE — immutable bytes under opaque keys, behind one interface.
 *
 * A store knows keys, bytes, sizes and sha256s, and nothing about what the
 * bytes mean: the caller chooses the key layout and gives the bytes their
 * meaning. Two constructors, each in its own module behind this one door:
 * `diskObjectStore` (`./diskStore`, files under a directory) and
 * `s3ObjectStore` (`./s3Store`, any S3-compatible service: R2, AWS, Garage,
 * versitygw). They share only what this module says a store is — a key, a temp
 * name, a store's facts — and none of each other's means.
 *
 * **A store is a VALUE.** Nothing outside the two constructors knows
 * which kind it holds: a caller speaks this interface, and the one capability
 * only some stores have — `link`, making a local file the object without a
 * copy — is an optional member it may call, never a kind it asks about.
 *
 * **Objects are immutable, and a put is put-if-absent.** A put onto a key that
 * exists is REFUSED with `exists` and the kept object's facts; of two
 * concurrent puts of one key exactly one wins. Disk links a finished temp file
 * into place (`link` fails on an existing name, where `rename` would replace
 * it); S3 sends `If-None-Match: *` on the write that makes the object visible.
 * No half object is ever visible under its final key: disk's temp names and
 * S3's temp keys are `.tmp-*`, which `list` skips and `sweepTemp` removes.
 *
 * **A put that dies leaves nothing the sweep cannot reach.** A process killed
 * mid-put (eviction, OOM, `kill -9`) leaves its temp name — and, on S3, an
 * INCOMPLETE MULTIPART UPLOAD, which no ListObjects shows and whose parts cost
 * storage until a lifecycle rule aborts them (R2's default is seven days; AWS
 * has none). So `sweepTemp` lists both under a prefix and removes what began
 * before a given moment: temp names by modification time, uploads by
 * `Initiated` (the service's clock). A younger one is a live put. Disk has no
 * uploads.
 *
 * **Facts are written once and read back.** `put` hashes while it streams, and
 * the size and sha256 (hex) are kept beside the object — a sidecar file on
 * disk, `x-amz-meta-odu-*` on S3 — so `facts` answers without reading the
 * bytes.
 *
 * **Reads take a range.** `get(key, range)` streams exactly the bytes asked
 * for, at constant memory: a file read 64 KiB at a time on disk, ranged GETs on
 * S3.
 *
 * **Writes can leave odu too.** A store that serves its own objects also TAKES
 * its own objects: `createUpload`, `presignPart`, `completeUpload`,
 * `abortUpload` and `copy` let a writer that odu has authorised send the
 * bytes to the store directly, and let odu then prove them
 * and `copy` them into place. Optional, like `presignGet` and for the same
 * reason: a store whose objects are local files has nobody to presign for.
 *
 * The contract suite (`test/contract.ts`) runs against both: disk, and S3
 * through versitygw (`test/versitygw.ts`).
 */

import { createHash } from "node:crypto";

/** What `put` learned while it wrote: the stored bytes' own facts. */
export interface ObjectFacts {
  size: number;
  /** The sha256 of the stored bytes, as 64 lowercase hex digits. */
  sha256: string;
}

/**
 * WHAT A PUT WRITES. A stream is read once. A `Blob` — a file, `Bun.file(path)`
 * — can be read again, so a put whose S3 upload must start over (a `409` on
 * `CompleteMultipartUpload`) restarts it from the beginning itself.
 */
export type ObjectBody = ReadableStream<Uint8Array> | Blob;

/** Bytes `start` through `end`, both inclusive — HTTP's own spelling. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface StoredObject {
  /** The requested bytes: the whole object, or the range asked for. */
  stream: ReadableStream<Uint8Array>;
  /** The WHOLE object's size, whatever range was read. */
  size: number;
  /**
   * WHICH VERSION OF THE KEY THESE BYTES ARE, when the store names one (S3's
   * ETag). A reader that must act on what it read — prove it, then copy it —
   * hands this back as {@link CopyOptions.sourceIfMatch}, so a key rewritten
   * in between is a refusal rather than a copy of other bytes. A store whose
   * objects are files it alone writes has no versions and leaves it out.
   */
  etag?: string;
}

/** Why a write did not make an object. A value, naming what happened. */
export type ObjectRefusal =
  /** The key already holds an object, which is kept; `facts` are ITS facts. */
  | { kind: "exists"; key: string; facts: ObjectFacts }
  /** The caller said what the bytes would be, and they were not. Nothing was
   *  kept. */
  | { kind: "facts_mismatch"; key: string; expected: ObjectFacts; actual: ObjectFacts }
  /** A conditional write that stayed UNDECIDED: S3 answered `409 Conflict`
   *  to all `tries`, so nobody is known to have won the key. Nothing was kept. */
  | { kind: "conflict"; key: string; tries: number };

export type PutOutcome = { ok: true; facts: ObjectFacts } | { ok: false; refusal: ObjectRefusal };

/**
 * WHAT A READER OF THE OBJECT SHOULD BE TOLD, when the store can tell it: the
 * response headers an HTTP read of the object answers with. A store that
 * serves its objects itself (S3) keeps them with the object; a store whose
 * objects are plain files has no responses to put them on and ignores them.
 * They are not facts: nothing reads them back, and they never decide a put.
 */
export interface PutOptions {
  readonly contentType?: string;
  readonly cacheControl?: string;
}

/**
 * ONE PART OF A DIRECT UPLOAD, as the writer that sent it reports it: the
 * index it was presigned under and the ETag the store answered. `index` is
 * 0-based, as odu's wire numbers parts; S3's own PartNumber is `index + 1`,
 * which is the store's business and nobody else's.
 */
export interface UploadedPart {
  readonly index: number;
  readonly etag: string;
}

/**
 * WHAT A CONDITIONAL WRITE CAME TO, for a write whose bytes this process is
 * not holding and therefore cannot send again: `stored`, `exists` (the key was
 * taken — S3's 412), or `conflict` (409 to every try, so nobody is known to
 * have won). The same three answers {@link ObjectRefusal} spells for a put —
 * plus `source_changed`, which only a copy can meet: the bytes it was told to
 * move are no longer the bytes the caller measured.
 */
export type WriteDecision = "stored" | "exists" | "conflict" | "source_changed";

/** What a server-side copy writes beside the bytes. The facts are the
 *  CALLER'S — a copy moves bytes it never read, so the store cannot learn
 *  them, and whoever proved them says what they are. A copy is PUT-IF-ABSENT
 *  like every other write this interface makes visible: `exists` keeps what
 *  is there, and no caller has ever wanted the other behaviour. */
export interface CopyOptions extends PutOptions {
  readonly facts: ObjectFacts;
  /**
   * COPY THESE BYTES OR NONE: the source's {@link StoredObject.etag} as the
   * caller read it, sent as `x-amz-copy-source-if-match`. A source rewritten
   * since answers `source_changed`, and nothing is written.
   *
   * HOW FAR IT REACHES IS THE SERVICE'S: AWS and versitygw honour it on
   * `UploadPartCopy`; R2 lists it as NOT IMPLEMENTED there (it implements it
   * on `CopyObject`, which this store does not use). It is a second line of
   * defence and never a caller's only one — a caller whose source another
   * writer can reach must make it unreachable instead.
   */
  readonly sourceIfMatch?: string;
}

export interface ObjectStore {
  /** Write `body` at `key`, unless the key holds an object already. With
   *  `expected`, the bytes must have those facts or nothing is kept.
   *  `options` ride with the object for a reader that fetches it from the
   *  store, and a store with no readers of its own ignores them. */
  put(key: string, body: ObjectBody, expected?: ObjectFacts, options?: PutOptions): Promise<PutOutcome>;
  /**
   * OPTIONAL — a store whose objects are files offers it: make the file at
   * `file`, on this machine, the object at `key` WITHOUT copying it, and drop
   * the source name (so the object never aliases a file somebody may write).
   * `facts` are the file's, already proved by the caller. Disk links; a store
   * with no local files (S3) leaves it out, and the caller `put`s the file.
   */
  link?(key: string, file: string, facts: ObjectFacts): Promise<PutOutcome>;
  /**
   * OPTIONAL — a store a reader can fetch from offers it: a URL that fetches
   * the object at `key` for the next `expiresSeconds`, carrying its own
   * authority, so whoever holds it needs no credential of this store's. S3
   * signs one; disk, whose objects are files on odu's own machine, leaves it
   * out — and `store.presignGet === undefined` is how a caller asks whether
   * reads can leave odu at all.
   */
  presignGet?(key: string, expiresSeconds: number): URL;
  /** The object, or the `range` of it; null when the key is absent. */
  get(key: string, range?: ByteRange): Promise<StoredObject | null>;
  head(key: string): Promise<number | null>;
  /** The STORED object's facts — what `put` recorded — or null when the key is
   *  absent. A read of what was written, never a re-hash of the bytes; an S3
   *  object that carries none fails with {@link UnrecordedObject}, as does one
   *  whose bytes no longer measure what it recorded — a check the store makes
   *  where it can, and cannot make of an answer an intermediary re-encoded. */
  facts(key: string): Promise<ObjectFacts | null>;
  /** Idempotent: deleting an absent key is not an error. */
  delete(key: string): Promise<void>;
  /**
   * THE SAME DELETE, FOR A SET OF KEYS — one request per chunk where the
   * service has such a call (S3's `DeleteObjects`, 1000 keys at a time), a
   * loop where it does not (disk).
   *
   * It exists because a collection is thousands of keys and one signed
   * request each is a collection that does not finish: evicting 6 137 paths
   * off R2 is 12 274 round trips at ~70 a minute, and the service begins
   * answering `429` long before the end. Absent keys are not errors, exactly
   * as {@link delete}'s are not, so a caller may name keys it only believes
   * are there. It either deletes every key it was given or throws.
   */
  deleteMany(keys: readonly string[]): Promise<void>;
  /** Every object under `prefix` (a directory-like prefix: `a/b`), all pages
   *  of it. Temp names are not objects and are never listed. */
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  /** Remove what a dead put left under `prefix` and began before `current`:
   *  temp names, and on S3 incomplete multipart uploads — a sweep for a moment
   *  when the caller knows nothing it owns is writing. A younger one is a live
   *  put. Scoped like `list`, because a store may be shared and only the
   *  caller's prefix is its own. Answers how many it removed. */
  sweepTemp(prefix: string, current: number): Promise<number>;

  // ── THE DIRECT UPLOAD ──────────────────────────────────────────────────
  //
  // OPTIONAL, and all of it or none: a store a WRITER can reach itself offers
  // these, so bytes need not cross the process that owns the credentials. It
  // is `presignGet`'s mirror — S3 signs them; disk, whose objects are files on
  // odu's own machine, leaves them out, and `store.createUpload === undefined`
  // is how a caller asks whether writes can leave odu at all.
  //
  // Nothing here records facts or decides what an object MEANS: a writer that
  // uploaded straight to the store is not trusted, so the bytes land under a
  // temp key, and whoever proves them `copy`s them into place with the facts
  // IT measured. That is the whole of why these are separate from `put`.
  //
  // AND NOTHING HERE PRESIGNS A PLAIN PUT. A multipart upload is the only way
  // in: its parts are writable only until the upload is completed, and after
  // that NO url this store ever signed can write the key — which is what lets
  // a caller prove an object and then act on the proof. A presigned
  // `PutObject` would leave the key writable for as long as the URL lived,
  // and no source precondition closes that everywhere (R2 does not implement
  // `x-amz-copy-source-if-match` on `UploadPartCopy`).

  /** The length every part but the last must have. S3 refuses a short part in
   *  the middle of an upload, so the client is told this number rather than
   *  guessing one the store will reject. */
  readonly partSize?: number;
  /** Open a multipart upload at `key`; answers the id its parts and its
   *  completion carry. The object appears only on {@link completeUpload}. */
  createUpload?(key: string): Promise<string>;
  /** A URL that writes part `index` (0-based) of `uploadId`, for the next
   *  `expiresSeconds`. The writer keeps the ETag the store answers. */
  presignPart?(key: string, uploadId: string, index: number, expiresSeconds: number): URL;
  /** Make the uploaded parts the object at `key` — whatever is there. A
   *  direct upload's key is the writer's own temp name, so there is nothing
   *  to claim; `copy` is the call that makes an object and decides a race. */
  completeUpload?(
    key: string,
    uploadId: string,
    parts: readonly UploadedPart[],
  ): Promise<WriteDecision>;
  /** Drop an upload and its parts. Idempotent: an upload that is not there
   *  is not an error. */
  abortUpload?(key: string, uploadId: string): Promise<void>;
  /** Copy `from` to `to` inside the store — the bytes never leave it — with
   *  `options.facts` recorded on the destination. */
  copy?(from: string, to: string, options: CopyOptions): Promise<WriteDecision>;
}

/**
 * A STORE THAT TAKES ITS OWN BYTES, or null — the one question a caller asks
 * of the direct-upload group, answered beside the interface that declares it.
 *
 * The group is ALL-OR-NOTHING, so this is where "which members are in it"
 * lives: a caller holds the narrowed value and never repeats the list. The
 * part size comes with it, which is why nobody outside this package needs to
 * know S3's own 5 MiB floor — `s3ObjectStore` already holds its `partSize`
 * at or above it.
 */
export type DirectStore = ObjectStore &
  Required<
    Pick<ObjectStore, "partSize" | "createUpload" | "presignPart" | "completeUpload" | "abortUpload" | "copy">
  >;

export function directUploads(store: ObjectStore): DirectStore | null {
  const offered =
    store.partSize !== undefined &&
    store.createUpload !== undefined &&
    store.presignPart !== undefined &&
    store.completeUpload !== undefined &&
    store.abortUpload !== undefined &&
    store.copy !== undefined;
  return offered ? (store as DirectStore) : null;
}

/** A KEY HOLDING BYTES THIS STORE DID NOT RECORD: an S3 object with no
 *  `odu-size`/`odu-sha256` metadata, written by something else. The store
 *  names the key rather than guessing the facts by reading the bytes. */
export class UnrecordedObject extends Error {
  readonly _tag = "UnrecordedObject";
  constructor(readonly key: string) {
    super(`${key} holds an object with no odu-size/odu-sha256 metadata — this store did not write it`);
  }
}

/**
 * A READ THE SERVICE DID NOT KEEP ITS PROMISE ON.
 *
 * A read of a large object is several requests, and S3 resolves each against
 * the key AS IT IS THEN. Three answers say the same thing, and this error says
 * it once: a `412`, when the `If-Match` on the first window's ETag no longer
 * holds; a `416`, for a range the first window's `Content-Range` said was
 * there; and a `206` carrying FEWER bytes than the range asked for.
 *
 * "CHANGED" IS THE READER'S VIEW, NOT A CULPRIT: the object answering now is
 * not the object this read was promised. Whether a key was rewritten between
 * two requests or a service cut a range body short is not knowable from here,
 * and the sentence does not guess — it carries what was seen (the key, the
 * counts, the ETag the read was bound to) and nothing inferred.
 *
 * It is an error rather than a refusal because it happens MID-STREAM, after
 * `get` has answered; the caller learns of it on the stream it is reading.
 * A caller that is proving bytes (`@odu/cache`'s readback) turns it into a
 * refusal of the upload, never a failure of the process.
 */
export class ObjectChanged extends Error {
  readonly _tag = "ObjectChanged";
  constructor(
    readonly key: string,
    /** The version the read was bound to, when the first window named one. */
    readonly etag: string | undefined,
    /** What the service answered, in its own numbers. */
    detail: string,
  ) {
    super(
      `${key} changed while it was being read — ${detail}` +
        (etag === undefined ? "" : ` (the read was bound to ETag ${etag})`),
    );
  }
}

/** A key is a relative path of plain segments: no `..`, no leading slash. */
export function safeKey(key: string): string {
  const clean = key.replaceAll("\\", "/");
  if (clean.startsWith("/") || clean.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`"${key}" is not an object key`);
  }
  return clean;
}

export const TEMP = ".tmp-";
export const isTemp = (key: string): boolean => (key.split("/").at(-1) ?? "").startsWith(TEMP);

/** sha256 and length over a stream as it passes. */
export function factsCounter(): { update(chunk: Uint8Array): void; facts(): ObjectFacts } {
  const hash = createHash("sha256");
  let size = 0;
  return {
    update(chunk) {
      hash.update(chunk);
      size += chunk.length;
    },
    facts: () => ({ size, sha256: hash.digest("hex") }),
  };
}

export const sameFacts = (a: ObjectFacts, b: ObjectFacts): boolean => a.size === b.size && a.sha256 === b.sha256;
