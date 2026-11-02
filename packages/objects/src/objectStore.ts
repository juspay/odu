/**
 * AN OBJECT STORE — immutable bytes under opaque keys, behind one interface.
 *
 * A store knows keys, bytes, sizes and sha256s, and nothing about what the
 * bytes mean: the caller chooses the key layout and gives the bytes their
 * meaning. Two constructors, `diskObjectStore` (files under a directory) and
 * `s3ObjectStore` (any S3-compatible service: R2, AWS, Garage, versitygw).
 *
 * **A store is a VALUE.** Nothing outside the two constructors below knows
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

import { createHash, randomUUID } from "node:crypto";
import { open, link, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { S3Client } from "bun";
import { s3Fetch, type S3Request, type S3Target } from "./s3sign";
import { newChain, type Chain, serial } from "./serial";
import { writeAll } from "./sink";

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

export interface ObjectStore {
  /** Write `body` at `key`, unless the key holds an object already. With
   *  `expected`, the bytes must have those facts or nothing is kept. */
  put(key: string, body: ObjectBody, expected?: ObjectFacts): Promise<PutOutcome>;
  /**
   * OPTIONAL — a store whose objects are files offers it: make the file at
   * `file`, on this machine, the object at `key` WITHOUT copying it, and drop
   * the source name (so the object never aliases a file somebody may write).
   * `facts` are the file's, already proved by the caller. Disk links; a store
   * with no local files (S3) leaves it out, and the caller `put`s the file.
   */
  link?(key: string, file: string, facts: ObjectFacts): Promise<PutOutcome>;
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
function safeKey(key: string): string {
  const clean = key.replaceAll("\\", "/");
  if (clean.startsWith("/") || clean.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`"${key}" is not an object key`);
  }
  return clean;
}

const TEMP = ".tmp-";
const isTemp = (key: string): boolean => (key.split("/").at(-1) ?? "").startsWith(TEMP);

/** sha256 and length over a stream as it passes. */
function factsCounter(): { update(chunk: Uint8Array): void; facts(): ObjectFacts } {
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

const sameFacts = (a: ObjectFacts, b: ObjectFacts): boolean => a.size === b.size && a.sha256 === b.sha256;

/** Read a whole stream through a counter: the fallback for a disk object whose
 *  facts nobody wrote down (one written before they were kept). */
async function hashStream(stream: ReadableStream<Uint8Array>): Promise<ObjectFacts> {
  const counter = factsCounter();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) counter.update(chunk);
  return counter.facts();
}

// ── disk ────────────────────────────────────────────────────────────────────

export interface DiskObjectStoreOptions {
  /** The store's directory; keys live under `<dir>/objects`. */
  dir: string;
}

/**
 * A FILE AS A PULL STREAM, 64 KiB per read.
 *
 * NEVER a `BunFile`'s own stream: a Node HTTP adapter does not write that body,
 * so the response headers go out and the socket then waits for ever. An
 * `open`/`handle.read` loop is a stream every consumer knows, and it reads only
 * the range asked for.
 */
function fileBody(path: string, start: number, length: number): ReadableStream<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let position = start;
  let left = length;
  return new ReadableStream({
    async pull(controller) {
      try {
        handle ??= await open(path, "r");
        if (left <= 0) {
          await handle.close();
          handle = null;
          controller.close();
          return;
        }
        const size = Math.min(64 * 1024, left);
        const buffer = new Uint8Array(size);
        const { bytesRead } = await handle.read(buffer, 0, size, position);
        if (bytesRead === 0) {
          await handle.close();
          handle = null;
          controller.error(new Error(`${path} ended ${left} bytes early`));
          return;
        }
        position += bytesRead;
        left -= bytesRead;
        controller.enqueue(bytesRead === size ? buffer : buffer.subarray(0, bytesRead));
      } catch (err) {
        await handle?.close().catch(() => {});
        handle = null;
        controller.error(err);
      }
    },
    async cancel() {
      await handle?.close().catch(() => {});
      handle = null;
    },
  });
}

export function diskObjectStore(options: DiskObjectStoreOptions): ObjectStore {
  const root = join(options.dir, "objects");
  /** The facts kept beside each object, under a name no key's first segment
   *  can share with an object (a dot-name, which `list` never shows). */
  const factsRoot = join(root, ".facts");
  const pathOf = (key: string): string => join(root, safeKey(key));
  const factsPathOf = (key: string): string => join(factsRoot, safeKey(key));

  const isFile = async (path: string): Promise<number | null> => {
    const info = await stat(path).catch(() => null);
    return info !== null && info.isFile() ? info.size : null;
  };

  async function writeFacts(key: string, facts: ObjectFacts): Promise<void> {
    const target = factsPathOf(key);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temp = join(dirname(target), `${TEMP}${randomUUID()}`);
    await writeFile(temp, JSON.stringify(facts), { mode: 0o600 });
    await rename(temp, target);
  }

  async function factsOf(key: string): Promise<ObjectFacts | null> {
    const size = await isFile(pathOf(key));
    if (size === null) return null;
    const kept = await readFile(factsPathOf(key), "utf-8")
      .then((text) => JSON.parse(text) as ObjectFacts)
      .catch(() => null);
    if (kept !== null && kept.size === size) return kept;
    // AN OBJECT WRITTEN BEFORE FACTS WERE KEPT really has no sidecar (nor one
    // whose writer died between link and sidecar): hash it once, keep the answer.
    const computed = await hashStream(fileBody(pathOf(key), 0, size));
    await writeFacts(key, computed).catch(() => {});
    return computed;
  }

  /** The kept object's refusal: it exists, and these are its facts. */
  async function exists(key: string): Promise<PutOutcome> {
    const facts = await factsOf(key);
    if (facts === null) throw new Error(`${key} vanished while its put was refused`);
    return { ok: false, refusal: { kind: "exists", key, facts } };
  }

  /** LINK, never rename: `link` refuses an existing name, so of two writers of
   *  one key exactly one makes the object. The source name stays the caller's. */
  async function linkInto(key: string, file: string, facts: ObjectFacts): Promise<PutOutcome | "cross-device"> {
    const target = pathOf(key);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await link(file, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return exists(key);
      if (code === "EXDEV") return "cross-device";
      throw err;
    }
    // THE SOURCE NAME GOES: a link shares the inode, and a caller that later
    // wrote to its staged file would be writing into the object.
    await unlink(file).catch(() => {});
    await writeFacts(key, facts);
    return { ok: true, facts };
  }

  async function put(key: string, body: ObjectBody, expected?: ObjectFacts): Promise<PutOutcome> {
    const stream = body instanceof Blob ? body.stream() : body;
    const target = pathOf(key);
    if ((await isFile(target)) !== null) {
      // THE STREAM'S PRODUCER MUST STOP: abandoning a stream a pipe feeds
      // would leave its writer blocked on the full pipe for ever.
      await stream.cancel().catch(() => {});
      return exists(key);
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temp = join(dirname(target), `${TEMP}${randomUUID()}`);
    const counter = factsCounter();
    try {
      const sink = Bun.file(temp).writer({ highWaterMark: 1 << 20 });
      try {
        for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
          counter.update(chunk);
          await writeAll(sink, chunk, temp);
        }
      } finally {
        await sink.end();
      }
      const facts = counter.facts();
      if (expected !== undefined && !sameFacts(expected, facts)) {
        return { ok: false, refusal: { kind: "facts_mismatch", key, expected, actual: facts } };
      }
      const linked = await linkInto(key, temp, facts);
      if (linked === "cross-device") throw new Error(`${temp} and ${target} are one directory`);
      return linked;
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  return {
    put,

    async link(key, file, facts) {
      const linked = await linkInto(key, file, facts);
      // A FILE ON ANOTHER FILESYSTEM cannot be linked; copying it through
      // `put` is the exception rather than the write path.
      if (linked !== "cross-device") return linked;
      const copied = await put(key, Bun.file(file), facts);
      if (copied.ok) await unlink(file).catch(() => {});
      return copied;
    },

    async get(key, range) {
      const path = pathOf(key);
      const size = await isFile(path);
      if (size === null) return null;
      const start = range?.start ?? 0;
      const end = range?.end ?? size - 1;
      return { stream: fileBody(path, start, Math.max(0, end - start + 1)), size };
    },

    head: (key) => isFile(pathOf(key)),

    facts: factsOf,

    async delete(key) {
      for (const path of [pathOf(key), factsPathOf(key)]) {
        await unlink(path).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "ENOENT") throw err;
        });
      }
    },

    async list(prefix) {
      const base = prefix === "" ? root : pathOf(prefix);
      const out: { key: string; size: number }[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          // `.facts` and `.tmp-*` are the store's own, never objects.
          if (entry.name.startsWith(".")) continue;
          const at = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(at);
          } else if (entry.isFile()) {
            const info = await stat(at).catch(() => null);
            if (info !== null) {
              out.push({
                key: normalize(at.slice(root.length + 1)).split(sep).join("/"),
                size: info.size,
              });
            }
          }
        }
      };
      await walk(base);
      return out;
    },

    async sweepTemp(prefix, current) {
      let removed = 0;
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const at = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(at);
            continue;
          }
          if (!entry.name.startsWith(TEMP)) continue;
          const info = await stat(at).catch(() => null);
          // A temp file younger than this process is a put that is running now.
          if (info === null || info.mtimeMs > current) continue;
          await unlink(at).catch(() => {});
          removed += 1;
        }
      };
      await walk(prefix === "" ? root : pathOf(prefix));
      return removed;
    },
  };
}

// ── S3 ──────────────────────────────────────────────────────────────────────

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
type Decided = "won" | "lost" | "conflict";
const decidedBy = (response: Response): Decided =>
  response.status === 412 ? "lost" : response.status === 409 ? "conflict" : "won";

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
 *   contract's race case failed on that before `oneWriter`.
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

  /** One HEAD: the object's length and the facts its put wrote, or null. */
  async function headOf(key: string): Promise<{ size: number; facts: ObjectFacts | null } | null> {
    const response = await call("HEAD", safeKey(key));
    if (response.status === 404) return null;
    if (!response.ok) throw new S3Failure(`HEAD ${key}`, response, "");
    const size = Number(response.headers.get("content-length"));
    const sha256 = response.headers.get(META_SHA256);
    const metaSize = Number(response.headers.get(META_SIZE));
    return { size, facts: sha256 !== null && metaSize === size ? { size, sha256 } : null };
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
   * server-side, part by part, and conditional like any other write. The one
   * case that needs it is a multipart put whose facts were not known up front:
   * metadata is fixed when an upload is created, and the hash is known only at
   * the end.
   */
  async function copyInto(key: string, tempKey: string, facts: ObjectFacts): Promise<Decided> {
    const uploadId = await createUpload(key, metaOf(facts));
    try {
      const etags: string[] = [];
      for (let start = 0, part = 1; start < facts.size; start += COPY_PART, part += 1) {
        const end = Math.min(start + COPY_PART, facts.size) - 1;
        const response = await call("PUT", key, {
          query: { partNumber: String(part), uploadId },
          headers: {
            "x-amz-copy-source": `/${target.bucket}/${tempKey}`,
            "x-amz-copy-source-range": `bytes=${start}-${end}`,
          },
        });
        const body = await response.text();
        const etag = response.ok ? xmlValue(body, "ETag") : null;
        if (etag === null) throw new S3Failure(`UploadPartCopy ${key}`, response, body);
        etags.push(etag);
      }
      const decided = await complete(key, uploadId, etags, true);
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
          headers: { "if-none-match": "*", "content-length": String(filled), ...metaOf(facts) },
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
    const uploadId = await createUpload(uploadKey, direct ? metaOf(expected) : {});
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
      const decided = await untilDecided(() => copyInto(key, uploadKey, facts));
      if (decided === "conflict") return conflicted(key, CONFLICT_TRIES);
      return decided === "won" ? { ok: true, facts } : await exists(key);
    } finally {
      await deleteKey(uploadKey).catch(() => {});
    }
  }

  /** One window: a ranged GET of bytes `from`..`to` (inclusive). */
  const fetchWindow = (key: string, from: number, to: number, signal: AbortSignal): Promise<Response> =>
    call("GET", key, { headers: { range: `bytes=${from}-${to}` }, signal });

  /** `bytes <first>-<last>/<size>` (a 206), or `bytes *\/<size>` (a 416). */
  const contentRange = (response: Response): { last: number | null; size: number } | null => {
    const found = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
    if (found === null) return null;
    return { last: found[2] === undefined ? null : Number(found[2]), size: Number(found[3]) };
  };

  /**
   * The bytes after the first window up to `end`, as a pull stream: ONE window
   * being read and ONE prefetched, never more (see READ_WINDOW). The first
   * window's response is `get`'s, already in hand; `control` aborts every GET
   * in flight when the reader cancels.
   */
  function windowed(
    key: string,
    first: Response,
    from: number,
    end: number,
    control: AbortController,
  ): ReadableStream<Uint8Array> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = (first.body as ReadableStream<Uint8Array>).getReader();
    let position = from;
    let pieces: Uint8Array[] = [];
    const open = (): Promise<ArrayBuffer> | null => {
      if (position > end) return null;
      const to = Math.min(position + READ_WINDOW, end + 1) - 1;
      const next = fetchWindow(key, position, to, control.signal).then(async (response) => {
        if (response.status !== 206) {
          const body = await response.text().catch(() => "");
          throw new S3Failure(`GET ${key} (a window)`, response, body);
        }
        return response.arrayBuffer();
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
              controller.enqueue(next.value);
              return;
            }
            reader = null;
          }
          if (prefetched === null) {
            controller.close();
            return;
          }
          const window = await prefetched;
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
    put: (key, body, expected) =>
      oneWriter(key, async () => {
        if (!(body instanceof Blob)) return putOnce(key, body, expected);
        const outcome = await untilDecided(async () => {
          const once = await putOnce(key, body.stream(), expected);
          return !once.ok && once.refusal.kind === "conflict" ? "conflict" : once;
        });
        return outcome === "conflict" ? conflicted(key, CONFLICT_TRIES) : outcome;
      }),

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
      return { stream: windowed(safeKey(key), first, spans.last + 1, end, control), size: spans.size };
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
