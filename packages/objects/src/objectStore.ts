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
   *  object that carries none fails with {@link UnrecordedObject}. */
  facts(key: string): Promise<ObjectFacts | null>;
  /** Idempotent: deleting an absent key is not an error. */
  delete(key: string): Promise<void>;
  /** Every object under `prefix` (a directory-like prefix: `a/b`), all pages
   *  of it. Temp names are not objects and are never listed. */
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  /** Remove what a dead put left under `prefix` and began before `current`:
   *  temp names, and on S3 incomplete multipart uploads — a sweep for a moment
   *  when the caller knows nothing it owns is writing. A younger one is a live
   *  put. Scoped like `list`, because a store may be shared and only the
   *  caller's prefix is its own. Answers how many it removed. */
  sweepTemp(prefix: string, current: number): Promise<number>;
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
