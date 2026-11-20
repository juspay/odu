import { randomUUID } from "node:crypto";
import { type DirectStore, directUploads, type ObjectStore, TEMP, type UploadedPart } from "@odu/objects";
import type { BucketRow } from "./db";
import type { DirectComplete, DirectPart, StagingDeps } from "./staging";
import type { UploadPlan } from "./paths";
import { PRESIGN_SECONDS } from "./surface";

export interface DirectUpload {
  readonly id: string;
  readonly bucket: string;
  readonly file: string;
  readonly key: string;
  readonly store: DirectStore;
  readonly upload: string;
  readonly partSize: number;
  touched: number;
}

export interface DirectUploads {
  begin(bucket: BucketRow, file: string, floor: number | null): Promise<UploadPlan>;
  part(bucket: BucketRow, file: string, upload: string, index: number): Promise<DirectPart>;
  complete(
    bucket: BucketRow,
    file: string,
    upload: string,
    parts: readonly UploadedPart[],
  ): Promise<DirectComplete>;
  landedFor(bucket: string, file: string): DirectUpload | null;
  drop(direct: DirectUpload): Promise<void>;
  expire(cutoff: number): Promise<readonly string[]>;
}

const MAX_PARTS = 10_000;

export function createDirectUploads(deps: {
  storeOf: (bucket: BucketRow) => ObjectStore;
  now: () => number;
  log?: StagingDeps["log"];
}): DirectUploads {
  const { storeOf, now, log } = deps;
  const directs = new Map<string, DirectUpload>();
  const landed = new Map<string, DirectUpload>();

  const directKey = (bucket: string, file: string): string => `${bucket}/${file}`;

  function heldUpload(bucket: BucketRow, file: string, upload: string): DirectUpload | null {
    const direct = directs.get(upload);
    return direct !== undefined && direct.bucket === bucket.name && direct.file === file
      ? direct
      : null;
  }

  async function drop(direct: DirectUpload): Promise<void> {
    directs.delete(direct.id);
    if (landed.get(directKey(direct.bucket, direct.file))?.id === direct.id) {
      landed.delete(directKey(direct.bucket, direct.file));
    }
    await direct.store.abortUpload(direct.key, direct.upload).catch(() => {});
    await direct.store.delete(direct.key).catch(() => {});
  }

  return {
    async begin(bucket, file, floor) {
      const store = directUploads(storeOf(bucket));
      if (store === null) return { mode: "staged" };
      // S3 refuses a part below its minimum, except the last.
      const partSize = Math.max(store.partSize, floor ?? 0);
      const key = `${bucket.name}/nar/${TEMP}${randomUUID()}`;
      const direct: DirectUpload = {
        id: randomUUID(),
        bucket: bucket.name,
        file,
        key,
        store,
        upload: await store.createUpload(key),
        partSize,
        touched: now(),
      };
      directs.set(direct.id, direct);
      return {
        mode: "direct",
        upload: direct.id,
        partSize,
        part: store.presignPart(key, direct.upload, 0, PRESIGN_SECONDS).href,
      };
    },

    async part(bucket, file, upload, index) {
      const direct = heldUpload(bucket, file, upload);
      if (direct === null) {
        return { ok: false, status: 404, message: `no upload ${upload} for nar/${file}` };
      }
      if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_PARTS) {
        return { ok: false, status: 400, message: `"${index}" is not a part index` };
      }
      direct.touched = now();
      return {
        ok: true,
        url: direct.store.presignPart(direct.key, direct.upload, index, PRESIGN_SECONDS).href,
      };
    },

    async complete(bucket, file, upload, parts) {
      const direct = heldUpload(bucket, file, upload);
      if (direct === null) {
        return { ok: false, status: 404, message: `no upload ${upload} for nar/${file}` };
      }
      const failed = async (message: string): Promise<DirectComplete> => {
        await drop(direct);
        return { ok: false, status: 400, message };
      };
      if (parts.length < 1 || parts.length > MAX_PARTS) {
        return await failed(`${parts.length} is not a part count for one NAR`);
      }
      try {
        const decided = await direct.store.completeUpload(direct.key, direct.upload, parts);
        if (decided !== "stored") {
          return await failed(`the store did not join the parts (${decided})`);
        }
      } catch (err) {
        return await failed(String((err as Error).message ?? err));
      }
      const bytes = await direct.store.head(direct.key).catch(() => null);
      if (bytes === null) {
        await drop(direct);
        return {
          ok: false,
          status: 400,
          message: `nar/${file} is not in the store: the upload never landed`,
        };
      }
      landed.set(directKey(bucket.name, file), direct);
      log?.("cache.nar.uploaded", {
        bucket: bucket.name,
        file,
        mode: "direct",
        parts: parts.length,
        bytes,
      });
      return { ok: true, parts: parts.length, bytes };
    },

    landedFor(bucket, file) {
      return landed.get(directKey(bucket, file)) ?? null;
    },

    drop,

    async expire(cutoff) {
      const released: string[] = [];
      for (const direct of [...directs.values()]) {
        if (direct.touched >= cutoff) continue;
        await drop(direct);
        released.push(directKey(direct.bucket, direct.file));
      }
      return released;
    },
  };
}
