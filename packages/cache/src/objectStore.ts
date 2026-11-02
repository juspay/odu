/**
 * THE OBJECT STORE — the bytes a cache serves, behind an interface.
 *
 * **The object IS the compressed NAR a pusher uploaded.** A push already sends
 * `nar/<narHash>.nar.zst`, whole or in parts; the write path assembles it and
 * proves it (NarHash over the DECOMPRESSED bytes) before recording the row. The
 * verified file then becomes the object, one `keep` away, and nothing else is
 * stored on the server: no Nix store, no imported closures, no second copy.
 * That is the Cachix/Attic model, and it is what makes the pod's disk budget
 * work — the 166 GB Nix store was upstream closures nobody ever pulled from us.
 *
 * **Keys are content names under a bucket prefix:**
 * `<bucket>/nar/<narHash base32>.<ext>`, where the extension names the stored
 * compression. A store holds many buckets' objects side by side, and every
 * listing the cache makes is under one bucket's prefix.
 *
 * **A store is a VALUE.** `ObjectStore` is the only thing the cache sees: the
 * cache row builds one per declared store at mount (`./stores`), a bucket names
 * the store it lives in, and from then on a route, staging, GC and the boot
 * sweep speak this interface and nothing else. Nothing outside the two
 * constructors below knows which kind of store it holds — there is no
 * `localPath`, no "is this disk", and no second way to serve.
 *
 * **Objects are immutable, and a put is put-if-absent.** A put onto a key that
 * exists is REFUSED with `exists` and the kept object's facts; of two
 * concurrent puts of one key exactly one wins. Disk links a finished temp file
 * into place (`link` fails on an existing name, where `rename` would replace
 * it); S3 sends `If-None-Match: *` on the write that makes the object visible.
 * No half object is ever visible under its final key: disk's temp names and
 * S3's temp keys are `.tmp-*`, which `list` skips and the boot sweep removes.
 *
 * **Facts are written once and read back.** `put` hashes while it streams, and
 * the size and sha256 are kept beside the object — a sidecar file on disk,
 * `x-amz-meta-odu-*` on S3 — so `facts` answers without reading the bytes.
 *
 * **Reads take a range.** `get(key, range)` streams exactly the bytes asked
 * for, at constant memory: a file read 64 KiB at a time on disk, a ranged GET
 * on S3. The route does the `Range` arithmetic once and asks every store the
 * same question.
 *
 * The contract suite (`test/objectStore.contract.ts`) runs against both: disk,
 * and an S3 fixture backed by versitygw.
 */

import { createHash, randomUUID } from "node:crypto";
import { open, link, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { S3Client } from "bun";
import { base32 } from "./narinfo";
import { s3Fetch, type S3Target } from "./s3sign";
import { newChain, type Chain, serial } from "./serial";
import { writeAll } from "./sink";

/** What `put` learned while it wrote: the compressed bytes' own facts. */
export interface ObjectFacts {
  size: number;
  /** `sha256:<base32>` of the COMPRESSED bytes — Nix's `FileHash`. */
  sha256: string;
}

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
  | { kind: "facts_mismatch"; key: string; expected: ObjectFacts; actual: ObjectFacts };

export type PutOutcome = { ok: true; facts: ObjectFacts } | { ok: false; refusal: ObjectRefusal };

export interface ObjectStore {
  /** Write `stream` at `key`, unless the key holds an object already. With
   *  `expected`, the streamed bytes must have those facts or nothing is kept. */
  put(key: string, stream: ReadableStream<Uint8Array>, expected?: ObjectFacts): Promise<PutOutcome>;
  /** Make a file on this machine the object at `key`: disk links it into
   *  place (and drops the source name, so the object never aliases a file
   *  somebody may write), S3 uploads it. `facts` are the file's, already
   *  proved by the caller, who removes whatever is left at `file`. */
  keep(key: string, file: string, facts: ObjectFacts): Promise<PutOutcome>;
  /** The object, or the `range` of it; null when the key is absent. */
  get(key: string, range?: ByteRange): Promise<StoredObject | null>;
  head(key: string): Promise<number | null>;
  /** The STORED object's facts — what `put` recorded — or null when the key is
   *  absent. A read of what was written, never a re-hash of the bytes. */
  facts(key: string): Promise<ObjectFacts | null>;
  /** Idempotent: deleting an absent key is not an error. */
  delete(key: string): Promise<void>;
  /** Every object under `prefix` (a directory-like prefix: `main/nar`), all
   *  pages of it. Temp names are not objects and are never listed. */
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  /** Remove temp names under `prefix` older than `current` — the boot sweep,
   *  before a mount can be writing. A younger temp is a live put. Scoped like
   *  `list`, because a store may be shared and only a bucket's prefix is ours. */
  sweepTemp(prefix: string, current: number): Promise<number>;
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
    facts: () => ({ size, sha256: `sha256:${base32(hash.digest())}` }),
  };
}

const sameFacts = (a: ObjectFacts, b: ObjectFacts): boolean => a.size === b.size && a.sha256 === b.sha256;

/** Read a whole stream through a counter: the fallback for an object whose
 *  facts nobody wrote down (one from before they were kept). */
async function hashStream(stream: ReadableStream<Uint8Array>): Promise<ObjectFacts> {
  const counter = factsCounter();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) counter.update(chunk);
  return counter.facts();
}

// ── disk ────────────────────────────────────────────────────────────────────

export interface DiskObjectStoreOptions {
  /** The cache's own directory; keys live under `<dir>/objects`. */
  dir: string;
}

/**
 * A FILE AS A PULL STREAM, 64 KiB per read.
 *
 * NEVER hand a `BunFile` to the HTTP layer: the Node adapter `odu web` runs
 * does not write that body, so the response headers go out and the socket then
 * waits for ever (the pod's post-migration hang). An `open`/`handle.read` loop
 * is a stream the adapter knows, and it reads only the range asked for.
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
  /** The facts kept beside each object, under a name no bucket can have (a
   *  bucket name starts with a letter or a digit). */
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
    // AN OBJECT FROM BEFORE FACTS WERE KEPT (3b), or one whose writer died
    // between the link and the sidecar: hash it once, and keep the answer.
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

  async function put(
    key: string,
    stream: ReadableStream<Uint8Array>,
    expected?: ObjectFacts,
  ): Promise<PutOutcome> {
    const target = pathOf(key);
    if ((await isFile(target)) !== null) {
      // THE STREAM'S PRODUCER MUST STOP: a migration twin found an object
      // another row already wrote, and abandoning the FIFO would leave its
      // dump process blocked on a full pipe for the life of the daemon.
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

    async keep(key, file, facts) {
      const linked = await linkInto(key, file, facts);
      // A STAGED FILE ON ANOTHER FILESYSTEM cannot be linked; copying it
      // through `put` is the exception rather than the write path.
      return linked === "cross-device" ? put(key, Bun.file(file).stream(), facts) : linked;
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
  /** Where the bucket is and who may write it — `./stores` reads it from the
   *  operator's declaration and credentials file. */
  target: S3Target;
  /** One multipart part, buffered while it uploads: the whole of a put's
   *  memory. S3's floor is 5 MiB. */
  partSize?: number;
  /** Keys per LIST request; `list` pages through all of them. */
  listPageSize?: number;
}

/** The metadata names `put` writes and `facts` reads. */
const META_SIZE = "x-amz-meta-odu-size";
const META_SHA256 = "x-amz-meta-odu-sha256";
/**
 * HOW MUCH OF AN OBJECT ONE READ HOLDS. Bun's S3 stream — and `fetch`'s body
 * under it — does NOT apply backpressure: measured with a consumer that pauses
 * 1 ms every four chunks, a 200 MiB object grew RSS by 274 MiB through
 * `S3File.stream()` and 208 MiB through a plain `fetch`. A slow Nix client would
 * hold a whole NAR in the daemon. So `get` reads in WINDOWS, one ranged GET at
 * a time, opened only when the consumer has drained the last.
 *
 * 1 MiB, measured in a fresh process on a 300 MiB read by a slow reader: peak
 * growth 52–55 MiB at 1 MiB, 62–66 at 2, 79–82 at 4, 75–87 at 8, and the same
 * at 600 MiB as at 200 — a floor of Bun's own, not the object. The cost is a
 * GET per MiB; reads of a public bucket leave odu entirely in PR 3d.
 */
const READ_WINDOW = 1024 * 1024;
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

/** A conditional write lost: the key was written by somebody else first.
 *  `409` is S3's answer when another conditional write is in flight on it. */
const lostRace = (response: Response): boolean => response.status === 412 || response.status === 409;

/**
 * AN S3-COMPATIBLE STORE: R2, AWS, Garage, versitygw.
 *
 * Reads, ranges, lists and deletes go through Bun's `S3Client`. The writes and
 * the metadata HEAD are signed by `./s3sign`, because Bun's client sends
 * neither `If-None-Match` nor `x-amz-meta-*`, and those carry this store's two
 * promises. Multipart is this store's business: a put buffers one part at a
 * time, so its memory is `partSize` whatever the object's length.
 *
 * **Exactly one writer per key, twice over.** In this process, puts of one key
 * queue behind each other, so the second sees the first's object and is
 * refused. Across processes, the write that makes an object visible carries
 * `If-None-Match: *`. Both are needed: versitygw's posix backend checks that
 * precondition and THEN writes, so two truly concurrent conditional PUTs can
 * both succeed there (the contract's race case failed on that before the
 * queue), while R2 and AWS evaluate it atomically.
 */
export function s3ObjectStore(options: S3ObjectStoreOptions): ObjectStore {
  const { target } = options;
  const partSize = Math.max(options.partSize ?? 8 * 1024 * 1024, 5 * 1024 * 1024);
  const pageSize = options.listPageSize ?? 1000;
  const client = new S3Client({
    endpoint: target.endpoint,
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
    const response = await s3Fetch(target, "HEAD", safeKey(key));
    if (response.status === 404) return null;
    if (!response.ok) throw new S3Failure(`HEAD ${key}`, response, "");
    const size = Number(response.headers.get("content-length"));
    const sha256 = response.headers.get(META_SHA256);
    const metaSize = Number(response.headers.get(META_SIZE));
    return { size, facts: sha256 !== null && metaSize === size ? { size, sha256 } : null };
  }

  async function deleteKey(key: string): Promise<void> {
    const response = await s3Fetch(target, "DELETE", key);
    const body = await response.text();
    if (!response.ok && response.status !== 404) throw new S3Failure(`DELETE ${key}`, response, body);
  }

  async function factsOf(key: string): Promise<ObjectFacts | null> {
    const found = await headOf(key);
    if (found === null) return null;
    // AN OBJECT SOMETHING ELSE WROTE carries no odu metadata; reading it is
    // the only honest answer, and an object odu wrote never takes this branch.
    return found.facts ?? hashStream(client.file(key).stream());
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
    const response = await s3Fetch(target, "POST", key, { query: { uploads: "" }, headers });
    const body = await response.text();
    const id = response.ok ? xmlValue(body, "UploadId") : null;
    if (id === null) throw new S3Failure(`CreateMultipartUpload ${key}`, response, body);
    return id;
  }

  const abort = (key: string, uploadId: string): Promise<void> =>
    s3Fetch(target, "DELETE", key, { query: { uploadId } }).then(
      (response) => void response.body?.cancel(),
      () => {},
    );

  /** Complete an upload; `false` when the precondition lost the race. */
  async function complete(
    key: string,
    uploadId: string,
    etags: readonly string[],
    conditional: boolean,
  ): Promise<boolean> {
    const body =
      "<CompleteMultipartUpload>" +
      etags.map((etag, at) => `<Part><PartNumber>${at + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join("") +
      "</CompleteMultipartUpload>";
    const response = await s3Fetch(target, "POST", key, {
      query: { uploadId },
      headers: conditional ? { "if-none-match": "*" } : {},
      body,
    });
    const text = await response.text();
    if (conditional && lostRace(response)) return false;
    // A COMPLETE CAN FAIL WITH 200: S3 sends the status before it knows, and
    // reports the failure as an `<Error>` body.
    if (!response.ok || text.includes("<Error>")) {
      throw new S3Failure(`CompleteMultipartUpload ${key}`, response, text);
    }
    return true;
  }

  /**
   * MAKE `tempKey`'s bytes the object at `key`, with `facts` as metadata —
   * server-side, part by part, and conditional like any other write. The one
   * case that needs it is a multipart put whose facts were not known up front:
   * metadata is fixed when an upload is created, and the hash is known only at
   * the end.
   */
  async function copyInto(key: string, tempKey: string, facts: ObjectFacts): Promise<boolean> {
    const uploadId = await createUpload(key, metaOf(facts));
    try {
      const etags: string[] = [];
      for (let start = 0, part = 1; start < facts.size; start += COPY_PART, part += 1) {
        const end = Math.min(start + COPY_PART, facts.size) - 1;
        const response = await s3Fetch(target, "PUT", key, {
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
      const won = await complete(key, uploadId, etags, true);
      if (!won) await abort(key, uploadId);
      return won;
    } catch (err) {
      await abort(key, uploadId);
      throw err;
    }
  }

  async function put(
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
      const response = await s3Fetch(target, "PUT", key, {
        headers: { "if-none-match": "*", "content-length": String(filled), ...metaOf(facts) },
        body: first as Uint8Array<ArrayBuffer>,
      });
      const text = await response.text();
      if (lostRace(response)) return exists(key);
      if (!response.ok) throw new S3Failure(`PUT ${key}`, response, text);
      return { ok: true, facts };
    }

    // MULTIPART. With the facts promised up front the upload goes straight to
    // the key, metadata attached; without them it goes to a temp key and is
    // copied into place once the hash is known.
    const direct = expected !== undefined;
    const uploadKey = direct ? key : `${key.slice(0, key.lastIndexOf("/") + 1)}${TEMP}${randomUUID()}`;
    const uploadId = await createUpload(uploadKey, direct ? metaOf(expected) : {});
    const etags: string[] = [];
    try {
      let part: Uint8Array = first;
      for (;;) {
        const response = await s3Fetch(target, "PUT", uploadKey, {
          query: { partNumber: String(etags.length + 1), uploadId },
          headers: { "content-length": String(part.length) },
          body: part as Uint8Array<ArrayBuffer>,
        });
        const text = await response.text();
        const etag = response.headers.get("etag");
        if (!response.ok || etag === null) throw new S3Failure(`UploadPart ${uploadKey}`, response, text);
        etags.push(etag);
        if (part.length < partSize) break;
        const next = await parts.fill(buffer);
        if (next === 0) break;
        part = buffer.subarray(0, next);
        counter.update(part);
      }
    } catch (err) {
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
      const won = await complete(key, uploadId, etags, true);
      if (won) return { ok: true, facts };
      await abort(key, uploadId);
      return exists(key);
    }
    await complete(uploadKey, uploadId, etags, false);
    try {
      return (await copyInto(key, uploadKey, facts)) ? { ok: true, facts } : await exists(key);
    } finally {
      await deleteKey(uploadKey).catch(() => {});
    }
  }

  /** Bytes `start`..`end` of `key` as a pull stream, one READ_WINDOW per
   *  ranged GET, the next opened only on demand (see READ_WINDOW). */
  function windowed(key: string, start: number, end: number): ReadableStream<Uint8Array> {
    const file = client.file(safeKey(key));
    let position = start;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          if (reader === null) {
            if (position > end) {
              controller.close();
              return;
            }
            const until = Math.min(position + READ_WINDOW, end + 1);
            reader = file.slice(position, until).stream().getReader();
          }
          const next = await reader.read();
          if (next.done) {
            reader = null;
            continue;
          }
          position += next.value.length;
          controller.enqueue(next.value);
          return;
        }
      },
      async cancel(reason) {
        await reader?.cancel(reason).catch(() => {});
        reader = null;
      },
    });
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
    put: (key, stream, expected) => oneWriter(key, () => put(key, stream, expected)),

    keep: (key, file, facts) => oneWriter(key, () => put(key, Bun.file(file).stream(), facts)),

    async get(key, range) {
      const found = await headOf(key);
      if (found === null) return null;
      return {
        stream: windowed(key, range?.start ?? 0, range?.end ?? found.size - 1),
        size: found.size,
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
      let removed = 0;
      for (const entry of await listAll(prefix === "" ? "" : `${safeKey(prefix)}/`)) {
        if (!isTemp(entry.key) || entry.lastModified > current) continue;
        await deleteKey(entry.key).catch(() => {});
        removed += 1;
      }
      return removed;
    },
  };
}
