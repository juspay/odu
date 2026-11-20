/**
 * **Objects are immutable, and a put is put-if-absent.** A put onto a key that
 * exists is REFUSED with `exists` and the kept object's facts; of two
 * concurrent puts of one key exactly one wins. Disk links a finished temp file
 * into place (`link` fails on an existing name, where `rename` would replace
 * it); S3 sends `If-None-Match: *` on the write that makes the object visible.
 * No half object is ever visible under its final key: disk's temp names and
 * S3's temp keys are `.tmp-*`, which `list` skips and `sweepTemp` removes.
 */

import { createHash } from "node:crypto";

export interface ObjectFacts {
  size: number;
  /** The sha256 of the stored bytes, as 64 lowercase hex digits. */
  sha256: string;
}

/**
 * A stream is read once. A `Blob` — a file, `Bun.file(path)` — can be read
 * again, so a put whose S3 upload must start over (a `409` on
 * `CompleteMultipartUpload`) restarts it from the beginning itself.
 */
export type ObjectBody = ReadableStream<Uint8Array> | Blob;

/** Bytes `start` through `end`, both inclusive. */
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
 * The response headers an HTTP read of the object answers with. A store that
 * serves its objects itself (S3) keeps them with the object; a store whose
 * objects are plain files ignores them. They are not facts: nothing reads
 * them back, and they never decide a put.
 */
export interface PutOptions {
  readonly contentType?: string;
  readonly cacheControl?: string;
}

/**
 * ONE PART OF A DIRECT UPLOAD, as the writer that sent it reports it: the
 * index it was presigned under and the ETag the store answered. `index` is
 * 0-based, as odu's wire numbers parts; S3's own PartNumber is `index + 1`.
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
 *  CALLER'S — a copy moves bytes it never read. A copy is PUT-IF-ABSENT like
 *  every other write this interface makes visible: `exists` keeps what is
 *  there. */
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
   * the source name. `facts` are the file's, already proved by the caller.
   * Disk links; a store with no local files (S3) leaves it out.
   */
  link?(key: string, file: string, facts: ObjectFacts): Promise<PutOutcome>;
  /**
   * OPTIONAL — a store a reader can fetch from offers it: a URL that fetches
   * the object at `key` for the next `expiresSeconds`, carrying its own
   * authority, so whoever holds it needs no credential of this store's. S3
   * signs one; disk leaves it out, and `store.presignGet === undefined` is how
   * a caller asks whether reads can leave odu at all.
   */
  presignGet?(key: string, expiresSeconds: number): URL;
  /** The object, or the `range` of it; null when the key is absent. */
  get(key: string, range?: ByteRange): Promise<StoredObject | null>;
  head(key: string): Promise<number | null>;
  /** The STORED object's facts — what `put` recorded — or null when the key is
   *  absent. A read of what was written, never a re-hash of the bytes; an S3
   *  object that carries none fails with {@link UnrecordedObject}, as does one
   *  whose bytes no longer measure what it recorded. */
  facts(key: string): Promise<ObjectFacts | null>;
  /** Idempotent: deleting an absent key is not an error. */
  delete(key: string): Promise<void>;
  /**
   * THE SAME DELETE, FOR A SET OF KEYS — one request per chunk where the
   * service has such a call (S3's `DeleteObjects`, 1000 keys at a time), a
   * loop where it does not (disk). Absent keys are not errors, exactly as
   * {@link delete}'s are not. It either deletes every key it was given or
   * throws.
   */
  deleteMany(keys: readonly string[]): Promise<void>;
  /** Every object under `prefix` (a directory-like prefix: `a/b`), all pages
   *  of it. Temp names are not objects and are never listed. */
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  /** Remove what a dead put left under `prefix` and began before `current`:
   *  temp names, and on S3 incomplete multipart uploads. A younger one is a
   *  live put. Scoped like `list`. Answers how many it removed. */
  sweepTemp(prefix: string, current: number): Promise<number>;

  // AND NOTHING HERE PRESIGNS A PLAIN PUT. A multipart upload is the only way
  // in: its parts are writable only until the upload is completed, and after
  // that NO url this store ever signed can write the key — which is what lets
  // a caller prove an object and then act on the proof. A presigned
  // `PutObject` would leave the key writable for as long as the URL lived,
  // and no source precondition closes that everywhere (R2 does not implement
  // `x-amz-copy-source-if-match` on `UploadPartCopy`).

  /** The length every part but the last must have. S3 refuses a short part in
   *  the middle of an upload. */
  readonly partSize?: number;
  /** Open a multipart upload at `key`; answers the id its parts and its
   *  completion carry. The object appears only on {@link completeUpload}. */
  createUpload?(key: string): Promise<string>;
  /** A URL that writes part `index` (0-based) of `uploadId`, for the next
   *  `expiresSeconds`. The writer keeps the ETag the store answers. */
  presignPart?(key: string, uploadId: string, index: number, expiresSeconds: number): URL;
  /** Make the uploaded parts the object at `key` — whatever is there. */
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

export class UnrecordedObject extends Error {
  readonly _tag = "UnrecordedObject";
  constructor(readonly key: string) {
    super(`${key} holds an object with no odu-size/odu-sha256 metadata — this store did not write it`);
  }
}

/**
 * A read of a large object is several requests, and S3 resolves each against
 * the key AS IT IS THEN: a `412`, when the `If-Match` on the first window's
 * ETag no longer holds; a `416`, for a range the first window's
 * `Content-Range` said was there; and a `206` carrying FEWER bytes than the
 * range asked for. Thrown MID-STREAM, after `get` has answered; the caller
 * learns of it on the stream it is reading.
 */
export class ObjectChanged extends Error {
  readonly _tag = "ObjectChanged";
  constructor(
    readonly key: string,
    /** The version the read was bound to, when the first window named one. */
    readonly etag: string | undefined,
    detail: string,
  ) {
    super(
      `${key} changed while it was being read — ${detail}` +
        (etag === undefined ? "" : ` (the read was bound to ETag ${etag})`),
    );
  }
}

export function safeKey(key: string): string {
  const clean = key.replaceAll("\\", "/");
  if (clean.startsWith("/") || clean.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`"${key}" is not an object key`);
  }
  return clean;
}

export const TEMP = ".tmp-";
export const isTemp = (key: string): boolean => (key.split("/").at(-1) ?? "").startsWith(TEMP);

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
