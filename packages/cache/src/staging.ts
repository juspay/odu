/**
 * THE WRITE PATH — staging an upload, proving it, and importing it in order.
 *
 * This is the part of the cache that moves on the NIX PROTOCOL's clock: what a
 * client uploads, in what order, how an upload that arrives before its
 * references is handled, and how a half-finished upload is reclaimed. None of
 * that changes when a bucket gains an org or the rows move to Postgres, which
 * is why it is not in `cache.ts` beside the administration — the two would be
 * reopened for reasons that have nothing to do with each other.
 *
 * **An upload is PROVED before it is believed.** The staged pair is a
 * `file://` cache — `nar/<file>` and `<hash>.narinfo`, the layout the client
 * would have written — and `nix copy --from file://<dir>` imports it. But Nix
 * only verifies the NarHash when it actually fetches, and it fetches NOTHING
 * when the path is already valid in the destination store: it copies zero
 * paths and exits 0. On a single machine — where the cache's store is the
 * host's — that is the normal case, so "Nix verified it" is true exactly when
 * it does not matter. So {@link ensureStaged} hashes the uploaded NAR against
 * the narinfo's `NarHash` BEFORE any import is attempted. Without that, a
 * write token for any bucket could publish any path the store happens to hold,
 * including another bucket's private ones, with a narinfo alone.
 *
 * **An upload whose references have not arrived is DEFERRED, not refused.**
 * `nix copy --to` may send a closure in any order, and a server that insisted
 * on one would refuse a client it had no business refusing. The narinfo PUT
 * answers 202 and the entry waits for the reference that unblocks it.
 *
 * **Staging is swept by FILE, and only when nothing is writing.** A client
 * killed between the two PUTs leaves a NAR that nothing will name; an in-flight
 * upload must not be swept out from under its writer.
 */

import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { BlobStore } from "./store";
import { verifyNarFile, writeStreamToFile } from "./store";
import type { BucketRow, CacheRepo } from "./db";
import {
  formatNarinfo,
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
  write(chunk: Uint8Array): Promise<void>;
  commit(): Promise<void>;
  discard(): Promise<void>;
}

/** What a narinfo PUT came to. `status` is the answer the route sends. */
export type NarinfoOutcome =
  /** Recorded: the bucket serves this path. */
  | { ok: true; status: 200; storePath: string }
  /** Accepted, but waiting on references that are not in the store yet. */
  | { ok: true; status: 202; storePath: string; missing: readonly string[] }
  /** Refused, with the sentence to put in the body. */
  | { ok: false; status: 400; message: string };

/** What a staged `file://` cache contains, and the first thing a client reads
 *  from a real one. */
export const NIX_CACHE_INFO = "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n";

/** How long a staged upload nobody finished survives. */
const STAGE_TTL_MS = 60 * 60 * 1000;

/** How often the staging directory is swept. Sweeping on every upload would be
 *  a readdir of every bucket on every PUT. */
const SWEEP_EVERY_MS = 60 * 1000;

/** One staged narinfo waiting for its turn, and what it is waiting on. */
interface Pending {
  hash: string;
  info: NarInfo;
  /** References Nix said were not valid. Empty means "not attempted yet". */
  waitingOn: readonly string[];
  /**
   * The bytes were hashed by THIS process, either when the narinfo arrived or
   * by an attempt that got as far as Nix. An entry recovered from disk after a
   * restart is `false` and is proved on its first attempt.
   *
   * Without this the same 2 GiB upload is decompressed and hashed twice by odu
   * before Nix hashes it a third time.
   */
  proved: boolean;
}

export interface StagingDeps {
  repo: CacheRepo;
  blob: BlobStore;
  /** The cache's own directory; staging lives at `<dir>/staging`. */
  dir: string;
  now: () => number;
  /**
   * Put an imported path in a bucket, and answer whether it landed. Supplied
   * by `cache.ts` because it is the one thing the write path shares with
   * administration — a pin and a collection take the same write lock — and a
   * second lock here would be a second answer to "who may change retention".
   */
  record: (
    bucket: BucketRow,
    storePath: string,
    expectedNarHash: string,
    clientSigs: readonly string[],
  ) => Promise<boolean>;
}

export interface Staging {
  beginUpload(bucket: BucketRow, file: string): Promise<Upload>;
  acceptNarinfo(
    bucket: BucketRow,
    hash: string,
    body: ReadableStream<Uint8Array>,
  ): Promise<NarinfoOutcome>;
}

export function createStaging(deps: StagingDeps): Staging {
  const { repo, blob, now, record } = deps;
  const stagingRoot = join(deps.dir, "staging");
  const stagedDir = (bucket: string): string => join(stagingRoot, bucket);

  /** Uploads with an open file handle, by absolute path. The sweep must not
   *  delete one, and `commit` must not lose one. */
  const openUploads = new Set<string>();
  /** One drain at a time per bucket: two narinfo PUTs for one bucket must not
   *  import, unlink and record the same staged pair concurrently. */
  const drains = new Map<string, Chain>();
  /** The staged narinfos this process knows about, by bucket then by hash. */
  const pending = new Map<string, Map<string, Pending>>();
  /** Store paths recovered from disk on a bucket's first load, waiting to be
   *  handed to the first drain. */
  const recoveredSeeds = new Map<string, string[]>();
  let lastSweep = 0;

  /**
   * THE INVARIANT THE PRIVATE-BUCKET STORY RESTS ON: a narinfo is imported
   * only when the NAR it names has been shown to carry the bytes it claims.
   *
   * Answers the narinfo to import FROM, because proving the bytes and knowing
   * where they are is one question: when the staged file is gone and the
   * bucket already holds the same bytes, the file is rebuilt and the answer
   * names it.
   */
  async function ensureStaged(
    bucket: BucketRow,
    dirForBucket: string,
    info: NarInfo,
  ): Promise<{ ok: true; info: NarInfo } | { ok: false; message: string }> {
    const name = basename(info.url);
    if (!isStagedFileName(name)) {
      return { ok: false, message: `narinfo names ${info.url}, which is not a NAR this cache staged` };
    }
    const checked = await verifyNarFile(join(dirForBucket, "nar", name), info.compression);
    if (checked.ok) {
      if (checked.narHash !== info.narHash) {
        return {
          ok: false,
          message:
            `${info.url} hashes to ${checked.narHash} but the narinfo says ` +
            `${info.narHash} — the upload was truncated or corrupted`,
        };
      }
      return { ok: true, info };
    }
    // NOT THERE IS NOT THE SAME AS WRONG. A file that is absent has not been
    // judged — and a concurrent drain may have taken it a moment ago — so the
    // second proof below still applies. Bytes that are there and disagree are
    // the client's error and are answered as one.
    if (!checked.absent) {
      return { ok: false, message: `${info.url}: ${checked.message}` };
    }

    // THE SECOND PROOF OF POSSESSION. Two store paths with identical content
    // share a `NarHash`, and the first to be recorded takes the staged NAR
    // with it — so a twin's narinfo can arrive to find the file gone. The
    // bucket has still proved these bytes: an object with that hash is a row
    // this cache wrote after hashing an upload. Rebuild the file from it, so
    // the import that follows has something to read.
    const twin = repo.objectByNarHash(bucket.name, info.narHash);
    if (twin === null) {
      return {
        ok: false,
        message: `the narinfo names ${info.url}, which was never uploaded to this bucket`,
      };
    }
    return { ok: true, info: await materialise(dirForBucket, info, twin.storePath) };
  }

  /** Rebuild a staged NAR from a path the bucket already holds with the same
   *  bytes, and rewrite the staged narinfo to name it. */
  async function materialise(
    dirForBucket: string,
    info: NarInfo,
    twinPath: string,
  ): Promise<NarInfo> {
    const name = `${info.narHash.replace(/^sha256:/, "")}.${SERVED_EXTENSION}`;
    await writeStreamToFile(blob.dump(twinPath), join(dirForBucket, "nar", name));
    const rewritten: NarInfo = {
      ...info,
      url: `nar/${name}`,
      compression: "zstd",
      fileHash: null,
      fileSize: null,
    };
    // ON DISK too: a restart re-parses this file, and a narinfo naming a URL
    // that is not there would be refused by its own proof.
    await writeFile(
      join(dirForBucket, `${storePathHash(info.storePath)}.narinfo`),
      formatNarinfo(rewritten),
    );
    return rewritten;
  }

  /** The staged narinfos this process knows about, loaded once from disk. A
   *  restart must not lose an upload that was merely early. */
  async function ensurePending(bucket: BucketRow): Promise<Map<string, Pending>> {
    const known = pending.get(bucket.name);
    if (known !== undefined) return known;
    const map = new Map<string, Pending>();
    pending.set(bucket.name, map);
    const dirForBucket = stagedDir(bucket.name);
    for (const file of await readdir(dirForBucket).catch(() => [] as string[])) {
      if (!file.endsWith(".narinfo")) continue;
      const hash = file.slice(0, -".narinfo".length);
      try {
        const info = parseNarinfo(await readFile(join(dirForBucket, file), "utf8"));
        // `waitingOn: []` means "never attempted" and `proved: false` means
        // "this process has not hashed it", which are both exactly right for a
        // narinfo recovered from disk.
        map.set(hash, { hash, info, waitingOn: [], proved: false });
      } catch {
        await unlink(join(dirForBucket, file)).catch(() => {});
      }
    }
    // A RECOVERED NARINFO MUST BE ATTEMPTED. `drain` only tries entries its
    // `seed` names, and a restart has no seed — so without this the uploads
    // that survived the restart sit until the sweep deletes them an hour later.
    recoveredSeeds.set(bucket.name, [...map.values()].map((entry) => entry.info.storePath));
    return map;
  }

  /** One import, and the row that follows it. */
  async function attempt(
    bucket: BucketRow,
    dirForBucket: string,
    entry: Pending,
  ): Promise<"recorded" | { missing: readonly string[] } | { failed: string }> {
    if (!entry.proved) {
      const staged = await ensureStaged(bucket, dirForBucket, entry.info);
      if (!staged.ok) return { failed: staged.message };
      entry.info = staged.info;
      entry.proved = true;
    }
    const outcome = await blob.import({ dir: dirForBucket, storePath: entry.info.storePath });
    if (!outcome.ok) {
      return outcome.missing.length > 0 ? { missing: outcome.missing } : { failed: outcome.message };
    }
    await record(bucket, entry.info.storePath, entry.info.narHash, entry.info.sigs);
    return "recorded";
  }

  /**
   * Import what can be imported, ONE AT A TIME per bucket, and only the
   * narinfos a newly-valid path can unblock.
   *
   * `seed` names the store paths whose validity just changed. A pass imports
   * those, then anything that was waiting on a path that pass recorded, until
   * nothing new becomes importable — so a closure arriving out of order
   * settles in one call and costs one `nix copy` per path, not one per path
   * per PUT.
   */
  async function drain(bucket: BucketRow, seed: readonly string[]): Promise<void> {
    const map = await ensurePending(bucket);
    const recovered = recoveredSeeds.get(bucket.name) ?? [];
    recoveredSeeds.delete(bucket.name);
    const seeds = [...new Set([...seed, ...recovered])];
    const dirForBucket = stagedDir(bucket.name);
    await mkdir(dirForBucket, { recursive: true, mode: 0o700 });
    await writeFile(join(dirForBucket, "nix-cache-info"), NIX_CACHE_INFO).catch(() => {});

    let changed = [...seeds];
    while (changed.length > 0) {
      const candidates = [...map.values()].filter((entry) =>
        entry.waitingOn.length === 0
          ? seeds.includes(entry.info.storePath)
          : entry.waitingOn.some((reference) => changed.includes(reference)),
      );
      if (candidates.length === 0) return;
      const recorded: string[] = [];
      for (const entry of candidates) {
        const result = await attempt(bucket, dirForBucket, entry);
        if (result === "recorded") {
          map.delete(entry.hash);
          // Always safe: a twin whose narinfo has not arrived yet is proved by
          // the object this record just wrote, and rebuilt from it.
          await unlink(join(dirForBucket, "nar", basename(entry.info.url))).catch(() => {});
          await unlink(join(dirForBucket, `${entry.hash}.narinfo`)).catch(() => {});
          recorded.push(entry.info.storePath);
          continue;
        }
        if ("missing" in result) {
          entry.waitingOn = result.missing;
          continue;
        }
        // A refusal is the client's: the bytes never came, or they were wrong.
        // Drop it so it cannot be retried forever, and let the PUT answer 400.
        map.delete(entry.hash);
        await unlink(join(dirForBucket, `${entry.hash}.narinfo`)).catch(() => {});
      }
      changed = recorded;
    }
  }

  /** One drain at a time per bucket. */
  function queuedDrain(bucket: BucketRow, seed: readonly string[]): Promise<void> {
    let chain = drains.get(bucket.name);
    if (chain === undefined) {
      chain = newChain();
      drains.set(bucket.name, chain);
    }
    return serial(chain, () => drain(bucket, seed));
  }

  /** Remove staged FILES older than an hour — a client that died between the
   *  NAR PUT and the narinfo PUT leaves one behind every time.
   *
   * Per file, not per directory: `nar/` is a directory whose own mtime says
   * nothing about the uploads inside it, and removing it would take an upload
   * in progress with it. Open uploads are skipped outright. */
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
          await rm(path, { force: true }).catch(() => {});
          // A swept narinfo is not pending any more; leaving it in the map
          // grows it by one per abandoned upload for the life of the process.
          if (entry.endsWith(".narinfo")) {
            pending.get(bucket)?.delete(entry.slice(0, -".narinfo".length));
          }
        }
      }
    }
  }

  return {
    async beginUpload(bucket, file) {
      await sweep();
      const dirForBucket = stagedDir(bucket.name);
      await mkdir(join(dirForBucket, "nar"), { recursive: true, mode: 0o700 });
      // The route has already refused a name it does not recognise, and this
      // is the wall behind that one: it REFUSES too, rather than sanitizing,
      // because a sanitizer turns `../..` into a plausible file name and a
      // caller that skipped the route would never learn it had.
      if (!isStagedFileName(file)) {
        throw new Error(`"${file}" is not a NAR file name`);
      }
      const path = join(dirForBucket, "nar", file);
      // A UNIQUE temp name, renamed into place on commit. Two store paths with
      // identical content share a NAR name, and two writers opening one file
      // truncate each other; the bytes are identical by construction, so an
      // atomic rename is the whole fix.
      const part = `${path}.${randomUUID()}.part`;
      openUploads.add(part);
      // BUN'S FILE SINK, and the primitive is the whole of an upload's memory.
      // The body reaches us with correct backpressure either way — writing
      // nothing at all leaves a 2 GiB push flat at 295–305 MiB — so the peak is
      // decided by how the bytes get to the disk. Measured on a 2 GiB push, the
      // daemon's RSS sampled every 0.5 s, idle 227 MiB:
      //
      //   `FileHandle.write` per chunk      324–1366 MiB   (Node's `fs` shim)
      //   `createWriteStream` + `pipeline`  379–1328 MiB   (the same shim)
      //   `writeSync` on a raw descriptor   304–325 MiB    (blocks the loop)
      //   **`Bun.file(part).writer()`**     299–316 MiB    (this, and 289 at 256 MiB)
      //
      // Node's `fs` shim leaves each chunk buffer to the collector, so the
      // peak is whatever the collector happened not to reclaim: the same 2 GiB
      // upload peaked at 324 in one run and 1366 in another, and forcing
      // `Bun.gc(false)` every 256 MiB merely bounded it to 360–486. The sink
      // owns the buffer, so the number stops depending on the collector's mood.
      // The descriptor sink is the fallback if this runtime's writer ever goes
      // away: it measures the same, at the cost of a stalled event loop.
      const sink = Bun.file(part).writer({ highWaterMark: 1 << 20 });
      const release = (): void => {
        openUploads.delete(part);
      };
      return {
        async write(chunk) {
          await sink.write(chunk);
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
    },

    async acceptNarinfo(bucket, hash, body) {
      if (!isStorePathHash(hash)) {
        return { ok: false, status: 400, message: `"${hash}" is not a store path hash` };
      }
      const dirForBucket = stagedDir(bucket.name);
      await mkdir(dirForBucket, { recursive: true, mode: 0o700 });
      const path = join(dirForBucket, `${hash}.narinfo`);
      await writeStreamToFile(body, path);
      let info: NarInfo;
      try {
        info = parseNarinfo(await readFile(path, "utf8"));
      } catch (err) {
        await unlink(path).catch(() => {});
        return {
          ok: false,
          status: 400,
          message: err instanceof Error ? err.message : String(err),
        };
      }
      if (storePathHash(info.storePath) !== hash) {
        await unlink(path).catch(() => {});
        return {
          ok: false,
          status: 400,
          message: `narinfo names ${info.storePath}, which is not ${hash}.narinfo`,
        };
      }

      // The bytes are proved BEFORE the narinfo is queued, so a narinfo with no
      // NAR behind it can never be imported by a later drain. The proof is
      // carried on the entry, so the drain does not hash the same 2 GiB again.
      const staged = await ensureStaged(bucket, dirForBucket, info);
      if (!staged.ok) {
        await unlink(path).catch(() => {});
        return { ok: false, status: 400, message: staged.message };
      }

      const map = await ensurePending(bucket);
      const entry: Pending = { hash, info: staged.info, waitingOn: [], proved: true };
      map.set(hash, entry);
      await queuedDrain(bucket, [info.storePath]);

      if (repo.object(bucket.name, info.storePath) !== null) {
        return { ok: true, status: 200, storePath: info.storePath };
      }
      const still = map.get(hash);
      if (still !== undefined && still.waitingOn.length > 0) {
        return { ok: true, status: 202, storePath: info.storePath, missing: still.waitingOn };
      }
      return {
        ok: false,
        status: 400,
        message: `${info.storePath} could not be imported: the upload was refused`,
      };
    },
  };
}
