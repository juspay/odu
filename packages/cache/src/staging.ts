import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { basename, join, relative } from "node:path";
import { directUploads, type ObjectStore, type UploadedPart } from "@odu/objects";
import { createDirectUploads, type DirectUpload } from "./directUpload";
import { type KeptFile, keptFileOf, objectFactsOf } from "./fileHash";
import { writeAll } from "./sink";
import { verifyNarFile, verifyNarStream } from "./store";
import { selfReferencing, type SelfProof } from "./storePath";
import type { BucketRow } from "./db";
import {
  ODU_BUCKET_FIELD,
  ODU_ORIGIN_FIELD,
  type Provenance,
  type UploadMode,
  type UploadPlan,
} from "./paths";
import {
  narFileName,
  isDerivationPath,
  isSafeNarFileName,
  isSafeStorePathHash,
  type NarInfo,
  parseNarinfo,
  SERVED_EXTENSION,
  storePathHash,
} from "./narinfo";
import { newChain, type Chain, serial } from "./serial";
import { PRESIGN_SECONDS } from "./surface";

export interface Upload {
  write(chunk: Uint8Array): Promise<UploadWrite>;
  commit(): Promise<void>;
  discard(): Promise<void>;
}

export type NarinfoOutcome =
  | { ok: true; status: 200; storePath: string }
  | {
      ok: false;
      status: 400 | 404;
      message: string;
      detail?: {
        storePath?: string;
        narinfoHash?: string;
        parts?: number;
        bytesReceived?: number;
        stagedFile?: string | null;
        stagedBytes?: number;
      };
    };

export type UploadWrite = "ok" | "too-large";

type Refusal = Extract<NarinfoOutcome, { ok: false }>;

export type CompleteUpload =
  | { ok: true; parts: number }
  | { ok: false; missing: readonly number[] };

export type { UploadMode, UploadPlan } from "./paths";

export type DirectPart =
  | { ok: true; url: string }
  | { ok: false; status: 400 | 404; message: string };

export type DirectComplete =
  | { ok: true; parts: number; bytes: number }
  | { ok: false; status: 400 | 404; message: string };

/**
 * Priority 41, one worse than cache.nixos.org's 40: at an equal 40 the
 * client's own substituter ORDER decides who serves an upstream-signed path.
 * Nix ignores keys it does not know, so the two `Odu-` lines leave a client
 * unaffected.
 */
export function nixCacheInfo(of: { origin: string; bucket: string }): string {
  return (
    "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 41\n" +
    `${ODU_ORIGIN_FIELD}: ${of.origin}\n${ODU_BUCKET_FIELD}: ${of.bucket}\n`
  );
}

export function isUploadSession(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function partStem(file: string, session: string | null): string {
  return session === null ? file : `${file}.s-${session}`;
}

const STAGE_TTL_MS = 60 * 60 * 1000;

const SWEEP_EVERY_MS = 60 * 1000;

export function objectKey(
  bucket: string,
  narHash: string,
  compression: string | null = "zstd",
): string {
  return narFileKey(bucket, narFileName(narHash, compression));
}

export function narFileKey(bucket: string, file: string): string {
  return `${bucket}/nar/${file}`;
}

export function narinfoKey(bucket: string, hash: string): string {
  return `${bucket}/${hash}.narinfo`;
}

export function cacheInfoKey(bucket: string): string {
  return `${bucket}/nix-cache-info`;
}

export const NAR_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const INFO_CACHE_CONTROL = "public, max-age=86400";

export const NAR_CONTENT_TYPE = "application/x-nix-nar";
export const NARINFO_CONTENT_TYPE = "text/x-nix-narinfo";
export const CACHE_INFO_CONTENT_TYPE = "text/plain";

export function publicObjectUrl(publicUrl: string, key: string): string {
  return `${publicUrl}/${key}`;
}

export function publicBucketUrl(publicUrl: string, bucket: string): string {
  return `${publicUrl}/${bucket}`;
}

export interface StagingDeps {
  storeOf: (bucket: BucketRow) => ObjectStore;
  bucketNow: (name: string) => BucketRow | null;
  dir: string;
  now: () => number;
  withWriteLock: <T>(work: () => Promise<T>) => Promise<T>;
  record: (
    bucket: BucketRow,
    info: NarInfo,
    file: KeptFile,
    selfHash: SelfProof,
    provenance: Provenance,
  ) => Promise<boolean>;
  log?: (event: string, fields: Record<string, unknown>) => void;
  keptFacts: (
    bucket: BucketRow,
    narHash: string,
    compression: string | null,
  ) => Promise<KeptFile | null>;
}

export interface Staging {
  close(): Promise<void>;
  uploadMode(bucket: BucketRow): UploadMode;
  beginDirect(bucket: BucketRow, file: string, floor: number | null): Promise<UploadPlan>;
  directPart(bucket: BucketRow, file: string, upload: string, index: number): Promise<DirectPart>;
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
    provenance: Provenance,
  ): Promise<NarinfoOutcome>;
}

export function createStaging(deps: StagingDeps): Staging {
  const { storeOf, bucketNow, now, record, log, keptFacts, withWriteLock } = deps;
  const stagingRoot = join(deps.dir, "staging");
  const stagedDir = (bucket: string): string => join(stagingRoot, bucket);

  const openUploads = new Set<string>();
  const completes = new Map<string, Chain>();
  const proofs = new Map<string, Chain>();
  const joined = new Map<string, { parts: number; bytes: number; session: string | null }>();
  let lastSweep = 0;
  const directs = createDirectUploads({ storeOf, now, log });

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

  async function proveDirect(
    bucket: BucketRow,
    hash: string,
    info: NarInfo,
    direct: DirectUpload,
    provenance: Provenance,
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
      const selfHashPart = selfReferencing(info.storePath, info.references)
        ? storePathHash(info.storePath)
        : null;
      const checked = await verifyNarStream(object, info.compression, selfHashPart);
      // R2 answered a 1 MiB range with 190 bytes on a key nothing was writing
      // (issue #160).
      if (!checked.ok) {
        return await refuse(
          `${info.url}: ${checked.message}`,
          checked.why === "changed" ? "short_read" : "unreadable",
        );
      }
      if (checked.narHash !== info.narHash) {
        return await refuse(
          `${info.url} hashes to ${checked.narHash} but the narinfo says ` +
            `${info.narHash} — the upload was truncated or corrupted`,
          "nar_hash_mismatch",
        );
      }
      return await recordSerially(bucket, info, checked.selfHash, provenance, (current) =>
        keepCopied(
          current,
          info,
          direct,
          { fileHash: checked.fileHash, fileSize: checked.fileSize },
          object.etag,
        ),
      );
    } finally {
      await directs.drop(direct);
    }
  }

  async function prove(
    bucket: BucketRow,
    hash: string,
    info: NarInfo,
    dirForBucket: string,
    name: string,
    provenance: Provenance,
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
      return recordSerially(
        bucket,
        info,
        selfReferencing(info.storePath, info.references) ? { kind: "unread" } : { kind: "none" },
        provenance,
        async (current) =>
          (await keptFacts(current, info.narHash, info.compression)) ??
          refuse(`the narinfo names ${info.url}, which was never uploaded to this bucket`),
      );
    }
    try {
      const selfHashPart = selfReferencing(info.storePath, info.references)
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
      return await recordSerially(bucket, info, checked.selfHash, provenance, (current) =>
        keep(current, info, claimed.path, { fileHash: checked.fileHash, fileSize: checked.fileSize }),
      );
    } finally {
      openUploads.delete(claimed.path);
      await rm(claimed.path, { force: true }).catch(() => {});
    }
  }

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
          const partAt = entry.lastIndexOf(".part-");
          if (partAt > 0) {
            const marker = await stat(join(at, `${entry.slice(0, partAt)}.uploading`)).catch(
              () => null,
            );
            if (marker !== null && marker.mtimeMs >= cutoff) continue;
          }
          await rm(path, { force: true }).catch(() => {});
          const file = partAt > 0 ? entry.slice(0, partAt) : entry;
          joined.delete(`${bucket}/${file}`);
          if (entry.endsWith(".narinfo")) {
            const hash = entry.slice(0, -".narinfo".length);
            await unlink(join(dirForBucket, `${hash}.narinfo`)).catch(() => {});
          }
        }
      }
    }
    for (const key of await directs.expire(cutoff)) joined.delete(key);
  }

  const MAX_PARTS = 10_000;

  const uploadMarker = (dirForBucket: string, file: string): string =>
    join(dirForBucket, "nar", `${file}.uploading`);

  async function touchUpload(dirForBucket: string, file: string): Promise<void> {
    await writeFile(uploadMarker(dirForBucket, file), "", { mode: 0o600 }).catch(() => {});
  }

  function openAt(
    path: string,
    limit: number | null,
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
      const outcome = await (store.link?.(key, path, expected) ??
        store.put(key, Bun.file(path), expected, {
          contentType: NAR_CONTENT_TYPE,
          cacheControl: NAR_CACHE_CONTROL,
        }));
      if (outcome.ok) return keptFileOf(outcome.facts);
      if (outcome.refusal.kind === "exists") return keptFileOf(outcome.refusal.facts);
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
   * AWS and versitygw hold a copy to `sourceIfMatch`; R2 does not implement
   * the source condition on `UploadPartCopy`.
   */
  async function keepCopied(
    bucket: BucketRow,
    info: NarInfo,
    direct: DirectUpload,
    file: KeptFile,
    version: string | undefined,
  ): Promise<KeptFile | Refusal> {
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

  function recordSerially(
    bucket: BucketRow,
    info: NarInfo,
    selfHash: SelfProof,
    provenance: Provenance,
    keep: (bucket: BucketRow) => Promise<KeptFile | Refusal>,
  ): Promise<NarinfoOutcome> {
    return withWriteLock(async () => {
      const current = bucketNow(bucket.name);
      if (current === null) {
        return { ok: false, status: 404, message: `no bucket "${bucket.name}"` };
      }
      const file = await keep(current);
      if ("ok" in file) return file;
      await record(current, info, file, selfHash, provenance);
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
      if (!isSafeNarFileName(file)) throw new Error(`"${file}" is not a NAR file name`);
      await sweep();
      return await directs.begin(bucket, file, floor);
    },

    async directPart(bucket, file, upload, index) {
      return await directs.part(bucket, file, upload, index);
    },

    async completeDirect(bucket, file, upload, parts) {
      const done = await directs.complete(bucket, file, upload, parts);
      if (done.ok) {
        joined.set(`${bucket.name}/${file}`, {
          parts: done.parts,
          bytes: done.bytes,
          session: null,
        });
      }
      return done;
    },

    async beginUpload(bucket, file) {
      await sweep();
      const dirForBucket = stagedDir(bucket.name);
      await mkdir(join(dirForBucket, "nar"), { recursive: true, mode: 0o700 });
      if (!isSafeNarFileName(file)) throw new Error(`"${file}" is not a NAR file name`);
      await touchUpload(dirForBucket, file);
      return openAt(join(dirForBucket, "nar", file), null, (bytes) => {
        log?.("cache.nar.uploaded", { bucket: bucket.name, file, mode: "staged", parts: 1, bytes });
      });
    },

    async beginPart(bucket, file, index, limit, session = null) {
      if (!isSafeNarFileName(file)) throw new Error(`"${file}" is not a NAR file name`);
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
      if (!isSafeNarFileName(file)) throw new Error(`"${file}" is not a NAR file name`);
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

    async acceptNarinfo(bucket, hash, body, provenance) {
      if (!isSafeStorePathHash(hash)) {
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
      if (!isSafeNarFileName(name)) {
        return {
          ok: false,
          status: 400,
          message: `narinfo names ${info.url}, which is not a NAR this cache staged`,
        };
      }
      const key = `${bucket.name}/${name}`;
      let chain = proofs.get(key);
      if (chain === undefined) {
        chain = newChain();
        proofs.set(key, chain);
      }
      const proving = serial(chain, () => {
        const direct = directs.landedFor(bucket.name, name);
        return direct === null
          ? prove(bucket, hash, info, dirForBucket, name, provenance)
          : proveDirect(bucket, hash, info, direct, provenance);
      });
      const tail = chain.tail;
      try {
        return await proving;
      } finally {
        if (chain.tail === tail) proofs.delete(key);
        joined.delete(key);
      }
    },
  };
}
