/**
 * A store that is not a store — the seam the cache's tests need.
 *
 * `BlobStore` exists so the bytes can be somebody else's: the Nix store today,
 * S3 in PR 11, and THIS in the suite. It records what it was asked to do
 * (`calls`) rather than doing it, because half of what the cache promises is
 * about the CALLS — a retained path is a `retain`, an evicted one is a
 * `release` then a `delete` — and a fake that only held bytes could not say.
 *
 * Deliberately outside `src`: a fake in the shipped directory is a fake a
 * consumer hydrates.
 */

import type { BlobStore, DeleteOutcome, ImportOutcome, PathInfo, StagedImport } from "../src/store";
import { canonicalNarHash, narHashBase32, storePathHash } from "../src/narinfo";

export interface RecordedCall {
  op: "has" | "pathInfo" | "import" | "dump" | "retain" | "release" | "delete";
  bucket?: string;
  storePath: string;
}

export interface FakePath {
  storePath: string;
  narHash: string;
  narSize: number;
  references: readonly string[];
  deriver?: string | null;
  sigs?: readonly string[];
  /** The bytes a `dump` streams. Defaults to the store path's own name. */
  bytes?: Uint8Array;
  /** How many chunks `dump` splits the bytes into. */
  chunks?: number;
}

export class FakeStore implements BlobStore {
  readonly calls: RecordedCall[] = [];
  /** The metadata the store knows — what `pathInfo` answers with, once a path
   *  is PRESENT. */
  readonly paths = new Map<string, FakePath>();
  /** Which paths are VALID, which is what an import is actually about: a path
   *  whose references are not valid yet cannot be added, which is the ordering
   *  fact `nix copy` refuses on and the cache defers. */
  readonly present = new Set<string>();
  readonly retained = new Set<string>();
  readonly deleted: string[] = [];
  /** Paths this store refuses to delete — "another root holds it". */
  readonly immortal = new Set<string>();
  /** What `import` should answer, by store path. Default: succeed. */
  readonly importOutcome = new Map<string, ImportOutcome>();
  /** Every staged import attempted, in order. */
  readonly staged: StagedImport[] = [];

  /** Register metadata, and say whether the store already HAS the bytes. */
  add(path: FakePath, present = true): FakePath {
    this.paths.set(path.storePath, path);
    if (present) this.present.add(path.storePath);
    return path;
  }

  /** Retained as `<bucket>/<path>`, so a test can name one without rebuilding
   *  the key. */
  isRetained(bucket: string, storePath: string): boolean {
    return this.retained.has(`${bucket}/${storePath}`);
  }

  async has(storePath: string): Promise<boolean> {
    this.calls.push({ op: "has", storePath });
    return this.present.has(storePath);
  }

  async pathInfo(storePath: string): Promise<PathInfo | null> {
    this.calls.push({ op: "pathInfo", storePath });
    const path = this.paths.get(storePath);
    if (path === undefined || !this.present.has(storePath)) return null;
    return {
      storePath,
      narHash: canonicalNarHash(path.narHash),
      narSize: path.narSize,
      references: path.references,
      deriver: path.deriver ?? null,
      sigs: path.sigs ?? [],
    };
  }

  async import(staged: StagedImport): Promise<ImportOutcome> {
    this.calls.push({ op: "import", storePath: staged.storePath });
    this.staged.push(staged);
    const forced = this.importOutcome.get(staged.storePath);
    if (forced !== undefined) return forced;
    // A reference that is not valid yet is exactly what Nix says "is not
    // valid" about, so the fake says the same thing.
    const missing = (this.paths.get(staged.storePath)?.references ?? []).filter(
      (reference) => reference !== staged.storePath && !this.present.has(reference),
    );
    if (missing.length > 0) {
      return { ok: false, defer: true, message: `path '${missing[0] as string}' is not valid` };
    }
    this.present.add(staged.storePath);
    return { ok: true };
  }

  dump(storePath: string): ReadableStream<Uint8Array> {
    this.calls.push({ op: "dump", storePath });
    const path = this.paths.get(storePath);
    const bytes = path?.bytes ?? new TextEncoder().encode(storePath);
    const pieces = split(bytes, path?.chunks ?? 1);
    let at = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= pieces.length) {
          controller.close();
          return;
        }
        controller.enqueue(pieces[at] as Uint8Array);
        at += 1;
      },
    });
  }

  async retain(bucket: string, storePath: string): Promise<void> {
    this.calls.push({ op: "retain", bucket, storePath });
    this.retained.add(`${bucket}/${storePath}`);
  }

  async release(bucket: string, storePath: string): Promise<void> {
    this.calls.push({ op: "release", bucket, storePath });
    this.retained.delete(`${bucket}/${storePath}`);
  }

  async delete(storePath: string): Promise<DeleteOutcome> {
    this.calls.push({ op: "delete", storePath });
    if (this.immortal.has(storePath)) return "kept";
    this.deleted.push(storePath);
    this.paths.delete(storePath);
    this.present.delete(storePath);
    return "deleted";
  }
}

const split = (bytes: Uint8Array, chunks: number): Uint8Array[] => {
  if (chunks <= 1) return [bytes];
  const size = Math.ceil(bytes.length / chunks);
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size));
  return out;
};

/** The nar hash of a path, in the spelling a narinfo URL uses. */
export const narBase32Of = (path: FakePath): string => narHashBase32(path.narHash);

/** The `<hash>` a narinfo is named for. */
export const hashOf = (storePath: string): string => storePathHash(storePath);
