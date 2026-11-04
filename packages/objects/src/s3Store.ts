/**
 * THE S3 STORE — any S3-compatible service. What a store promises is
 * `./objectStore`'s; this module is how S3's protocol keeps it (see
 * `s3ObjectStore`).
 */

import { randomUUID } from "node:crypto";
import { S3Client } from "bun";
import {
  factsCounter,
  isTemp,
  type ObjectFacts,
  type ObjectStore,
  type PutOptions,
  type PutOutcome,
  safeKey,
  sameFacts,
  TEMP,
  UnrecordedObject,
  type UploadedPart,
  type WriteDecision,
} from "./objectStore";
import { presign, presignGet, s3Fetch, type S3Request, type S3Target } from "./s3sign";
import { newChain, type Chain, serial } from "./serial";

export interface S3ObjectStoreOptions {
  /** Where the bucket is and who may write it — `./declarations` reads it
   *  from a declaration and its credentials file. */
  target: S3Target;
  /** One multipart part, buffered while it uploads. S3's floor is 5 MiB. */
  partSize?: number;
  /** Parts uploaded at once (default 4). A put holds this many part buffers,
   *  reused, and reads a part only when one is free; `fetch` keeps its own
   *  copy of a body while sending it, so a 300 MiB put measured 51–56 MiB of
   *  growth at 4 × 5 MiB, against 20–24 MiB one part at a time. */
  parallelParts?: number;
  /** Keys per LIST request; `list` pages through all of them. */
  listPageSize?: number;
  /** How the signed requests are sent — `fetch`, unless a suite stages an
   *  answer no gateway gives (a `409`). */
  send?: typeof fetch;
}

/** The metadata names `put` writes and `facts` reads. */
const META_SIZE = "x-amz-meta-odu-size";
const META_SHA256 = "x-amz-meta-odu-sha256";
/**
 * HOW MUCH OF AN OBJECT ONE READ HOLDS. Bun's S3 stream — and `fetch`'s body
 * under it — does NOT apply backpressure: measured with a consumer that pauses
 * 1 ms every four chunks, a 200 MiB object grew RSS by 274 MiB through
 * `S3File.stream()` and 208 MiB through a plain `fetch`. A slow reader would
 * make the process hold the whole object. So `get` reads in WINDOWS of ranged
 * GETs, at most TWO in flight: the one being read, and the next, fetched while
 * it is (so a window costs no idle round trip). Cancelling the read aborts both.
 *
 * THE PREFETCHED WINDOW IS READ INTO ONE BUFFER (`arrayBuffer()`), not left as
 * an unread body: `fetch` reads a body ahead regardless, and an unread one cost
 * far more than its MiB. 300 MiB to a slow reader, fresh processes, one idle
 * machine: 66–84 MiB of growth with an unread body prefetched (99 on CI), 43–62
 * with no prefetch, 41–59 with the prefetch in one buffer. So a read holds at
 * most the window being read plus one buffered: 2 × READ_WINDOW of body.
 *
 * 1 MiB, measured in a fresh process on a 300 MiB read by a slow reader: peak
 * growth 52–55 MiB at 1 MiB, 62–66 at 2, 79–82 at 4, 75–87 at 8, and the same
 * at 600 MiB as at 200 — a floor of Bun's own, not the object. The cost is a
 * GET per MiB.
 */
const READ_WINDOW = 1024 * 1024;
/** A buffered window reaches the reader in pieces of this size. */
const READ_PIECE = 64 * 1024;
/** UploadPartCopy's ceiling is 5 GiB a part; 1 GiB keeps a copy's parts few. */
const COPY_PART = 1024 * 1024 * 1024;

/** An S3 call that answered something other than what it promised. */
class S3Failure extends Error {
  constructor(what: string, response: Response, body: string) {
    super(`${what}: ${response.status} ${body.slice(0, 300)}`);
  }
}

const metaOf = (facts: ObjectFacts): Record<string, string> => ({
  [META_SIZE]: String(facts.size),
  [META_SHA256]: facts.sha256,
});

/** The response headers the object will answer a READER with, in S3's
 *  spelling: kept with the object by the call that creates it, which for a
 *  multipart object is the CreateMultipartUpload and not the Complete. */
const headersOf = (options?: PutOptions): Record<string, string> => ({
  ...(options?.contentType === undefined ? {} : { "content-type": options.contentType }),
  ...(options?.cacheControl === undefined ? {} : { "cache-control": options.cacheControl }),
});

/** The value of one XML element, as S3 spells its few answers. */
const xmlValue = (xml: string, element: string): string | null => {
  const found = new RegExp(`<${element}>([^<]*)</${element}>`).exec(xml);
  return found === null ? null : (found[1] as string).replaceAll("&#34;", '"').replaceAll("&quot;", '"');
};

/**
 * HOW A CONDITIONAL WRITE IS DECIDED. `412 Precondition Failed` is the only
 * "lost": another writer's object is at the key. `409 Conflict` decides
 * NOTHING — AWS answers it when a concurrent delete (or, on versitygw and R2,
 * another conditional write: `ConditionalRequestConflict`) was in flight, and
 * either may yet fail — so the write is sent again after each of these pauses,
 * and a write still conflicted after the last is refused with `conflict`.
 */
const CONFLICT_BACKOFF_MS = [50, 100, 200, 400, 800] as const;
const CONFLICT_TRIES = CONFLICT_BACKOFF_MS.length + 1;
const conflicted = (key: string, tries: number): PutOutcome => ({
  ok: false,
  refusal: { kind: "conflict", key, tries },
});
/** How one conditional request was decided. `source_changed` is a COPY's
 *  alone: the source carried a precondition and no longer matches it. */
type Decided = "won" | "lost" | "conflict" | "source_changed";
const decidedBy = (response: Response): Decided =>
  response.status === 412 ? "lost" : response.status === 409 ? "conflict" : "won";

/** The same answers in the interface's words, for a write whose bytes this
 *  process is not holding and so cannot send again. */
const asDecision = (decided: Decided): WriteDecision =>
  decided === "won"
    ? "stored"
    : decided === "lost"
      ? "exists"
      : decided === "source_changed"
        ? "source_changed"
        : "conflict";

/**
 * THE ETAGS OF A DIRECT UPLOAD'S PARTS, in part order. The writer reports what
 * it sent, so the set is checked before S3 is told anything: exactly the
 * indexes `0..n-1`, each once. A gap would make S3 glue the remaining parts
 * into an object nobody uploaded, with a hash the prover never measured — so a
 * set that is not that is refused here, naming what arrived.
 */
function etagsInOrder(key: string, parts: readonly UploadedPart[]): string[] {
  const ordered = [...parts].sort((a, b) => a.index - b.index);
  if (ordered.length === 0 || ordered.some((part, at) => part.index !== at)) {
    throw new Error(
      `CompleteMultipartUpload ${key}: an upload's parts are 0..n-1, each exactly once; ` +
        `${parts.length} arrived, indexes [${parts.map((part) => part.index).join(", ")}]`,
    );
  }
  return ordered.map((part) => part.etag);
}

/** Run `attempt` until it is not a conflict, pausing between tries; still
 *  `"conflict"` after {@link CONFLICT_TRIES} of them. */
async function untilDecided<T>(attempt: () => Promise<T | "conflict">): Promise<T | "conflict"> {
  for (let tries = 1; ; tries += 1) {
    const outcome = await attempt();
    const pause = CONFLICT_BACKOFF_MS[tries - 1];
    if (outcome !== "conflict" || pause === undefined) return outcome;
    await Bun.sleep(pause);
  }
}

/**
 * AN S3-COMPATIBLE STORE: R2, AWS, Garage, versitygw.
 *
 * Lists go through Bun's `S3Client`. Everything else is signed by `./s3sign`:
 * the writes and the metadata HEAD, because Bun's client sends neither
 * `If-None-Match` nor `x-amz-meta-*`, and those carry this store's two
 * promises; and the reads, because a read learns the object's size from its
 * first GET's `Content-Range`, which Bun's `S3File` does not show.
 *
 * Multipart is this store's business: a put uploads up to `parallelParts` (4)
 * parts at once and buffers only those, so its memory is bounded by them (see
 * `parallelParts`) whatever the object's length.
 *
 * **Exactly one writer per key — what holds, and where.** In this process,
 * writes of one key queue behind each other (`oneWriter`) after a HEAD, so the
 * second sees the first's object and is refused. Across processes, the write
 * that makes an object visible carries `If-None-Match: *`, and how much that
 * buys is the service's:
 *
 * - AWS honours it on `PutObject` and `CompleteMultipartUpload`, first to
 *   finish wins and the rest get `412`
 *   (docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).
 * - R2 evaluates it atomically on `PutObject`, at most one of several writes
 *   succeeding (developers.cloudflare.com/r2/api/s3/api/), and documents NO
 *   conditional header on `CompleteMultipartUpload`. So on R2 an object of one
 *   part (`partSize`, 8 MiB) is put-if-absent across processes, and a larger
 *   one is put-if-absent only within this process: two processes completing
 *   one key at once could leave the later one's object, its metadata with it.
 * - versitygw (the suite's gateway) checks the precondition and THEN writes,
 *   so two truly concurrent conditional PUTs can both succeed — the
 *   contract's race case failed on that before `oneWriter`. It DOES honour
 *   `If-None-Match: *` on `CompleteMultipartUpload` (a `412`, measured by the
 *   contract's conditional-completion case), which is what `copy`'s decision
 *   rests on there.
 *
 * A DIRECT UPLOAD IS DECIDED BY THE SAME HEADER, on the same two calls, and
 * promises exactly as much. `completeUpload(..., { ifAbsent: true })` and
 * `copy(..., { ifAbsent: true })` both finish a multipart upload, and R2
 * HONOURS the precondition there — `412 PreconditionFailed`, measured against
 * bucket `kolu` on 2026-11-03, though Cloudflare documents it only on
 * `PutObject` — as AWS and versitygw do. First-kept-wins therefore holds
 * across processes on all three, at any object size.
 *
 * WHAT R2 DOES NOT IMPLEMENT is the SOURCE condition on a copy's parts:
 * `x-amz-copy-source-if-match` is listed as not implemented on
 * `UploadPartCopy` (it is implemented on `CopyObject`, which this store does
 * not use). So `CopyOptions.sourceIfMatch` binds a copy on AWS and versitygw
 * and is IGNORED on R2, and a caller whose source some other writer can
 * reach must not rest on it — see `@odu/cache`'s direct upload, which hands
 * out no URL that can write the key it proves.
 *
 * Neither call measures anything: a direct upload's bytes never passed
 * through odu, so the facts recorded at the destination are the CALLER'S
 * (`CopyOptions.facts`), and an object made by `completeUpload` alone carries
 * no facts at all — `facts()` refuses it as an {@link UnrecordedObject} until
 * something copies it into place with them.
 */
export function s3ObjectStore(options: S3ObjectStoreOptions): ObjectStore {
  const { target } = options;
  const send = options.send ?? fetch;
  const call = (method: string, key: string, request?: S3Request): Promise<Response> =>
    s3Fetch(target, method, key, request, send);
  const partSize = Math.max(options.partSize ?? 8 * 1024 * 1024, 5 * 1024 * 1024);
  const pageSize = options.listPageSize ?? 1000;
  const parallel = Math.max(1, options.parallelParts ?? 4);
  const client = new S3Client({
    endpoint: target.endpoint.href,
    bucket: target.bucket,
    region: target.region,
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
    ...(target.sessionToken === undefined ? {} : { sessionToken: target.sessionToken }),
  });

  /** Writes of one key, one at a time — see the header. A chain is dropped
   *  when nothing is queued behind it, so the map holds only live keys. */
  const writing = new Map<string, Chain>();
  function oneWriter<T>(key: string, work: () => Promise<T>): Promise<T> {
    let chain = writing.get(key);
    if (chain === undefined) {
      chain = newChain();
      writing.set(key, chain);
    }
    const queued = serial(chain, work);
    const tail = chain.tail;
    const done = (): void => {
      if (writing.get(key)?.tail === tail) writing.delete(key);
    };
    queued.then(done, done);
    return queued;
  }

  /**
   * One HEAD: the object's length and the facts its put wrote, or null.
   *
   * TWO NUMBERS, FROM TWO PLACES. `x-amz-meta-odu-size` is what this store
   * RECORDED beside the bytes; `content-length` is what the ANSWER MEASURED,
   * and an answer an intermediary re-encoded measured its own body rather
   * than the object. Every request asks for `identity` (`s3Fetch`), so this
   * is the case an edge that ignores the ask leaves behind: R2 sits behind
   * Cloudflare, which compresses a compressible content type (`text/plain` —
   * a bucket's `nix-cache-info`) and answers the HEAD with
   * `content-encoding` and NO `content-length` at all. Checking the record
   * against that header read the object as one no odu wrote
   * (`UnrecordedObject`), and the backfill refused to rewrite its own
   * `nix-cache-info` on every boot (#151), while the narinfos beside it —
   * `text/x-nix-narinfo`, which no edge compresses — round-tripped.
   *
   * So the record answers, and an answer that measured the OBJECT still
   * checks it: bytes replaced behind the store's back, under the metadata it
   * wrote, are an {@link UnrecordedObject} as they always were.
   */
  async function headOf(key: string): Promise<{ size: number; facts: ObjectFacts | null } | null> {
    const response = await call("HEAD", safeKey(key));
    if (response.status === 404) return null;
    if (!response.ok) throw new S3Failure(`HEAD ${key}`, response, "");
    /** A count a header states, or null when it states none this can use. */
    const counted = (header: string): number | null => {
      const value = Number(response.headers.get(header) ?? Number.NaN);
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    };
    // WHAT THE ANSWER MEASURED OF THE OBJECT: nothing, if it was re-encoded.
    const measured = response.headers.get("content-encoding") === null ? counted("content-length") : null;
    const sha256 = response.headers.get(META_SHA256);
    const size = counted(META_SIZE);
    const recorded = sha256 !== null && size !== null ? { size, sha256 } : null;
    if (recorded !== null && (measured === null || measured === recorded.size)) {
      return { size: recorded.size, facts: recorded };
    }
    // NO RECORD, or one the bytes contradict: the answer's own number is all
    // there is, and `facts` refuses the key either way.
    return { size: measured ?? 0, facts: null };
  }

  async function deleteKey(key: string): Promise<void> {
    const response = await call("DELETE", key);
    const body = await response.text();
    if (!response.ok && response.status !== 404) throw new S3Failure(`DELETE ${key}`, response, body);
  }

  async function factsOf(key: string): Promise<ObjectFacts | null> {
    const found = await headOf(key);
    if (found === null) return null;
    if (found.facts === null) throw new UnrecordedObject(key);
    return found.facts;
  }

  async function exists(key: string): Promise<PutOutcome> {
    const facts = await factsOf(key);
    if (facts === null) throw new Error(`${key} vanished while its put was refused`);
    return { ok: false, refusal: { kind: "exists", key, facts } };
  }

  /** Fill `buffer` from `reader`, carrying a chunk that overflows it. Answers
   *  how many bytes it holds; fewer than its length means the stream ended. */
  function partReader(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    let carry: Uint8Array | null = null;
    let done = false;
    return {
      async fill(buffer: Uint8Array): Promise<number> {
        let at = 0;
        while (at < buffer.length) {
          let chunk = carry;
          carry = null;
          if (chunk === null) {
            if (done) break;
            const next = await reader.read();
            if (next.done) {
              done = true;
              break;
            }
            chunk = next.value;
          }
          const take = Math.min(chunk.length, buffer.length - at);
          buffer.set(chunk.subarray(0, take), at);
          at += take;
          if (take < chunk.length) carry = chunk.subarray(take);
        }
        return at;
      },
      cancel: (reason?: unknown) => reader.cancel(reason).catch(() => {}),
    };
  }

  async function createUpload(key: string, headers: Record<string, string>): Promise<string> {
    const response = await call("POST", key, { query: { uploads: "" }, headers });
    const body = await response.text();
    const id = response.ok ? xmlValue(body, "UploadId") : null;
    if (id === null) throw new S3Failure(`CreateMultipartUpload ${key}`, response, body);
    return id;
  }

  const abort = (key: string, uploadId: string): Promise<void> =>
    call("DELETE", key, { query: { uploadId } }).then(
      (response) => void response.body?.cancel(),
      () => {},
    );

  /** Complete an upload: `lost` on `412`, and `conflict` on `409` — after
   *  which AWS wants the upload STARTED AGAIN, never completed again. */
  async function complete(
    key: string,
    uploadId: string,
    etags: readonly string[],
    conditional: boolean,
  ): Promise<Decided> {
    const body =
      "<CompleteMultipartUpload>" +
      etags.map((etag, at) => `<Part><PartNumber>${at + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join("") +
      "</CompleteMultipartUpload>";
    const response = await call("POST", key, {
      query: { uploadId },
      headers: conditional ? { "if-none-match": "*" } : {},
      body,
    });
    const text = await response.text();
    const decided = conditional ? decidedBy(response) : "won";
    if (decided !== "won") return decided;
    // A COMPLETE CAN FAIL WITH 200: S3 sends the status before it knows, and
    // reports the failure as an `<Error>` body.
    if (!response.ok || text.includes("<Error>")) {
      throw new S3Failure(`CompleteMultipartUpload ${key}`, response, text);
    }
    return "won";
  }

  /**
   * MAKE `tempKey`'s bytes the object at `key`, with `facts` as metadata —
   * server-side, part by part. `conditional` sends the `If-None-Match: *`
   * every other write of this store sends; a caller that has already decided
   * the key is its own (a `copy` the caller asked for unconditionally) clears
   * it. The case that needs the copy at all is a write whose facts were not
   * known up front: metadata is fixed when an upload is created, and the hash
   * is known only at the end — a multipart put's, or a direct upload's, which
   * this process never read at all.
   *
   * `sourceVersion` BINDS IT TO BYTES SOMEBODY MEASURED. Every part is its own
   * request and S3 resolves the source afresh for each, so a source that can
   * still be written — a direct upload's temp key, whose presigned PUT the
   * client holds for ten minutes — could be a different object by the time it
   * is copied, and the destination would carry the facts of bytes it does not
   * hold. With it, each `UploadPartCopy` carries
   * `x-amz-copy-source-if-match` and a `412` ends the copy as
   * `source_changed`.
   */
  async function copyInto(
    key: string,
    tempKey: string,
    facts: ObjectFacts,
    options: PutOptions | undefined,
    conditional: boolean,
    sourceVersion?: string,
  ): Promise<Decided> {
    const uploadId = await createUpload(key, { ...metaOf(facts), ...headersOf(options) });
    try {
      const etags: string[] = [];
      for (let start = 0, part = 1; start < facts.size; start += COPY_PART, part += 1) {
        const end = Math.min(start + COPY_PART, facts.size) - 1;
        const response = await call("PUT", key, {
          query: { partNumber: String(part), uploadId },
          headers: {
            "x-amz-copy-source": `/${target.bucket}/${tempKey}`,
            "x-amz-copy-source-range": `bytes=${start}-${end}`,
            ...(sourceVersion === undefined ? {} : { "x-amz-copy-source-if-match": sourceVersion }),
          },
        });
        const body = await response.text();
        // THE SOURCE IS NOT WHAT IT WAS. Nothing is kept: the upload is
        // aborted below and the caller is told which refusal this is.
        if (response.status === 412) {
          await abort(key, uploadId);
          return "source_changed";
        }
        const etag = response.ok ? xmlValue(body, "ETag") : null;
        if (etag === null) throw new S3Failure(`UploadPartCopy ${key}`, response, body);
        etags.push(etag);
      }
      const decided = await complete(key, uploadId, etags, conditional);
      if (decided !== "won") await abort(key, uploadId);
      return decided;
    } catch (err) {
      await abort(key, uploadId);
      throw err;
    }
  }

  async function putOnce(
    key: string,
    stream: ReadableStream<Uint8Array>,
    expected?: ObjectFacts,
    options?: PutOptions,
  ): Promise<PutOutcome> {
    safeKey(key);
    // ASKED FIRST so a re-push costs a HEAD rather than an upload; the
    // conditional write below is what actually decides a race.
    if ((await headOf(key)) !== null) {
      await stream.cancel().catch(() => {});
      return exists(key);
    }
    const parts = partReader(stream);
    const counter = factsCounter();
    const buffer = new Uint8Array(partSize);
    let filled: number;
    try {
      filled = await parts.fill(buffer);
    } catch (err) {
      await parts.cancel(err);
      throw err;
    }
    const first = buffer.subarray(0, filled);
    counter.update(first);
    const mismatch = (facts: ObjectFacts): PutOutcome | null =>
      expected !== undefined && !sameFacts(expected, facts)
        ? { ok: false, refusal: { kind: "facts_mismatch", key, expected, actual: facts } }
        : null;

    if (filled < partSize) {
      // ONE PART IS THE WHOLE OBJECT: a single conditional PUT, facts and all.
      const facts = counter.facts();
      const refused = mismatch(facts);
      if (refused !== null) return refused;
      // The bytes are in hand, so a `409` is answered by sending them again.
      const decided = await untilDecided(async () => {
        const response = await call("PUT", key, {
          headers: {
            "if-none-match": "*",
            "content-length": String(filled),
            ...metaOf(facts),
            ...headersOf(options),
          },
          body: first as Uint8Array<ArrayBuffer>,
        });
        const text = await response.text();
        const decided = decidedBy(response);
        if (decided === "won" && !response.ok) throw new S3Failure(`PUT ${key}`, response, text);
        return decided;
      });
      if (decided === "conflict") return conflicted(key, CONFLICT_TRIES);
      return decided === "won" ? { ok: true, facts } : exists(key);
    }

    // MULTIPART. With the facts promised up front the upload goes straight to
    // the key, metadata attached; without them it goes to a temp key and is
    // copied into place once the hash is known.
    const direct = expected !== undefined;
    const uploadKey = direct ? key : `${key.slice(0, key.lastIndexOf("/") + 1)}${TEMP}${randomUUID()}`;
    const uploadId = await createUpload(uploadKey, direct ? { ...metaOf(expected), ...headersOf(options) } : {});
    // PARTS IN PARALLEL, `parallel` at a time. The stream is read in order —
    // the hash needs that — and a part is read only once a slot is free, into
    // one of `parallel` buffers that are REUSED (a fresh buffer per part left
    // RSS waiting on the collector), so a put holds `parallel` parts. The
    // first failure aborts its siblings' requests and, below, the upload once.
    // `etags` is by number, so Complete lists the parts in order whichever
    // finished first.
    const etags: string[] = [];
    const control = new AbortController();
    const inFlight = new Set<Promise<void>>();
    const free: Uint8Array<ArrayBuffer>[] = [];
    let failed: { error: unknown } | null = null;
    const send = (number: number, bytes: Uint8Array, owner: Uint8Array<ArrayBuffer>): void => {
      const tracked: Promise<void> = (async () => {
        const response = await call("PUT", uploadKey, {
          query: { partNumber: String(number), uploadId },
          headers: { "content-length": String(bytes.length) },
          body: bytes as Uint8Array<ArrayBuffer>,
          signal: control.signal,
        });
        const text = await response.text();
        const etag = response.headers.get("etag");
        if (!response.ok || etag === null) throw new S3Failure(`UploadPart ${uploadKey}`, response, text);
        etags[number - 1] = etag;
      })().then(
        () => {
          inFlight.delete(tracked);
          free.push(owner);
        },
        (error: unknown) => {
          inFlight.delete(tracked);
          free.push(owner);
          if (failed === null) {
            failed = { error };
            control.abort(error);
          }
        },
      );
      inFlight.add(tracked);
    };
    try {
      let part: Uint8Array = first;
      let owner = buffer;
      for (let number = 1; ; number += 1) {
        send(number, part, owner);
        if (part.length < partSize) break;
        while (inFlight.size >= parallel && failed === null) await Promise.race(inFlight);
        if (failed !== null) break;
        owner = free.pop() ?? new Uint8Array(partSize);
        const read = await parts.fill(owner);
        if (read === 0) break;
        part = owner.subarray(0, read);
        counter.update(part);
      }
      await Promise.all(inFlight);
      if (failed !== null) throw (failed as { error: unknown }).error;
    } catch (err) {
      control.abort(err);
      await Promise.allSettled(inFlight);
      await parts.cancel(err);
      await abort(uploadKey, uploadId);
      throw err;
    }
    const facts = counter.facts();
    const refused = mismatch(facts);
    if (refused !== null) {
      await abort(uploadKey, uploadId);
      return refused;
    }
    if (direct) {
      const decided = await complete(key, uploadId, etags, true);
      if (decided === "won") return { ok: true, facts };
      await abort(key, uploadId);
      // A CONFLICTED UPLOAD must be started again: `put` does that for a body
      // it can read again, and tells a stream's caller.
      if (decided === "conflict") return conflicted(key, 1);
      return exists(key);
    }
    await complete(uploadKey, uploadId, etags, false);
    try {
      // The temp object stays put, so a conflicted copy is simply started again.
      const decided = await untilDecided(() => copyInto(key, uploadKey, facts, options, true));
      if (decided === "conflict") return conflicted(key, CONFLICT_TRIES);
      return decided === "won" ? { ok: true, facts } : await exists(key);
    } finally {
      await deleteKey(uploadKey).catch(() => {});
    }
  }

  /** One window: a ranged GET of bytes `from`..`to` (inclusive). `version` is
   *  the ETag the read is held to, so a key rewritten mid-read fails the read
   *  instead of splicing two objects together. */
  const fetchWindow = (
    key: string,
    from: number,
    to: number,
    signal: AbortSignal,
    version?: string,
  ): Promise<Response> =>
    call("GET", key, {
      headers: { range: `bytes=${from}-${to}`, ...(version === undefined ? {} : { "if-match": version }) },
      signal,
    });

  /** `bytes <first>-<last>/<size>` (a 206), or `bytes *\/<size>` (a 416). */
  const contentRange = (response: Response): { last: number | null; size: number } | null => {
    const found = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
    if (found === null) return null;
    return { last: found[2] === undefined ? null : Number(found[2]), size: Number(found[3]) };
  };

  /**
   * The bytes after the first window up to `end`, as a pull stream: ONE window
   * being read and ONE prefetched, never more (see READ_WINDOW). The first
   * window's response is `get`'s, already in hand, holding bytes `start`
   * through `from - 1`; `control` aborts every GET in flight when the reader
   * cancels.
   *
   * EVERY WINDOW MUST BE AS LONG AS ITS RANGE. The caller has already promised
   * the length (a `content-length` from the row), so a window that answers 206
   * with fewer bytes would truncate the object WITHOUT an error, and the client
   * would see only a hash mismatch. It fails the stream with an `S3Failure`
   * naming the key and the counts instead.
   *
   * AND EVERY WINDOW MUST BE THE SAME OBJECT. A read of several windows is
   * several requests, and S3 resolves each against the key AS IT IS THEN — so
   * a key rewritten between two of them would hand the reader a splice of two
   * objects, hashing to nothing either of them has. Each window after the
   * first carries `If-Match` on the first's ETag, and a `412` fails the read.
   */
  function windowed(
    key: string,
    first: Response,
    start: number,
    from: number,
    end: number,
    control: AbortController,
  ): ReadableStream<Uint8Array> {
    const version = first.headers.get("etag") ?? undefined;
    const short = (response: Response, span: number, got: number): S3Failure =>
      new S3Failure(`GET ${key} (a window)`, response, `answered ${got} of the ${span} bytes asked for`);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = (first.body as ReadableStream<Uint8Array>).getReader();
    let firstRead = 0;
    let position = from;
    let pieces: Uint8Array[] = [];
    const open = (): Promise<ArrayBuffer> | null => {
      if (position > end) return null;
      const to = Math.min(position + READ_WINDOW, end + 1) - 1;
      const span = to - position + 1;
      const next = fetchWindow(key, position, to, control.signal, version).then(async (response) => {
        if (response.status !== 206) {
          const body = await response.text().catch(() => "");
          throw new S3Failure(`GET ${key} (a window)`, response, body);
        }
        const window = await response.arrayBuffer();
        if (window.byteLength !== span) throw short(response, span, window.byteLength);
        return window;
      });
      position = to + 1;
      // A REJECTED PREFETCH is read when its turn comes, not reported twice.
      next.catch(() => {});
      return next;
    };
    let prefetched = open();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          const piece = pieces.shift();
          if (piece !== undefined) {
            controller.enqueue(piece);
            return;
          }
          if (reader !== null) {
            const next = await reader.read();
            if (!next.done) {
              firstRead += next.value.length;
              controller.enqueue(next.value);
              return;
            }
            reader = null;
            if (firstRead !== from - start) {
              control.abort();
              throw short(first, from - start, firstRead);
            }
          }
          if (prefetched === null) {
            controller.close();
            return;
          }
          const window = await prefetched.catch((err: unknown) => {
            control.abort();
            throw err;
          });
          prefetched = open();
          // Views of the one buffer, in the chunk size a stream reader expects.
          pieces = [];
          for (let at = 0; at < window.byteLength; at += READ_PIECE) {
            pieces.push(new Uint8Array(window, at, Math.min(READ_PIECE, window.byteLength - at)));
          }
        }
      },
      async cancel(reason) {
        control.abort(reason);
        await reader?.cancel(reason).catch(() => {});
      },
    });
  }

  /**
   * Every INCOMPLETE multipart upload under `prefix` — what ListObjects never
   * shows. `initiated` is the service's clock.
   *
   * PAGED BY `key-marker` ALONE: versitygw 1.7.0 refuses the `upload-id-marker`
   * it hands out (400 "Invalid uploadId marker"). The cost: a page that ends
   * part-way through one key's uploads skips that key's remaining ones, which
   * the next sweep reaches. A key has more than one upload only when more than
   * one process died putting it.
   */
  async function listUploads(prefix: string): Promise<{ key: string; uploadId: string; initiated: number }[]> {
    const out: { key: string; uploadId: string; initiated: number }[] = [];
    let marker: Record<string, string> = {};
    for (;;) {
      const response = await call("GET", "", {
        query: { uploads: "", "max-uploads": String(pageSize), ...(prefix === "" ? {} : { prefix }), ...marker },
      });
      const body = await response.text();
      if (!response.ok) throw new S3Failure(`ListMultipartUploads ${prefix}`, response, body);
      for (const [, upload] of body.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)) {
        const key = xmlValue(upload as string, "Key");
        const uploadId = xmlValue(upload as string, "UploadId");
        const initiated = Date.parse(xmlValue(upload as string, "Initiated") ?? "");
        if (key !== null && uploadId !== null && !Number.isNaN(initiated)) out.push({ key, uploadId, initiated });
      }
      const next = xmlValue(body, "NextKeyMarker");
      if (xmlValue(body, "IsTruncated") !== "true" || next === null || next === "") return out;
      marker = { "key-marker": next };
    }
  }

  /** Every key under `prefix`, temp names included, every page of them. */
  async function listAll(prefix: string): Promise<{ key: string; size: number; lastModified: number }[]> {
    const out: { key: string; size: number; lastModified: number }[] = [];
    let token: string | undefined;
    for (;;) {
      const page = await client.list({
        ...(prefix === "" ? {} : { prefix }),
        maxKeys: pageSize,
        ...(token === undefined ? {} : { continuationToken: token }),
      });
      for (const entry of page.contents ?? []) {
        out.push({
          key: entry.key,
          size: entry.size ?? 0,
          lastModified: entry.lastModified === undefined ? 0 : Date.parse(entry.lastModified),
        });
      }
      token = page.nextContinuationToken;
      if (page.isTruncated !== true || token === undefined) return out;
    }
  }

  return {
    // A BODY THAT CAN BE READ AGAIN (a Blob) restarts a conflicted multipart
    // upload whole — what AWS asks of a `409` on `CompleteMultipartUpload`. A
    // stream is read once.
    put: (key, body, expected, options) =>
      oneWriter(key, async () => {
        if (!(body instanceof Blob)) return putOnce(key, body, expected, options);
        const outcome = await untilDecided(async () => {
          const once = await putOnce(key, body.stream(), expected, options);
          return !once.ok && once.refusal.kind === "conflict" ? "conflict" : once;
        });
        return outcome === "conflict" ? conflicted(key, CONFLICT_TRIES) : outcome;
      }),

    // A URL OF ITS OWN: this store's objects are fetchable by anybody holding
    // a signature, so odu may answer a read with one instead of the bytes.
    presignGet: (key, expiresSeconds) => presignGet(target, safeKey(key), expiresSeconds),

    // ── THE DIRECT UPLOAD ────────────────────────────────────────────────
    //
    // WHAT THE WRITER DOES ITSELF, with URLs that carry their own authority:
    // sends the parts. What this store still does: open and finish the upload,
    // and copy the finished bytes into place once somebody has proved them.
    // Nothing here measures anything — the facts come with the `copy`.
    //
    // A MULTIPART UPLOAD IS THE ONLY WAY IN. Its part URLs stop writing when
    // the upload is completed, so the finished key has no writer this store
    // ever signed for — which is what makes a proof of it worth anything.

    partSize,

    // NO METADATA: these bytes are a temp object whose facts nobody has proved
    // yet, and an upload's metadata is fixed here, before the first byte.
    createUpload: (key) => createUpload(safeKey(key), {}),

    // `partNumber` AND `uploadId` ARE SIGNED, so the URL writes that part of
    // that upload and no other.
    presignPart: (key, uploadId, index, expiresSeconds) =>
      presign(target, "PUT", safeKey(key), expiresSeconds, { partNumber: String(index + 1), uploadId }),

    // A COMPLETION MAKES AN OBJECT VISIBLE at the key, so it queues on that
    // key's writer chain exactly as a put does. `async`, so a part set this
    // refuses comes back as a rejection like every other failure here.
    async completeUpload(key, uploadId, parts, options) {
      const etags = etagsInOrder(key, parts);
      return oneWriter(key, async () =>
        asDecision(await complete(safeKey(key), uploadId, etags, options?.ifAbsent ?? false)),
      );
    },

    abortUpload: (key, uploadId) => abort(safeKey(key), uploadId),

    // THE BYTES NEVER LEAVE THE SERVICE: UploadPartCopy, part by part, with
    // the caller's facts as the destination's metadata. The source stays
    // where it is, so a `409` is simply copied again — and a copy still
    // undecided after the last try is a `conflict`, as a put's would be. A
    // `sourceIfMatch` holds every one of those parts to the version the
    // caller read, and a source that moved is NOT retried: copying it again
    // would only find the new bytes again.
    copy: (from, to, options) =>
      oneWriter(to, async () =>
        asDecision(
          await untilDecided(() =>
            copyInto(
              safeKey(to),
              safeKey(from),
              options.facts,
              options,
              options.ifAbsent ?? false,
              options.sourceIfMatch,
            ),
          ),
        ),
      ),

    // NO HEAD: the first window's GET answers whether the object is there
    // (404), how big it is (`Content-Range`), and its first bytes, in one round
    // trip — the only way `get` learns a size, whether or not the caller knew it.
    async get(key, range) {
      const start = range?.start ?? 0;
      const control = new AbortController();
      const firstTo = Math.min(start + READ_WINDOW, range === undefined ? Infinity : range.end + 1) - 1;
      const first = await fetchWindow(safeKey(key), start, firstTo, control.signal);
      if (first.status === 404) {
        await first.body?.cancel().catch(() => {});
        return null;
      }
      const spans = contentRange(first);
      // `416` with `bytes */N`: nothing at or after `start`, an empty object
      // included. The size is still the answer's.
      if (first.status === 416 && spans !== null) {
        await first.body?.cancel().catch(() => {});
        return { stream: new Response(new Uint8Array(0)).body as ReadableStream<Uint8Array>, size: spans.size };
      }
      if (first.status !== 206 || spans === null || spans.last === null) {
        const body = await first.text().catch(() => "");
        throw new S3Failure(`GET ${key}`, first, body);
      }
      const end = Math.min(range?.end ?? spans.size - 1, spans.size - 1);
      return {
        stream: windowed(safeKey(key), first, start, spans.last + 1, end, control),
        size: spans.size,
        // WHICH VERSION THESE BYTES ARE: what a caller that proves them binds
        // its copy to (`CopyOptions.sourceIfMatch`).
        ...(first.headers.get("etag") === null ? {} : { etag: first.headers.get("etag") as string }),
      };
    },

    head: async (key) => (await headOf(key))?.size ?? null,

    facts: factsOf,

    async delete(key) {
      // S3's DELETE of an absent key is a 204: idempotent by the protocol.
      // Signed here rather than through Bun's client, which closed the
      // connection on versitygw's empty 204.
      await deleteKey(safeKey(key));
    },

    async list(prefix) {
      const scoped = prefix === "" ? "" : `${safeKey(prefix)}/`;
      return (await listAll(scoped))
        .filter((entry) => !isTemp(entry.key))
        .map(({ key, size }) => ({ key, size }));
    },

    async sweepTemp(prefix, current) {
      const scoped = prefix === "" ? "" : `${safeKey(prefix)}/`;
      let removed = 0;
      for (const entry of await listAll(scoped)) {
        if (!isTemp(entry.key) || entry.lastModified > current) continue;
        await deleteKey(entry.key).catch(() => {});
        removed += 1;
      }
      // A DEAD PUT'S UPLOAD — under a final key or a temp one alike.
      for (const upload of await listUploads(scoped)) {
        if (upload.initiated > current) continue;
        await abort(upload.key, upload.uploadId);
        removed += 1;
      }
      return removed;
    },
  };
}
