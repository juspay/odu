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
import { basename, join } from "node:path";
import type { ObjectStore } from "./objectStore";
import { verifyNarFile } from "./store";
import type { BucketRow } from "./db";
import {
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
  | { ok: false; status: 400; message: string };

/**
 * A PART THAT WENT OVER THE CEILING is answered by {@link Upload.write}
 * returning `"too-large"` rather than throwing: the route's refusal is an HTTP
 * status about the protocol, and a sentinel is one branch rather than an error
 * class crossing a stream boundary.
 */
export type UploadWrite = "ok" | "too-large";

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
export function objectKey(bucket: string, narHash: string): string {
  return `${bucket}/nar/${narHash.replace(/^sha256:/, "")}.${SERVED_EXTENSION}`;
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
  /** One narinfo at a time per bucket: two PUTs for one bucket must not put the
   *  same staged file concurrently. */
  const records = new Map<string, Chain>();
  let lastSweep = 0;

  /**
   * THE INVARIANT THE PRIVATE-BUCKET STORY RESTS ON: a row is recorded only
   * when the NAR it names has been shown to carry the bytes it claims.
   */
  async function ensureStaged(
    bucket: BucketRow,
    dirForBucket: string,
    info: NarInfo,
  ): Promise<{ ok: true; file: string } | { ok: false; message: string }> {
    const name = basename(info.url);
    if (!isStagedFileName(name)) {
      return { ok: false, message: `narinfo names ${info.url}, which is not a NAR this cache staged` };
    }
    const staged = join(dirForBucket, "nar", name);
    const checked = await verifyNarFile(staged, info.compression);
    if (checked.ok) {
      if (checked.narHash !== info.narHash) {
        return {
          ok: false,
          message:
            `${info.url} hashes to ${checked.narHash} but the narinfo says ` +
            `${info.narHash} — the upload was truncated or corrupted`,
        };
      }
      return { ok: true, file: staged };
    }
    if (!checked.absent) return { ok: false, message: `${info.url}: ${checked.message}` };

    // THE SECOND PROOF OF POSSESSION. Two store paths with identical content
    // share a NarHash; the first to be recorded took the staged NAR with it, so
    // a twin's narinfo finds only the object. Copy it back for this proof.
    const object = await objects.get(objectKey(bucket.name, info.narHash));
    if (object === null) {
      return {
        ok: false,
        message: `the narinfo names ${info.url}, which was never uploaded to this bucket`,
      };
    }
    const materialised = join(dirForBucket, "nar", `${info.narHash.slice(7)}.${SERVED_EXTENSION}`);
    const sink = Bun.file(materialised).writer({ highWaterMark: 1 << 20 });
    try {
      for await (const chunk of object.stream as unknown as AsyncIterable<Uint8Array>) {
        await sink.write(chunk);
      }
    } finally {
      await sink.end();
    }
    return { ok: true, file: materialised };
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
        await sink.write(chunk);
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
    return { ok: true, parts: total };
  }

  /** Take the proved file into the object store; the row learns its facts. A
   *  put failure refuses the push (the bytes are not safely kept). */
  async function keep(
    bucket: BucketRow,
    info: NarInfo,
    staged: string,
  ): Promise<{ fileHash: string; fileSize: number } | null> {
    try {
      const facts = await objects.put(objectKey(bucket.name, info.narHash), Bun.file(staged).stream());
      await unlink(staged).catch(() => {});
      return { fileHash: facts.sha256, fileSize: facts.size };
    } catch (err) {
      log?.("cache.object.put_failed", {
        bucket: bucket.name,
        path: info.storePath,
        reason: String((err as Error).message ?? err),
      });
      return null;
    }
  }

  async function recordNow(
    bucket: BucketRow,
    hash: string,
    info: NarInfo,
    staged: string,
  ): Promise<NarinfoOutcome> {
    const file = await keep(bucket, info, staged);
    if (file === null) {
      return {
        ok: false,
        status: 400,
        message: `${info.storePath} could not be stored: the object store refused it`,
      };
    }
    await record(bucket, info, file);
    log?.("cache.import.recorded", {
      bucket: bucket.name,
      path: info.storePath,
      bytes: info.narSize,
      fileSize: file.fileSize,
    });
    return { ok: true, status: 200, storePath: info.storePath };
  }

  return {
    async close() {
      await Promise.all([...completes.values()].map((chain) => chain.tail));
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

      const staged = await ensureStaged(bucket, dirForBucket, info);
      if (!staged.ok) {
        return { ok: false, status: 400, message: staged.message };
      }
      let chain = records.get(bucket.name);
      if (chain === undefined) {
        chain = newChain();
        records.set(bucket.name, chain);
      }
      return serial(chain, () => recordNow(bucket, hash, info, staged.file));
    },
  };
}
