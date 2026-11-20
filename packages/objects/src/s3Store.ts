import { createHash, randomUUID } from "node:crypto";
import { S3Client } from "bun";
import {
  type CopyOptions,
  factsCounter,
  isTemp,
  ObjectChanged,
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
   *  reused, and reads a part only when one is free. */
  parallelParts?: number;
  /** Keys per LIST request; `list` pages through all of them. */
  listPageSize?: number;
  /** How the signed requests are sent — `fetch`, unless a suite stages an
   *  answer no gateway gives (a `409`). */
  send?: typeof fetch;
}

const META_SIZE = "x-amz-meta-odu-size";
const META_SHA256 = "x-amz-meta-odu-sha256";
/**
 * HOW MUCH OF AN OBJECT ONE READ HOLDS. Bun's S3 stream — and `fetch`'s body
 * under it — does NOT apply backpressure, so a slow reader would make the
 * process hold the whole object. `get` reads in WINDOWS of ranged GETs, at
 * most TWO in flight: the one being read, and the next, fetched while it is.
 * Cancelling the read aborts both. The prefetched window is read into one
 * buffer (`arrayBuffer()`), since `fetch` reads a body ahead regardless.
 */
const READ_WINDOW = 1024 * 1024;
const READ_PIECE = 64 * 1024;
/** UploadPartCopy's ceiling is 5 GiB a part; 1 GiB keeps a copy's parts few. */
const COPY_PART = 1024 * 1024 * 1024;
/** Keys in one `DeleteObjects`. S3's own ceiling, and R2 keeps it. */
const DELETE_KEYS = 1000;

class S3Failure extends Error {
  constructor(what: string, status: number, body: string, tries = 1) {
    super(`${what}: ${status} ${said(body)}${tries > 1 ? ` after ${tries} tries` : ""}`.trimEnd());
  }
}

const said = (body: string): string => {
  const code = xmlValue(body, "Code");
  if (code === null) return body.slice(0, 300).replace(/\s+/g, " ").trim();
  const message = xmlValue(body, "Message");
  return message === null ? code : `${code} (${message})`;
};

const PRESSURE_BACKOFF_MS = [250, 500, 1000, 2000] as const;
export const S3_PRESSURE_TRIES = PRESSURE_BACKOFF_MS.length + 1;

/** The three ways an S3 service says "you are asking too fast": HTTP's own
 *  429, a 503, and the `SlowDown` code AWS answers with a 503 body. */
const slowingDown = (status: number, body: string): boolean =>
  status === 429 || status === 503 || body.includes("<Code>SlowDown</Code>");

interface Pressed {
  readonly pressed: { readonly what: string; readonly status: number; readonly body: string };
}
const isPressed = (outcome: unknown): outcome is Pressed =>
  typeof outcome === "object" && outcome !== null && "pressed" in outcome;

async function underPressure<T>(attempt: () => Promise<T | Pressed>): Promise<T> {
  for (let tries = 1; ; tries += 1) {
    const outcome = await attempt();
    if (!isPressed(outcome)) return outcome;
    const base = PRESSURE_BACKOFF_MS[tries - 1];
    const { what, status, body } = outcome.pressed;
    if (base === undefined) throw new S3Failure(what, status, body, tries);
    await Bun.sleep(base + Math.floor(Math.random() * base * 0.25));
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

const xmlValue = (xml: string, element: string): string | null => {
  const found = new RegExp(`<${element}>([^<]*)</${element}>`).exec(xml);
  return found === null ? null : (found[1] as string).replaceAll("&#34;", '"').replaceAll("&quot;", '"');
};

const xmlText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

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
const decidedBy = (response: Response): WriteDecision =>
  response.status === 412 ? "exists" : response.status === 409 ? "conflict" : "stored";

/**
 * THE ETAGS OF A DIRECT UPLOAD'S PARTS, in part order: exactly the indexes
 * `0..n-1`, each once. A gap would make S3 glue the remaining parts into an
 * object nobody uploaded, so a set that is not that is refused here, naming
 * what arrived.
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
 * `If-None-Match` nor `x-amz-meta-*`; and the reads, because a read learns
 * the object's size from its first GET's `Content-Range`, which Bun's
 * `S3File` does not show.
 *
 * How much `If-None-Match: *` buys on the write that makes an object visible
 * is the service's:
 *
 * - AWS honours it on `PutObject` and `CompleteMultipartUpload`, first to
 *   finish wins and the rest get `412`
 *   (docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).
 * - R2 evaluates it atomically on `PutObject`, at most one of several writes
 *   succeeding (developers.cloudflare.com/r2/api/s3/api/), and documents NO
 *   conditional header on `CompleteMultipartUpload`; measured against bucket
 *   `kolu` on 2026-11-03, it does honour it there (`412 PreconditionFailed`).
 * - versitygw (the suite's gateway) checks the precondition and THEN writes,
 *   so two truly concurrent conditional PUTs can both succeed. It DOES honour
 *   `If-None-Match: *` on `CompleteMultipartUpload` (a `412`).
 *
 * WHAT R2 DOES NOT IMPLEMENT is the SOURCE condition on a copy's parts:
 * `x-amz-copy-source-if-match` is listed as not implemented on
 * `UploadPartCopy` (it is implemented on `CopyObject`, which this store does
 * not use), so `CopyOptions.sourceIfMatch` binds a copy on AWS and versitygw
 * and is IGNORED on R2.
 *
 * An object made by `completeUpload` alone carries no facts at all —
 * `facts()` refuses it as an {@link UnrecordedObject} until something copies
 * it into place with them.
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
   * `x-amz-meta-odu-size` is what this store RECORDED beside the bytes;
   * `content-length` is what the ANSWER MEASURED, and an answer an
   * intermediary re-encoded measured its own body rather than the object: R2
   * sits behind Cloudflare, which compresses a compressible content type
   * (`text/plain` — a bucket's `nix-cache-info`) and answers the HEAD with
   * `content-encoding` and NO `content-length` at all (#151).
   */
  async function headOf(key: string): Promise<{ size: number; facts: ObjectFacts | null } | null> {
    const response = await call("HEAD", safeKey(key));
    if (response.status === 404) return null;
    if (!response.ok) throw new S3Failure(`HEAD ${key}`, response.status, "");
    const counted = (header: string): number | null => {
      const value = Number(response.headers.get(header) ?? Number.NaN);
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    };
    const measured = response.headers.get("content-encoding") === null ? counted("content-length") : null;
    const sha256 = response.headers.get(META_SHA256);
    const size = counted(META_SIZE);
    const recorded = sha256 !== null && size !== null ? { size, sha256 } : null;
    if (recorded !== null && (measured === null || measured === recorded.size)) {
      return { size: recorded.size, facts: recorded };
    }
    return { size: measured ?? 0, facts: null };
  }

  /** S3's DELETE of an absent key is a 204, and a 404 from a service that
   *  answers one instead is the same idempotent nothing. Asked again while
   *  the service asks for less. */
  async function deleteKey(key: string): Promise<void> {
    await underPressure(async () => {
      const response = await call("DELETE", key);
      const body = await response.text();
      if (slowingDown(response.status, body)) {
        return { pressed: { what: `DELETE ${key}`, status: response.status, body } };
      }
      if (!response.ok && response.status !== 404) throw new S3Failure(`DELETE ${key}`, response.status, body);
      return null;
    });
  }

  /**
   * ONE `DeleteObjects` — up to {@link DELETE_KEYS} keys in ONE request.
   *
   * QUIET, so a 200 carries only what did NOT go. An absent key is not among
   * them: S3 reports deleting a key that was never there as a success.
   *
   * Content-MD5 IS REQUIRED by S3 on this call (and accepted by R2), which is
   * also why the body is built as bytes and measured here rather than handed
   * to `fetch` as a string.
   */
  async function deleteObjects(keys: readonly string[]): Promise<void> {
    let pending = keys;
    await underPressure(async () => {
      const body = new TextEncoder().encode(
        '<?xml version="1.0" encoding="UTF-8"?><Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
          pending.map((key) => `<Object><Key>${xmlText(key)}</Key></Object>`).join("") +
          "<Quiet>true</Quiet></Delete>",
      );
      const what = `DeleteObjects ${target.bucket} (${pending.length} keys)`;
      const response = await call("POST", "", {
        query: { delete: "" },
        headers: {
          "content-type": "application/xml",
          "content-length": String(body.length),
          "content-md5": createHash("md5").update(body).digest("base64"),
        },
        body: body as Uint8Array<ArrayBuffer>,
      });
      const text = await response.text();
      if (slowingDown(response.status, text)) {
        return { pressed: { what, status: response.status, body: text } };
      }
      if (!response.ok) throw new S3Failure(what, response.status, text);
      // Per key, inside a 200: the ones that did not go, each with its own
      // code.
      const refused = [...text.matchAll(/<Error>([\s\S]*?)<\/Error>/g)].map((found) => {
        const entry = found[1] as string;
        return { key: xmlValue(entry, "Key") ?? "", code: xmlValue(entry, "Code") ?? "", entry };
      });
      const fatal = refused.find((one) => one.code !== "SlowDown" && one.code !== "ServiceUnavailable");
      if (fatal !== undefined) {
        throw new S3Failure(`DeleteObjects ${fatal.key}`, response.status, fatal.entry);
      }
      if (refused.length === 0) return null;
      pending = refused.map((one) => one.key);
      return { pressed: { what, status: response.status, body: text } };
    });
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

  interface PartSource {
    fill(buffer: Uint8Array): Promise<number>;
    cancel(reason?: unknown): Promise<void>;
  }

  function partReader(stream: ReadableStream<Uint8Array>): PartSource {
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
    if (id === null) throw new S3Failure(`CreateMultipartUpload ${key}`, response.status, body);
    return id;
  }

  const abort = (key: string, uploadId: string): Promise<void> =>
    call("DELETE", key, { query: { uploadId } }).then(
      (response) => void response.body?.cancel(),
      () => {},
    );

  /** Complete an upload: `exists` on `412`, and `conflict` on `409` — after
   *  which AWS wants the upload STARTED AGAIN, never completed again. */
  async function complete(
    key: string,
    uploadId: string,
    etags: readonly string[],
    conditional: boolean,
  ): Promise<WriteDecision> {
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
    const decided = conditional ? decidedBy(response) : "stored";
    if (decided !== "stored") return decided;
    // A COMPLETE CAN FAIL WITH 200: S3 sends the status before it knows, and
    // reports the failure as an `<Error>` body.
    if (!response.ok || text.includes("<Error>")) {
      throw new S3Failure(`CompleteMultipartUpload ${key}`, response.status, text);
    }
    return "stored";
  }

  /**
   * `options.sourceIfMatch`: every part is its own request and S3 resolves the
   * source afresh for each, so each `UploadPartCopy` carries
   * `x-amz-copy-source-if-match` and a `412` ends the copy as
   * `source_changed` — on the services that implement it (not R2).
   */
  async function copyInto(
    key: string,
    tempKey: string,
    facts: ObjectFacts,
    options?: CopyOptions,
  ): Promise<WriteDecision> {
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
            ...(options?.sourceIfMatch === undefined
              ? {}
              : { "x-amz-copy-source-if-match": options.sourceIfMatch }),
          },
        });
        const body = await response.text();
        if (response.status === 412) {
          await abort(key, uploadId);
          return "source_changed";
        }
        const etag = response.ok ? xmlValue(body, "ETag") : null;
        if (etag === null) throw new S3Failure(`UploadPartCopy ${key}`, response.status, body);
        etags.push(etag);
      }
      const decided = await complete(key, uploadId, etags, true);
      if (decided !== "stored") await abort(key, uploadId);
      return decided;
    } catch (err) {
      await abort(key, uploadId);
      throw err;
    }
  }

  async function refuseIfTaken(key: string, stream: ReadableStream<Uint8Array>): Promise<PutOutcome | null> {
    if ((await headOf(key)) === null) return null;
    await stream.cancel().catch(() => {});
    return exists(key);
  }

  interface StagedStream {
    parts: PartSource;
    first: Uint8Array;
    buffer: Uint8Array<ArrayBuffer>;
    counter: { update(chunk: Uint8Array): void; facts(): ObjectFacts };
  }

  async function uploadParts(uploadKey: string, uploadId: string, staged: StagedStream): Promise<string[]> {
    const { parts, first, buffer, counter } = staged;
    const etags = new Map<number, string>();
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
        if (!response.ok || etag === null) throw new S3Failure(`UploadPart ${uploadKey}`, response.status, text);
        etags.set(number, etag);
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
    return [...etags].sort(([a], [b]) => a - b).map(([, etag]) => etag);
  }

  async function putWithPromisedFacts(
    key: string,
    expected: ObjectFacts,
    options: PutOptions | undefined,
    staged: StagedStream,
  ): Promise<PutOutcome> {
    const uploadId = await createUpload(key, { ...metaOf(expected), ...headersOf(options) });
    const etags = await uploadParts(key, uploadId, staged);
    const facts = staged.counter.facts();
    if (!sameFacts(expected, facts)) {
      await abort(key, uploadId);
      return { ok: false, refusal: { kind: "facts_mismatch", key, expected, actual: facts } };
    }
    const decided = await complete(key, uploadId, etags, true);
    if (decided === "stored") return { ok: true, facts };
    await abort(key, uploadId);
    if (decided === "conflict") return conflicted(key, 1);
    return exists(key);
  }

  async function putThenCopy(
    key: string,
    options: PutOptions | undefined,
    staged: StagedStream,
  ): Promise<PutOutcome> {
    const uploadKey = `${key.slice(0, key.lastIndexOf("/") + 1)}${TEMP}${randomUUID()}`;
    const uploadId = await createUpload(uploadKey, {});
    const etags = await uploadParts(uploadKey, uploadId, staged);
    const facts = staged.counter.facts();
    await complete(uploadKey, uploadId, etags, false);
    try {
      const decided = await untilDecided(() => copyInto(key, uploadKey, facts, { ...options, facts }));
      if (decided === "conflict") return conflicted(key, CONFLICT_TRIES);
      return decided === "stored" ? { ok: true, facts } : await exists(key);
    } finally {
      await deleteKey(uploadKey).catch(() => {});
    }
  }

  async function putOnce(
    key: string,
    stream: ReadableStream<Uint8Array>,
    expected?: ObjectFacts,
    options?: PutOptions,
  ): Promise<PutOutcome> {
    safeKey(key);
    const taken = await refuseIfTaken(key, stream);
    if (taken !== null) return taken;
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

    if (filled < partSize) {
      const facts = counter.facts();
      if (expected !== undefined && !sameFacts(expected, facts)) {
        return { ok: false, refusal: { kind: "facts_mismatch", key, expected, actual: facts } };
      }
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
        if (decided === "stored" && !response.ok) throw new S3Failure(`PUT ${key}`, response.status, text);
        return decided;
      });
      if (decided === "conflict") return conflicted(key, CONFLICT_TRIES);
      return decided === "stored" ? { ok: true, facts } : exists(key);
    }

    const staged: StagedStream = { parts, first, buffer, counter };
    return expected === undefined
      ? putThenCopy(key, options, staged)
      : putWithPromisedFacts(key, expected, options, staged);
  }

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
   * A read of several windows is several requests, and S3 resolves each
   * against the key AS IT IS THEN, so each window after the first carries
   * `If-Match` on the first's ETag. A `412`, a `416` and a short `206` are one
   * condition, and the stream fails with one sentence for all of them
   * ({@link ObjectChanged}).
   *
   * A `throw` out of `pull` leaves a rejection the reader may never be handed
   * at all (issue #160), so one `catch` aborts the GETs still in flight and
   * hands the reader the error on its next `read`.
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
    const short = (span: number, got: number): ObjectChanged =>
      new ObjectChanged(key, version, `a window of ${span} bytes answered ${got}`);
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
          if (response.status === 412 || response.status === 416) {
            throw new ObjectChanged(key, version, `a window answered ${response.status}`);
          }
          const body = await response.text().catch(() => "");
          throw new S3Failure(`GET ${key} (a window)`, response.status, body);
        }
        const window = await response.arrayBuffer();
        if (window.byteLength !== span) throw short(span, window.byteLength);
        return window;
      });
      position = to + 1;
      // A rejected prefetch is read when its turn comes, not reported twice.
      next.catch(() => {});
      return next;
    };
    let prefetched = open();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
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
              if (firstRead !== from - start) throw short(from - start, firstRead);
            }
            if (prefetched === null) {
              controller.close();
              return;
            }
            const window = await prefetched;
            prefetched = open();
            pieces = [];
            for (let at = 0; at < window.byteLength; at += READ_PIECE) {
              pieces.push(new Uint8Array(window, at, Math.min(READ_PIECE, window.byteLength - at)));
            }
          }
        } catch (err) {
          control.abort();
          controller.error(err);
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
   * the next sweep reaches.
   */
  async function listUploads(prefix: string): Promise<{ key: string; uploadId: string; initiated: number }[]> {
    const out: { key: string; uploadId: string; initiated: number }[] = [];
    let marker: Record<string, string> = {};
    for (;;) {
      const response = await call("GET", "", {
        query: { uploads: "", "max-uploads": String(pageSize), ...(prefix === "" ? {} : { prefix }), ...marker },
      });
      const body = await response.text();
      if (!response.ok) throw new S3Failure(`ListMultipartUploads ${prefix}`, response.status, body);
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
    // A body that can be read again (a Blob) restarts a conflicted multipart
    // upload whole — what AWS asks of a `409` on `CompleteMultipartUpload`.
    put: (key, body, expected, options) =>
      oneWriter(key, async () => {
        if (!(body instanceof Blob)) return putOnce(key, body, expected, options);
        const outcome = await untilDecided(async () => {
          const once = await putOnce(key, body.stream(), expected, options);
          return !once.ok && once.refusal.kind === "conflict" ? "conflict" : once;
        });
        return outcome === "conflict" ? conflicted(key, CONFLICT_TRIES) : outcome;
      }),

    presignGet: (key, expiresSeconds) => presignGet(target, safeKey(key), expiresSeconds),

    partSize,

    // An upload's metadata is fixed at creation, before the first byte.
    createUpload: (key) => createUpload(safeKey(key), {}),

    presignPart: (key, uploadId, index, expiresSeconds) =>
      presign(target, "PUT", safeKey(key), expiresSeconds, { partNumber: String(index + 1), uploadId }),

    async completeUpload(key, uploadId, parts) {
      const etags = etagsInOrder(key, parts);
      return oneWriter(key, () => complete(safeKey(key), uploadId, etags, false));
    },

    abortUpload: (key, uploadId) => abort(safeKey(key), uploadId),

    copy: (from, to, options) =>
      oneWriter(to, () =>
        untilDecided(() => copyInto(safeKey(to), safeKey(from), options.facts, options)),
      ),

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
      // included.
      if (first.status === 416 && spans !== null) {
        await first.body?.cancel().catch(() => {});
        return { stream: new Response(new Uint8Array(0)).body as ReadableStream<Uint8Array>, size: spans.size };
      }
      if (first.status !== 206 || spans === null || spans.last === null) {
        const body = await first.text().catch(() => "");
        throw new S3Failure(`GET ${key}`, first.status, body);
      }
      const end = Math.min(range?.end ?? spans.size - 1, spans.size - 1);
      return {
        stream: windowed(safeKey(key), first, start, spans.last + 1, end, control),
        size: spans.size,
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

    // Nothing is deleted when there is nothing to delete: S3 refuses an empty
    // `Delete` document.
    async deleteMany(keys) {
      const scoped = keys.map(safeKey);
      for (let at = 0; at < scoped.length; at += DELETE_KEYS) {
        await deleteObjects(scoped.slice(at, at + DELETE_KEYS));
      }
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
      for (const upload of await listUploads(scoped)) {
        if (upload.initiated > current) continue;
        await abort(upload.key, upload.uploadId);
        removed += 1;
      }
      return removed;
    },
  };
}
