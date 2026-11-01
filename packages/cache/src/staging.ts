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
 * one only it knows, then verifies and adopts THAT file: nothing another
 * request does can replace, move or delete the bytes under it. A narinfo with
 * nothing to claim is proved by the object an earlier proof kept, read in
 * place — never rebuilt at the shared name, where a concurrent verify would
 * read it half-written (kolu #2335's `zstd exited 1`).
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
import type { ObjectStore } from "./objectStore";
import { writeAll } from "./sink";
import { verifyNarFile } from "./store";
import type { BucketRow } from "./db";
import {
  compressionExtension,
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

/** What a proof hands `keep`: a file this request claimed and verified, or
 *  the stream of an object an earlier proof already kept. */
type Source =
  | {
      kind: "file";
      path: string;
      facts: { fileHash: string; fileSize: number; selfHash: string | null };
    }
  | { kind: "object"; stream: ReadableStream<Uint8Array> };

/** What `completeUpload` came to: every part present, or which indexes are not. */
export type CompleteUpload =
  | { ok: true; parts: number }
  | { ok: false; missing: readonly number[] };

/** What a staged `file://` cache contains, and the first thing a client reads
 *  from a real one. */
export const NIX_CACHE_INFO = "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n";

/** How long a staged upload nobody finished survives. */
const STAGE_TTL_MS = 60 * 60 * 1000;

/** How often the staging directory is swept. Sweeping on every upload would be
 *  a readdir of every bucket on every PUT. */
const SWEEP_EVERY_MS = 60 * 1000;

/** The object key a bucket's compressed NAR lives at. */
export function objectKey(
  bucket: string,
  narHash: string,
  compression: string | null = "zstd",
): string {
  return `${bucket}/nar/${narHash.replace(/^sha256:/, "")}.${compressionExtension(compression)}`;
}

export interface StagingDeps {
  objects: ObjectStore;
  /** The cache's own directory; staging lives at `<dir>/staging`. */
  dir: string;
  now: () => number;
  /**
   * Put an imported path in a bucket, and answer whether it landed. Supplied
   * by `cache.ts` because it is the one thing the write path shares with
   * administration — a pin and a collection take the same write lock.
   */
  record: (
    bucket: BucketRow,
    info: NarInfo,
    file: { fileHash: string; fileSize: number },
    selfHash: string | null,
  ) => Promise<boolean>;
  /** One line per operational fact; the cache's logger. */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface Staging {
  close(): Promise<void>;
  beginUpload(bucket: BucketRow, file: string): Promise<Upload>;
  beginPart(bucket: BucketRow, file: string, index: number, limit: number): Promise<Upload>;
  completeUpload(bucket: BucketRow, file: string, total: number): Promise<CompleteUpload>;
  acceptNarinfo(
    bucket: BucketRow,
    hash: string,
    body: ReadableStream<Uint8Array>,
  ): Promise<NarinfoOutcome>;
}

export function createStaging(deps: StagingDeps): Staging {
  const { objects, now, record, log } = deps;
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
  /** One keep-and-record at a time per bucket: two proofs of one object key
   *  must not adopt it concurrently. */
  const records = new Map<string, Chain>();
  /** Bytes/parts of a completed chunked upload, for a refusal's log line. */
  const joined = new Map<string, { parts: number; bytes: number }>();
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
    ): Promise<NarinfoOutcome> => ({
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
      const object = await objects.get(objectKey(bucket.name, info.narHash, info.compression));
      if (object === null) {
        return refuse(`the narinfo names ${info.url}, which was never uploaded to this bucket`);
      }
      return recordSerially(bucket, info, { kind: "object", stream: object.stream });
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
      return await recordSerially(bucket, info, {
        kind: "file",
        path: claimed.path,
        facts: { fileHash: checked.fileHash, fileSize: checked.fileSize, selfHash: checked.selfHash },
      });
    } finally {
      // OURS TO REMOVE: adopted, refused, or a duplicate of a kept object.
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

  /** Join one staged file's parts — under the file's lock, so two completes
   *  cannot unlink what the other reads. */
  async function completeNow(bucket: BucketRow, file: string, total: number): Promise<CompleteUpload> {
    const dirForBucket = stagedDir(bucket.name);
    const partPath = (index: number): string => join(dirForBucket, "nar", `${file}.part-${index}`);
    const missing: number[] = [];
    for (let index = 0; index < total; index++) {
      const info = await stat(partPath(index)).catch(() => null);
      if (info === null || !info.isFile()) missing.push(index);
    }
    if (missing.length > 0) {
      // A SECOND COMPLETE for a file the first already joined is the state the
      // caller wanted: the parts are gone because the NAR exists.
      const target = join(dirForBucket, "nar", file);
      const assembled = await stat(target).catch(() => null);
      if (assembled !== null && assembled.isFile()) {
        await unlink(uploadMarker(dirForBucket, file)).catch(() => {});
        joined.set(`${bucket.name}/${file}`, { parts: total, bytes: assembled.size });
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
    await unlink(uploadMarker(dirForBucket, file)).catch(() => {});
    const joinedInfo = await stat(target).catch(() => null);
    joined.set(`${bucket.name}/${file}`, {
      parts: total,
      bytes: joinedInfo?.size ?? 0,
    });
    return { ok: true, parts: total };
  }

  /** Take the proved file into the object store, or learn an existing
   *  object's facts; the row learns them either way. A put failure refuses the
   *  push (the bytes are not safely kept). FIRST KEPT WINS: adopting onto a key
   *  that exists keeps the object and answers ITS facts. */
  async function keep(
    bucket: BucketRow,
    info: NarInfo,
    source: Source,
  ): Promise<{ fileHash: string; fileSize: number; selfHash: string | null } | null> {
    try {
      const key = objectKey(bucket.name, info.narHash, info.compression);
      if (source.kind === "object") {
        // IMMUTABLE: a put onto an existing key cancels the stream and answers
        // the stored object's facts — no staged copy, no shared name.
        const kept = await objects.put(key, source.stream);
        return { fileHash: kept.sha256, fileSize: kept.size, selfHash: null };
      }
      const { facts } = source;
      // ADOPT the claimed file: one rename, never a copy of the same bytes.
      const kept =
        objects.adopt === undefined
          ? await objects.put(key, Bun.file(source.path).stream())
          : await objects.adopt(key, source.path, { size: facts.fileSize, sha256: facts.fileHash });
      return { fileHash: kept.sha256, fileSize: kept.size, selfHash: facts.selfHash };
    } catch (err) {
      log?.("cache.object.put_failed", {
        bucket: bucket.name,
        path: info.storePath,
        reason: String((err as Error).message ?? err),
      });
      return null;
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

  /** Keep and record under the bucket's chain: two proofs of one object key
   *  (twins under different names) must not adopt it at once. */
  function recordSerially(bucket: BucketRow, info: NarInfo, source: Source): Promise<NarinfoOutcome> {
    let chain = records.get(bucket.name);
    if (chain === undefined) {
      chain = newChain();
      records.set(bucket.name, chain);
    }
    return serial(chain, async () => {
      const file = await keep(bucket, info, source);
      if (file === null) {
        return {
          ok: false,
          status: 400,
          message: `${info.storePath} could not be stored: the object store refused it`,
        };
      }
      await record(bucket, info, file, file.selfHash);
      log?.("cache.import.recorded", {
        bucket: bucket.name,
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
      await Promise.all([...records.values()].map((chain) => chain.tail));
    },

    async beginUpload(bucket, file) {
      await sweep();
      const dirForBucket = stagedDir(bucket.name);
      await mkdir(join(dirForBucket, "nar"), { recursive: true, mode: 0o700 });
      if (!isStagedFileName(file)) throw new Error(`"${file}" is not a NAR file name`);
      await touchUpload(dirForBucket, file);
      return openAt(join(dirForBucket, "nar", file), null);
    },

    async beginPart(bucket, file, index, limit) {
      if (!isStagedFileName(file)) throw new Error(`"${file}" is not a NAR file name`);
      if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_PARTS) {
        throw new Error(`"${index}" is not a part index`);
      }
      const dirForBucket = stagedDir(bucket.name);
      await mkdir(join(dirForBucket, "nar"), { recursive: true, mode: 0o700 });
      await touchUpload(dirForBucket, file);
      return openAt(join(dirForBucket, "nar", `${file}.part-${index}`), limit);
    },

    async completeUpload(bucket, file, total) {
      if (!isStagedFileName(file)) throw new Error(`"${file}" is not a NAR file name`);
      if (!Number.isSafeInteger(total) || total < 1 || total > MAX_PARTS) {
        throw new Error(`"${total}" is not a part count`);
      }
      const key = `${bucket.name}/${file}`;
      let chain = completes.get(key);
      if (chain === undefined) {
        chain = newChain();
        completes.set(key, chain);
      }
      return serial(chain, () => completeNow(bucket, file, total));
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
      const outcome = await proving;
      // A NAME NOBODY ELSE QUEUED ON is forgotten: a daemon sees every NAR
      // name it will ever be pushed, and a chain per name would be all of them.
      if (chain.tail === tail) proofs.delete(key);
      joined.delete(key);
      return outcome;
    },
  };
}
