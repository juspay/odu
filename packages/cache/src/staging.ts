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
import { createReadStream, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { basename, join } from "node:path";
import type { BlobStore } from "./store";
import { upstreamFor, verifyNarFile, writeStreamToFile } from "./store";
import type { BucketRow, CacheRepo, HeldRow } from "./db";
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
import type { Slots } from "./slots";

/** A write in progress. `commit` publishes it under the name the narinfo will
 *  name; `discard` removes it. */
export interface Upload {
  write(chunk: Uint8Array): Promise<UploadWrite>;
  commit(): Promise<void>;
  discard(): Promise<void>;
}

/** What a narinfo PUT came to. `status` is the answer the route sends. */
export type NarinfoOutcome =
  /** Recorded: the bucket serves this path. */
  | { ok: true; status: 200; storePath: string }
  /** Accepted, but waiting on references that are not in the store yet.
   *  `fetching` is how many are being fetched from upstream right now. */
  | {
      ok: true;
      status: 202;
      storePath: string;
      missing: readonly string[];
      fetching: number;
    }
  /** Refused, with the sentence to put in the body. */
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
  /** How many missing references an upstream fetch is working on right now. */
  fetching: number;
  /** References this hold's fetch already landed. */
  fetched: readonly string[];
  /** The last line a failed fetch said; cleared when a fetch starts again. */
  failure: string | null;
}

export interface StagingDeps {
  repo: CacheRepo;
  /** THE FETCH BOUND, created by the row that owns this staging. */
  slots: Slots;
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
  /** Something a subscriber would see moved — a background fetch landed, or a
   *  hold's reason changed. Supplied by the cache, whose listener it is. */
  changed: () => void;
}

export interface Staging {
  /** Stop accepting background work, and JOIN a fetch already running.
   *  The row awaits this BEFORE its database closes: a `nix-store -r` still in
   *  flight must not import into a database that has gone. */
  close(): Promise<void>;
  /** RE-QUEUE every held row this database remembers. Called at row apply: a
   *  restart must resume a reference fetch, not strand it until a new push. */
  resume(): Promise<void>;
  beginUpload(bucket: BucketRow, file: string): Promise<Upload>;
  /**
   * STAGE ONE PART of a NAR too large for one request. `index` is the part's
   * position; a retry overwrites the same file, so a dropped part is retried
   * on its own rather than restarting the path.
   */
  beginPart(
    bucket: BucketRow,
    file: string,
    index: number,
    limit: number,
  ): Promise<Upload>;
  /**
   * JOIN the parts into the NAR the narinfo will name, then drop them. `total`
   * is the client's count; a gap is answered with the missing indexes rather
   * than a half-assembled file.
   */
  completeUpload(bucket: BucketRow, file: string, total: number): Promise<CompleteUpload>;
  acceptNarinfo(
    bucket: BucketRow,
    hash: string,
    body: ReadableStream<Uint8Array>,
  ): Promise<NarinfoOutcome>;
}

export function createStaging(deps: StagingDeps): Staging {
  const { repo, blob, now, record, changed } = deps;
  let closed = false;
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
  /** One upstream fetch at a time per bucket, off the upload request. */
  const fetches = new Map<string, Chain>();
  /** One COMPLETE at a time per staged file: two clients finishing one NAR
   *  would otherwise unlink parts each other is reading. */
  const completes = new Map<string, Chain>();
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
        map.set(
          hash,
          { hash, info, waitingOn: [], proved: false, fetching: 0, fetched: [], failure: null },
        );
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

  /** One import, and the row that follows it.
   *
   *  A MISSING REFERENCE THE UPSTREAM SIGNED IS NOT WAITED ON IN THE REQUEST.
   *  `nix-store -r` can outlive a proxy's origin timeout (Cloudflare's is ~100
   *  s), so the narinfo answers 202 with "fetching", a row-owned queue does the
   *  substitution, and the import follows when it is done. The hold's reason is
   *  the progress. */
  /**
   * THE REFERRER'S WHOLE MISSING SET, not the one Nix happened to name.
   *
   * `nix copy` fails at the FIRST invalid reference and says so; a job built
   * from stderr therefore fetches one reference per attempt, and the next push
   * discovers the next. Every reference the narinfo lists is checked against
   * the store, so one job covers all of them.
   */
  async function missingOf(entry: Pending, reported: readonly string[] = []): Promise<string[]> {
    const references = entry.info.references.filter((one) => one !== entry.info.storePath);
    // ONE `nix path-info` for the whole set, not one spawn per reference.
    const here = await blob.presentOf(references);
    const out = references.filter((reference) => !here.has(reference));
    for (const one of reported) if (!out.includes(one)) out.push(one);
    return out;
  }

  /** What this job landed since the hold was last written: references that
   *  were missing, are now present, and are still in the narinfo's list. */
  function landed(entry: Pending, still: readonly string[]): string[] {
    const wanted = new Set([...entry.waitingOn, ...entry.fetched]);
    return [...wanted].filter((one) => !still.includes(one));
  }

  async function attempt(
    bucket: BucketRow,
    dirForBucket: string,
    entry: Pending,
  ): Promise<
    "recorded" | { missing: readonly string[]; fetching: number } | { failed: string }
  > {
    if (!entry.proved) {
      const staged = await ensureStaged(bucket, dirForBucket, entry.info);
      if (!staged.ok) return { failed: staged.message };
      entry.info = staged.info;
      entry.proved = true;
    }
    const upstreams = upstreamFor(bucket.upstreamKeys);
    const outcome = await blob.import({ dir: dirForBucket, storePath: entry.info.storePath });
    if (!outcome.ok && outcome.missing.length > 0) {
      const missing = await missingOf(entry, outcome.missing);
      entry.waitingOn = missing;
      entry.fetched = [...new Set([...entry.fetched, ...landed(entry, missing)])];
      entry.failure = null;
      if (upstreams.length > 0) {
        if (entry.fetching === 0 && !closed) {
          entry.fetching = missing.length;
          repo.putHeld({
            bucket: bucket.name,
            storePath: entry.info.storePath,
            missing,
            fetching: entry.fetching,
            fetched: entry.fetched,
            failure: null,
            created: now(),
          });
          enqueueFetch(bucket, dirForBucket, entry, missing);
          changed();
        }
        return { missing, fetching: entry.fetching };
      }
      repo.putHeld({
        bucket: bucket.name,
        storePath: entry.info.storePath,
        missing,
        fetching: 0,
        fetched: entry.fetched,
        failure: null,
        created: now(),
      });
      return { missing, fetching: 0 };
    }
    if (!outcome.ok) {
      if (outcome.missing.length > 0) {
        repo.putHeld({
          bucket: bucket.name,
          storePath: entry.info.storePath,
          missing: outcome.missing,
          fetching: 0,
          fetched: entry.fetched,
          failure: null,
          created: now(),
        });
        return { missing: outcome.missing, fetching: 0 };
      }
      repo.deleteHeld(bucket.name, entry.info.storePath);
      return { failed: outcome.message };
    }
    await record(bucket, entry.info.storePath, entry.info.narHash, entry.info.sigs);
    repo.deleteHeld(bucket.name, entry.info.storePath);
    changed();
    return "recorded";
  }

  /** ONE fetch at a time per bucket, and it is the ROW's work: the queue owns
   *  the import that follows, so an upload request returns immediately. */
  function enqueueFetch(
    bucket: BucketRow,
    dirForBucket: string,
    entry: Pending,
    missing: readonly string[],
  ): void {
    let chain = fetches.get(bucket.name);
    if (chain === undefined) {
      chain = newChain();
      fetches.set(bucket.name, chain);
    }
    void serial(chain, () => fetchNow(bucket, dirForBucket, entry, missing));
  }

  async function fetchNow(
    bucket: BucketRow,
    dirForBucket: string,
    entry: Pending,
    missing: readonly string[],
  ): Promise<void> {
    try {
      if (closed) return;
      const fetched = await deps.slots.withSlot(() =>
        blob.substitute(missing, upstreamFor(bucket.upstreamKeys)),
      );
      if (closed) return;
      if (!fetched.ok) {
        entry.fetching = 0;
        entry.failure = fetched.message;
        repo.putHeld({
          bucket: bucket.name,
          storePath: entry.info.storePath,
          missing: entry.waitingOn,
          fetching: 0,
          fetched: entry.fetched,
          failure: fetched.message,
          created: now(),
        });
        return;
      }
      entry.failure = null;
      const still = await missingOf(entry);
      entry.fetched = [...new Set([...entry.fetched, ...landed(entry, still)])];
      const outcome = await blob.import({
        dir: dirForBucket,
        storePath: entry.info.storePath,
      });
      if (closed) return;
      if (outcome.ok) {
        await record(bucket, entry.info.storePath, entry.info.narHash, entry.info.sigs);
        repo.deleteHeld(bucket.name, entry.info.storePath);
        pending.get(bucket.name)?.delete(entry.hash);
        await unlink(join(dirForBucket, "nar", basename(entry.info.url))).catch(() => {});
        await unlink(join(dirForBucket, `${entry.hash}.narinfo`)).catch(() => {});
      } else if (still.length > 0) {
        entry.fetching = 0;
        entry.waitingOn = still;
        repo.putHeld({
          bucket: bucket.name,
          storePath: entry.info.storePath,
          missing: still,
          fetching: 0,
          fetched: entry.fetched,
          failure: null,
          created: now(),
        });
      } else {
        // A REFUSAL is the client's bytes; drop the entry so it is not retried
        // for ever, the way a drain does.
        repo.deleteHeld(bucket.name, entry.info.storePath);
        pending.get(bucket.name)?.delete(entry.hash);
        await unlink(join(dirForBucket, `${entry.hash}.narinfo`)).catch(() => {});
      }
    } catch (err) {
      // A THROWN FETCH IS NOT "FETCHING" FOR EVER: the row goes back to its
      // waiting sentence, so the next boot (or push) can try again.
      if (!closed) {
        repo.putHeld({
          bucket: bucket.name,
          storePath: entry.info.storePath,
          missing: entry.waitingOn,
          fetching: 0,
          fetched: entry.fetched,
          failure: String((err as Error).message ?? err),
          created: now(),
        });
      }
    } finally {
      entry.fetching = 0;
      changed();
    }
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
          // A PART OF AN UPLOAD STILL IN PROGRESS IS NOT LITTER. Its session
          // marker is touched on every part; an hour-old marker means nobody is
          // finishing it.
          const partAt = entry.lastIndexOf(".part-");
          if (partAt > 0) {
            const marker = await stat(
              join(at, `${entry.slice(0, partAt)}.uploading`),
            ).catch(() => null);
            if (marker !== null && marker.mtimeMs >= cutoff) continue;
          }
          await rm(path, { force: true }).catch(() => {});
          // A swept narinfo is not pending any more; leaving it in the map
          // grows it by one per abandoned upload for the life of the process.
          if (entry.endsWith(".narinfo")) {
            const hash = entry.slice(0, -".narinfo".length);
            const held = pending.get(bucket)?.get(hash);
            if (held !== undefined) repo.deleteHeld(bucket, held.info.storePath);
            pending.get(bucket)?.delete(hash);
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
   * `Bun.file(part).writer()` 299–316 MiB (this). The shim leaves each chunk
   * to the collector, so the peak is whatever was not reclaimed; the sink owns
   * the buffer, so the number stops depending on the collector's mood.
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
  async function completeNow(
    bucket: BucketRow,
    file: string,
    total: number,
  ): Promise<CompleteUpload> {
    const dirForBucket = stagedDir(bucket.name);
      const partPath = (index: number): string =>
        join(dirForBucket, "nar", `${file}.part-${index}`);
      const missing: number[] = [];
      for (let index = 0; index < total; index++) {
        const info = await stat(partPath(index)).catch(() => null);
        if (info === null || !info.isFile()) missing.push(index);
      }
      if (missing.length > 0) {
        // A SECOND COMPLETE for a file the first already joined is the state
        // the caller wanted: the parts are gone because the NAR exists.
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
      // The session marker goes with the parts: the upload is no longer open,
      // and a later sweep must not keep its leftovers.
      await unlink(uploadMarker(dirForBucket, file)).catch(() => {});
      return { ok: true, parts: total };
  }

  return {
    async resume() {
      // AT ROW APPLY. Every held row is this database's, so a process that
      // restarted picks each one up with the full missing set its row names —
      // no request is needed to start a fetch that was already owed.
      const rows = repo.held();
      const byBucket = new Map<string, HeldRow[]>();
      for (const row of rows) {
        const list = byBucket.get(row.bucket) ?? [];
        list.push(row);
        byBucket.set(row.bucket, list);
      }
      for (const [name, held] of byBucket) {
        const bucket = repo.bucket(name);
        if (bucket === null) continue;
        const map = await ensurePending(bucket);
        const byPath = new Map([...map.values()].map((entry) => [entry.info.storePath, entry]));
        for (const row of held) {
          const entry = byPath.get(row.storePath);
          // The narinfo is what makes the referrer importable after the
          // references land; without it the row stays a fact, not a job.
          if (entry === undefined) continue;
          // THE FULL SET, even if the row was written by a build that knew
          // only what stderr said: the recovery is the moment to widen it.
          const missing = await missingOf(entry, row.missing);
          entry.waitingOn = missing;
          entry.fetched = row.fetched;
          entry.fetching = missing.length;
          entry.failure = null;
          repo.putHeld({ ...row, missing, fetching: missing.length, failure: null });
          enqueueFetch(bucket, stagedDir(name), entry, missing);
        }
      }
    },
    async close() {
      closed = true;
      // JOIN every queue this staging owns. The closed flag stops the next
      // step; awaiting the tails is what makes "nothing is running" true rather
      // than merely believed.
      await Promise.all([...fetches.values()].map((chain) => chain.tail));
    },
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
      await touchUpload(dirForBucket, file);
      return openAt(join(dirForBucket, "nar", file), null);
    },

    async beginPart(bucket, file, index, limit) {
      if (!isStagedFileName(file)) {
        throw new Error(`"${file}" is not a NAR file name`);
      }
      if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_PARTS) {
        throw new Error(`"${index}" is not a part index`);
      }
      const dirForBucket = stagedDir(bucket.name);
      await mkdir(join(dirForBucket, "nar"), { recursive: true, mode: 0o700 });
      await touchUpload(dirForBucket, file);
      return openAt(join(dirForBucket, "nar", `${file}.part-${index}`), limit);
    },

    async completeUpload(bucket, file, total) {
      if (!isStagedFileName(file)) {
        throw new Error(`"${file}" is not a NAR file name`);
      }
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
      const entry: Pending = {
        hash,
        info: staged.info,
        waitingOn: [],
        proved: true,
        fetching: 0,
        fetched: [],
        failure: null,
      };
      map.set(hash, entry);
      await queuedDrain(bucket, [info.storePath]);

      if (repo.object(bucket.name, info.storePath) !== null) {
        return { ok: true, status: 200, storePath: info.storePath };
      }
      const still = map.get(hash);
      if (still !== undefined && still.waitingOn.length > 0) {
        return {
          ok: true,
          status: 202,
          storePath: info.storePath,
          missing: still.waitingOn,
          fetching: still.fetching,
        };
      }
      return {
        ok: false,
        status: 400,
        message: `${info.storePath} could not be imported: the upload was refused`,
      };
    },
  };
}
