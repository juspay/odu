/**
 * A store that is not a store — the seam the cache's tests need.
 *
 * `BlobStore` exists so the bytes can be somebody else's: the Nix store today,
 * S3 in PR 11, and THIS in the suite. It records what it was asked to do
 * (`calls`) rather than doing it, because half of what the cache promises is
 * about the CALLS — a retained path is a `retain`, an evicted one is a
 * `release` then a `delete`, a closure is ONE `closure` — and a fake that only
 * held bytes could not say.
 *
 * It also models the thing that makes the write path interesting: a path whose
 * references are not VALID yet cannot be imported. That is not a detail of Nix,
 * it is the ordering fact the whole deferred-upload design exists for, so the
 * fake says "is not valid" the way Nix does.
 *
 * Deliberately outside `src`: a fake in the shipped directory is a fake a
 * consumer hydrates.
 */

import type {
  BlobStore,
  DeleteOutcome,
  ImportOutcome,
  PathInfo,
  StagedImport,
  UpstreamCache,
} from "../src/store";
import { canonicalNarHash, narHashBase32, storePathHash } from "../src/narinfo";

export interface RecordedCall {
  op: "has" | "pathInfo" | "closure" | "import" | "dump" | "retain" | "release" | "delete" | "substitute";
  bucket?: string;
  storePath: string;
}

export interface FakePath {
  storePath: string;
  narHash: string;
  narSize: number;
  references: readonly string[];
  deriver?: string | null;
  ca?: string | null;
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
  /** What `import` should answer, by store path, instead of the reference
   *  check. */
  readonly importOutcome = new Map<string, ImportOutcome>();
  /** Nix reports the FIRST invalid reference, not every one. Set this to make
   *  the fake say what `nix copy` says, so a caller that trusts stderr alone
   *  is caught fetching one reference per attempt. */
  reportOneMissing = false;
  /** Every staged import attempted, in order. */
  readonly staged: StagedImport[] = [];
  /** Paths an UPSTREAM cache could serve, with the signatures they carry. A
   *  path here becomes valid after `substitute`, the way `nix-store -r` would
   *  make it. */
  readonly upstream = new Map<string, FakePath>();
  /** The upstreams `substitute` was offered, per call — the key names a bucket
   *  asked for, which is what a test asserts the fetch was scoped to. */
  readonly substituted: {
    readonly paths: readonly string[];
    readonly keyNames: readonly string[];
  }[] = [];

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
    return this.infoOf(storePath);
  }

  async pathInfos(paths: readonly string[]): Promise<PathInfo[]> {
    this.calls.push({ op: "pathInfo", storePath: paths.join(",") });
    return paths.flatMap((path) => {
      const info = this.infoOf(path);
      return info === null ? [] : [info];
    });
  }

  async closure(paths: readonly string[]): Promise<PathInfo[]> {
    this.calls.push({ op: "closure", storePath: paths.join(",") });
    const seen = new Set<string>();
    const queue = [...paths];
    while (queue.length > 0) {
      const path = queue.pop() as string;
      if (seen.has(path)) continue;
      seen.add(path);
      for (const reference of this.paths.get(path)?.references ?? []) queue.push(reference);
    }
    return [...seen].flatMap((path) => {
      const info = this.infoOf(path);
      return info === null ? [] : [info];
    });
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
      const said = this.reportOneMissing ? missing.slice(0, 1) : missing;
      return { ok: false, missing: said, message: `path '${said[0] as string}' is not valid` };
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

  async presentOf(paths: readonly string[]): Promise<ReadonlySet<string>> {
    this.calls.push({ op: "pathInfo", storePath: paths.join(",") });
    return new Set(paths.filter((storePath) => this.present.has(storePath)));
  }

  /** What a fetch should answer, instead of success — S1's failure arm. */
  substituteFailure: string | null = null;

  async substitute(
    paths: readonly string[],
    upstreams: readonly UpstreamCache[],
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    for (const storePath of paths) this.calls.push({ op: "substitute", storePath });
    this.substituted.push({
      paths: [...paths],
      keyNames: upstreams.map((cache) => cache.keyName),
    });
    if (this.substituteFailure !== null) {
      return { ok: false, message: this.substituteFailure };
    }
    const trusted = new Set(upstreams.map((cache) => cache.keyName));
    for (const storePath of paths) {
      const candidate = this.upstream.get(storePath);
      if (candidate === undefined) continue;
      const signed = (candidate.sigs ?? []).some((sig) => {
        const at = sig.indexOf(":");
        return at > 0 && trusted.has(sig.slice(0, at));
      });
      // The fake verifies like Nix: a path signed by a key the caller did not
      // trust is not fetched, and the referrer stays held.
      if (!signed) continue;
      if (!this.paths.has(storePath)) this.paths.set(storePath, candidate);
      this.present.add(storePath);
    }
    return { ok: true };
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
    const { deleted } = await this.deleteMany([storePath]);
    return deleted.length > 0 ? "deleted" : "kept";
  }

  async deleteMany(storePaths: readonly string[]): Promise<{ deleted: string[]; kept: string[] }> {
    const deleted: string[] = [];
    const kept: string[] = [];
    for (const storePath of storePaths) {
      this.calls.push({ op: "delete", storePath });
      if (this.immortal.has(storePath) || !this.present.has(storePath)) {
        kept.push(storePath);
        continue;
      }
      this.deleted.push(storePath);
      this.paths.delete(storePath);
      this.present.delete(storePath);
      deleted.push(storePath);
    }
    return { deleted, kept };
  }

  private infoOf(storePath: string): PathInfo | null {
    const path = this.paths.get(storePath);
    if (path === undefined || !this.present.has(storePath)) return null;
    return {
      storePath,
      narHash: canonicalNarHash(path.narHash),
      narSize: path.narSize,
      references: path.references,
      deriver: path.deriver ?? null,
      ca: path.ca ?? null,
      sigs: path.sigs ?? [],
    };
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
