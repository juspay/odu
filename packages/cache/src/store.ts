/**
 * THE BLOB STORE — the Nix store itself, behind a port.
 *
 * A bucket holds METADATA. The bytes are the machine's own `/nix/store`, which
 * is the whole design (PLAN.md, "Storage"): dedup across buckets is free
 * because a store path is a store path, a push from the machine that built the
 * paths moves nothing, and a read is a `dump-path` piped through zstd rather
 * than a second copy of somebody's build. S3 is the second implementation of
 * this port (PR 11), which is why it IS a port.
 *
 * **Nix comes from PATH, deliberately.** The repo does not pin it (see
 * `default.nix` near "deliberately NOT pinned"): the host that provides the
 * daemon provides the client, because a pinned client older than the daemon
 * corrupts content-addressed handling. The COMPRESSORS are pinned, on odu's
 * wrapper PATH and in the devShell, because compressing and decompressing a NAR
 * is odu's own work — `zstd` for what odu serves, `xz` and `bzip2` for what a
 * Nix client uploads (`nix copy --to` still defaults to xz).
 *
 * **`store` is one URI and every call carries it.** `null` means the daemon —
 * the production shape. `local?root=<tmp>` is the e2e shape: no trusted-user
 * setup on a CI host, and nothing the suite pushes lands in the host's store.
 *
 * **A NAR is never held in memory.** `dump` is a two-process pipeline
 * (`nix store dump-path | zstd -T0 -c`) whose stdout is handed out as a
 * ReadableStream; the routes stream that to the socket. The only way this
 * package could hold a multi-gigabyte NAR is by reading the stream, and
 * nothing does — except {@link verifyNarFile}, which HASHES an upload as it
 * decompresses it and never keeps more than one chunk.
 *
 * **A stream that ended cleanly is not a stream that succeeded.** `nix store
 * dump-path` failing halfway closes zstd's stdin, and zstd then writes a
 * perfectly valid frame of a truncated NAR. So `dump` holds the stream open
 * until BOTH children have exited and fails the read unless both exited 0 —
 * otherwise a broken read is a 200 with a hash mismatch at the far end.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { base32, canonicalNarHash, NarinfoError, storePathHash } from "./narinfo";

/** What the store knows about one path. `narHash` is canonical
 *  (`sha256:<base32>`), references are FULL store paths, and `sigs` are the
 *  signatures already attached to the path — the client's own, kept. */
export interface PathInfo {
  storePath: string;
  narHash: string;
  narSize: number;
  references: readonly string[];
  deriver: string | null;
  sigs: readonly string[];
}

/** A staged upload: a `file://` binary cache on disk holding exactly what the
 *  client sent — `nar/<file>` and `<hash>.narinfo`. */
export interface StagedImport {
  dir: string;
  storePath: string;
}

export type ImportOutcome =
  | { ok: true }
  /** `missing` is the one interesting arm: a REFERENCE of this path is not
   *  valid yet, which happens whenever a client uploads a closure out of order.
   *  The upload is not wrong, it is early, so the caller keeps it staged and
   *  tries again when that reference lands. Anything else is the client's
   *  error. */
  | { ok: false; missing: readonly string[]; message: string };

export type DeleteOutcome = "deleted" | "kept";

/** A fetch's answer: either it landed, or the last line `nix-store -r` said. */
export type SubstituteOutcome = { ok: true } | { ok: false; message: string };

/**
 * AN UPSTREAM CACHE the server may fetch a reference from — the URL, and the
 * full public key whose signatures make a path from it trustworthy.
 *
 * A BUCKET STORES KEY NAMES (`cache.nixos.org-1`), which is what a pusher's
 * signatures carry, so this table is how a name becomes a substituter and a key
 * Nix can verify with. A name with no entry has no known URL and therefore
 * fetches nothing: the path stays held, and the reason says so.
 */
export interface UpstreamCache {
  readonly keyName: string;
  readonly url: string;
  readonly publicKey: string;
}

/** The upstream caches odu knows. One today; the shape is a table because the
 *  name is the bucket's and the URL is the world's. */
export const UPSTREAM_CACHES: readonly UpstreamCache[] = [
  {
    keyName: "cache.nixos.org-1",
    url: "https://cache.nixos.org",
    publicKey: "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=",
  },
];

/** The upstreams a bucket's key NAMES select, in the bucket's order. */
export function upstreamFor(keyNames: readonly string[]): UpstreamCache[] {
  const wanted = new Set(keyNames);
  return UPSTREAM_CACHES.filter((cache) => wanted.has(cache.keyName));
}

export interface BlobStore {
  has(storePath: string): Promise<boolean>;
  pathInfo(storePath: string): Promise<PathInfo | null>;
  /** One `nix path-info -r --json` for the whole set — a pin's closure and a
   *  push's closure are the same question and one process answers both. */
  closure(paths: readonly string[]): Promise<PathInfo[]>;
  import(staged: StagedImport): Promise<ImportOutcome>;
  /**
   * FETCH UPSTREAM-SIGNED PATHS INTO THIS STORE, before a referrer is imported.
   *
   * `nix copy --from <staged>` refuses a path whose references are not valid,
   * and a bucket that skips upstream paths never receives its referrers'
   * upstream references — the 202 contradiction this exists to end. So the
   * server asks each upstream cache for them with `nix-store -r`, trusting
   * ONLY the bucket's own upstream keys: a path signed by anything else is not
   * fetched, and the referrer stays held for a reference that is genuinely
   * neither here nor upstream.
   *
   * A FAILURE IS NOT AN ERROR: the next import attempt reports exactly which
   * references are still missing, and that is the sentence a pusher reads.
   */
  substitute(
    paths: readonly string[],
    upstreams: readonly UpstreamCache[],
  ): Promise<SubstituteOutcome>;
  /** WHICH OF THESE THE STORE ALREADY HAS, in ONE `nix path-info` — the
   *  question `missingOf` asks of every reference. */
  presentOf(paths: readonly string[]): Promise<ReadonlySet<string>>;
  /** A zstd-compressed NAR, streamed. */
  dump(storePath: string): ReadableStream<Uint8Array>;
  retain(bucket: string, storePath: string): Promise<void>;
  release(bucket: string, storePath: string): Promise<void>;
  /** One path, for a caller that means exactly one. */
  delete(storePath: string): Promise<DeleteOutcome>;
  /**
   * A SET, in one call. Deleting one path at a time reports "still alive" for
   * any path another member of the set references, so a closure collected
   * path-by-path leaks everything in the middle of it.
   */
  deleteMany(storePaths: readonly string[]): Promise<{ deleted: string[]; kept: string[] }>;
}

export interface NixStoreOptions {
  /** Where one gcroot per retained path per bucket lives — under the cache's
   *  own state directory, never inside the store. */
  gcrootsRoot: string;
  /** `--store <uri>` on every call; `null` is the daemon. */
  store: string | null;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** One `nix`/`nix-store` invocation, collected. Used for everything that is not
 *  a byte stream: a path-info read, an import, a root, a delete. */
/**
 * A child whose OUTPUT IS A TAIL, not a buffer. `nix-store -r --keep-going`
 * prints a line per path, and S1 needs only the last one; keeping the whole
 * stdout/stderr of a large closure is memory nobody reads.
 *
 * STDOUT IS DISCARDED ON PURPOSE: `nix-store -r` narrates on stderr, which is
 * where the failure line comes from. A caller that needs stdout wants `run`.
 */
function runTail(command: string, args: readonly string[]): Promise<{ code: number | null; message: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; message: string }>();
  const child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"] });
  let tail: string[] = [];
  let partial = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    partial += chunk.toString("utf8");
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    tail = [...tail, ...lines.map((line) => line.trim())].filter((line) => line !== "").slice(-20);
  });
  child.on("error", (err) => resolve({ code: null, message: String(err) }));
  child.on("close", (code) => {
    const last = [...tail, partial.trim()].filter((line) => line !== "").at(-1);
    resolve({ code, message: last ?? `nix-store exited ${String(code)}` });
  });
  return promise;
}

function run(command: string, args: readonly string[]): Promise<Run> {
  const { promise, resolve } = Promise.withResolvers<Run>();
  const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.on("error", (err) => resolve({ code: null, stdout, stderr: `${stderr}${String(err)}` }));
  child.on("close", (code) => resolve({ code, stdout, stderr }));
  return promise;
}

/** The store URI as argv. */
const storeArgsOf = (store: string | null): string[] =>
  store === null ? [] : ["--store", store];

/**
 * `nix path-info --json` in the shape that has no deprecation warning, with a
 * fallback for a Nix old enough not to know `--json-format`. The warning goes
 * to stderr and would otherwise appear on every push.
 */
async function pathInfoArgs(
  base: readonly string[],
  store: string | null,
  paths: readonly string[],
): Promise<{ ok: true; stdout: string } | { ok: false; message: string }> {
  const formatted = await run("nix", [...base, "--json", "--json-format", "1", ...storeArgsOf(store), ...paths]);
  if (formatted.code === 0) return { ok: true, stdout: formatted.stdout };
  if (!/unrecognised flag|unrecognized option|unknown flag/i.test(formatted.stderr)) {
    return { ok: false, message: formatted.stderr.trim() || `nix exited ${String(formatted.code)}` };
  }
  const plain = await run("nix", [...base, "--json", ...storeArgsOf(store), ...paths]);
  return plain.code === 0
    ? { ok: true, stdout: plain.stdout }
    : { ok: false, message: plain.stderr.trim() || `nix exited ${String(plain.code)}` };
}

/**
 * THE parser. `nix path-info --json` has answered in three shapes across its
 * life — an object keyed by store path (format 1), the same object under
 * `info` (format 2), and a bare ARRAY of records keyed by their own `path`
 * (every Nix before `--json-format` existed, which is what the fallback above
 * reaches). One parser, exported, so the push client and the store cannot
 * disagree about what Nix said.
 */
export function parsePathInfoTable(stdout: string): Map<string, PathInfo> {
  const out = new Map<string, PathInfo>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return out;
  }
  const records = (value: unknown): Map<string, Record<string, unknown>> => {
    const table = new Map<string, Record<string, unknown>>();
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry === null || typeof entry !== "object" || !("path" in entry)) continue;
        const path = entry.path;
        if (typeof path === "string") table.set(path, entry as Record<string, unknown>);
      }
      return table;
    }
    if (value === null || typeof value !== "object") return table;
    const outer = value as Record<string, unknown>;
    const inner = outer["info"] ?? outer;
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return table;
    for (const [path, entry] of Object.entries(inner as Record<string, unknown>)) {
      // A `null` entry is a store saying "I do not have this", which is not a
      // record and must not become one.
      if (entry !== null && typeof entry === "object") table.set(path, entry as Record<string, unknown>);
    }
    return table;
  };
  for (const [storePath, entry] of records(parsed)) {
    try {
      out.set(storePath, {
        storePath,
        narHash: canonicalNarHash(String(entry["narHash"])),
        narSize: Number(entry["narSize"]),
        references: (entry["references"] as string[] | undefined) ?? [],
        deriver: (entry["deriver"] as string | null | undefined) ?? null,
        sigs: (entry["signatures"] as string[] | undefined) ?? [],
      });
    } catch (err) {
      if (!(err instanceof NarinfoError)) throw err;
    }
  }
  return out;
}

/**
 * The closure of `paths`, in ONE process. Shared by the store (a pin resolves
 * its closure with it) and by the push client (it needs the whole closure
 * before it can ask what is missing) — the same JSON, the same parser, one
 * implementation.
 */
export async function nixClosure(paths: readonly string[], store: string | null): Promise<PathInfo[]> {
  const answer = await pathInfoArgs(["path-info", "-r"], store, paths);
  // A FAILURE IS NOT AN EMPTY CLOSURE. A caller that got `[]` would report "no
  // such path in the store" for a store it could not read at all.
  if (!answer.ok) throw new Error(`nix path-info -r failed: ${answer.message}`);
  return [...parsePathInfoTable(answer.stdout).values()];
}

export function nixStore(options: NixStoreOptions): BlobStore {
  const storeArgs = storeArgsOf(options.store);

  async function pathInfoTable(paths: readonly string[]): Promise<Map<string, PathInfo>> {
    const answer = await pathInfoArgs(["path-info"], options.store, paths);
    // "the store does not have it" and "the store could not be asked" are the
    // same answer here — a path this cache cannot vouch for is not valid.
    return answer.ok ? parsePathInfoTable(answer.stdout) : new Map();
  }

  function rootPath(bucket: string, storePath: string): string {
    return join(options.gcrootsRoot, bucket, storePathHash(storePath));
  }

  async function deleteMany(
    storePaths: readonly string[],
  ): Promise<{ deleted: string[]; kept: string[] }> {
    if (storePaths.length === 0) return { deleted: [], kept: [] };
    const result = await run("nix-store", ["--delete", ...storeArgs, ...storePaths]);
    // "still alive" is another root's answer, not a failure: something else on
    // this machine is holding the path and odu has no business forcing it.
    if (result.code !== 0 && !/is still alive/.test(result.stderr)) {
      throw new Error(`nix-store --delete failed: ${result.stderr.trim()}`);
    }
    // ONE read of what survived, rather than a process per path.
    const survivors = await pathInfoTable(storePaths);
    return {
      deleted: storePaths.filter((path) => !survivors.has(path)),
      kept: storePaths.filter((path) => survivors.has(path)),
    };
  }

  return {
    async has(storePath) {
      return (await pathInfoTable([storePath])).has(storePath);
    },

    async pathInfo(storePath) {
      return (await pathInfoTable([storePath])).get(storePath) ?? null;
    },

    async closure(paths) {
      return nixClosure(paths, options.store);
    },

    async import(staged) {
      const result = await run("nix", [
        "copy",
        "--from",
        pathToFileURL(staged.dir).href,
        "--no-check-sigs",
        "--no-recursive",
        ...storeArgs,
        staged.storePath,
      ]);
      if (result.code === 0) return { ok: true };
      const message = (result.stderr || result.stdout).trim().split("\n").slice(-1)[0] ?? "";
      // Nix names the reference it could not find: "path '/nix/store/…' is not
      // valid". Naming it back is what lets the caller retry this upload when
      // exactly that path lands, instead of rescanning the whole staging dir.
      const missing = [...result.stderr.matchAll(/path '([^']+)' is not valid/g)].map(
        (match) => match[1] as string,
      );
      return { ok: false, missing, message };
    },

    dump(storePath) {
      return nixDump(storePath, options.store);
    },

    async presentOf(paths) {
      // ONE process for the whole set: a hold can name seven references, and a
      // `nix path-info` each made eight spawns per attempt and per resume.
      if (paths.length === 0) return new Set();
      return new Set((await pathInfoTable(paths)).keys());
    },

    async substitute(paths, upstreams) {
      if (paths.length === 0 || upstreams.length === 0) return { ok: true };
      // `nix-store -r` fetches the requested paths AND their closures, and it
      // verifies every one against the keys given here — odu's key list, not
      // the host's nix.conf. A path the upstream cannot serve, or serves under
      // a key the bucket does not trust, simply stays absent; the caller's
      // import attempt says so.
      const result = await runTail("nix-store", [
        "-r",
        // ONE reference that will not come does not stop the others: a
        // sibling that IS upstream must still land, or the referrer stays
        // held for a path the server could have fetched.
        "--keep-going",
        ...storeArgs,
        "--option",
        "substituters",
        upstreams.map((cache) => cache.url).join(" "),
        "--option",
        "trusted-public-keys",
        upstreams.map((cache) => cache.publicKey).join(" "),
        // A negative narinfo answer cached by an earlier attempt must not make
        // a path that has since been published invisible for a TTL.
        "--option",
        "narinfo-cache-negative-ttl",
        "0",
        ...paths,
      ]);
      // THE EXIT CODE IS THE FACT: a network error, a full disk or a store
      // lock must read as a failed fetch, not as "neither here nor upstream".
      return result.code === 0 ? { ok: true } : { ok: false, message: result.message };
    },

    async retain(bucket, storePath) {
      const root = rootPath(bucket, storePath);
      await mkdir(dirname(root), { recursive: true, mode: 0o700 });
      const result = await run("nix-store", [
        "--add-root",
        root,
        "--indirect",
        "-r",
        ...storeArgs,
        storePath,
      ]);
      if (result.code !== 0) {
        throw new Error(`nix-store --add-root failed: ${result.stderr.trim()}`);
      }
    },

    async release(bucket, storePath) {
      // Unlinking the symlink is the whole release: an indirect root's
      // registration goes with the link, which is why it is the unprivileged
      // form.
      await unlink(rootPath(bucket, storePath)).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
    },

    async delete(storePath) {
      const { deleted } = await deleteMany([storePath]);
      return deleted.length > 0 ? "deleted" : "kept";
    },

    deleteMany,
  };
}

/**
 * A NAR as a zstd stream: `nix store dump-path <path> | zstd -T0 -c`.
 *
 * One implementation for the server's reads and the push client's uploads —
 * they are the same bytes through the same two programs, and a second spelling
 * would be a second place for the pipeline to be got wrong.
 *
 * The stream does not END until both children have exited, and it ERRORS unless
 * both exited 0. Closing on zstd's EOF alone would hand a consumer a valid
 * frame of a truncated NAR — the failure mode that turns a broken read into a
 * silent 200.
 */
export function nixDump(storePath: string, store: string | null): ReadableStream<Uint8Array> {
  const nix = spawn("nix", ["store", "dump-path", ...storeArgsOf(store), storePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const zstd = spawn("zstd", ["-T0", "-c"], { stdio: ["pipe", "pipe", "pipe"] });

  let nixCode: number | null = null;
  let zstdCode: number | null = null;
  let sourceEnded = false;
  let fault: string | null = null;
  let sink: ReadableStreamDefaultController<Uint8Array> | null = null;

  const settle = (): void => {
    if (sink === null || !sourceEnded || nixCode === null || zstdCode === null) return;
    const controller = sink;
    sink = null;
    if (fault !== null) controller.error(new Error(fault));
    else if (nixCode !== 0) controller.error(new Error(`nix store dump-path exited ${nixCode}`));
    else if (zstdCode !== 0) controller.error(new Error(`zstd exited ${zstdCode}`));
    else controller.close();
  };

  const fail = (message: string): void => {
    fault ??= message;
    // A child that could not even be spawned never emits `close`, and a child
    // that died produces no more bytes — so nothing else is coming, and the
    // stream settles here rather than waiting for an `end` that never arrives.
    nixCode ??= -1;
    zstdCode ??= -1;
    sourceEnded = true;
    settle();
  };

  nix.on("error", (err) => fail(`nix: ${String(err)}`));
  zstd.on("error", (err) => fail(`zstd: ${String(err)}`));
  // EPIPE is the ordinary consequence of a consumer that walked away, and the
  // cancel path below is what stops the work; it must not become an unhandled
  // event that takes the process down.
  zstd.stdin?.on("error", () => {});
  nix.stdout?.on("error", (err) => fail(`nix stdout: ${String(err)}`));
  nix.stdout?.pipe(zstd.stdin);
  nix.stderr?.resume();
  zstd.stderr?.resume();

  nix.on("close", (code) => {
    nixCode = code ?? -1;
    if (zstd.stdin !== null && !zstd.stdin.destroyed) zstd.stdin.end();
    settle();
  });
  zstd.on("close", (code) => {
    zstdCode = code ?? -1;
    nix.kill("SIGKILL");
    settle();
  });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
      zstd.stdout?.on("data", (chunk: Buffer) => {
        if (sink === null) return;
        controller.enqueue(new Uint8Array(chunk));
        // Backpressure: one chunk in flight is enough, and a paused source is
        // what keeps a 2 GiB NAR off the heap.
        if ((controller.desiredSize ?? 0) <= 0) zstd.stdout?.pause();
      });
      zstd.stdout?.on("end", () => {
        sourceEnded = true;
        settle();
      });
    },
    pull() {
      zstd.stdout?.resume();
    },
    cancel() {
      sink = null;
      nix.kill("SIGKILL");
      zstd.kill("SIGKILL");
    },
  });
}

/**
 * What a staged upload's bytes came to, or why they could not be read.
 *
 * `absent` is not a flavour of "wrong": a file that is not there has not been
 * judged, and the caller may have another way to prove the same bytes. A file
 * that IS there and hashes to something else has been judged, and is the
 * client's error.
 */
export type NarCheck =
  | { ok: true; narHash: string; narSize: number }
  | { ok: false; absent: boolean; message: string };

/** The decompressor for a narinfo's `Compression`. `none` and an absent field
 *  both mean the NAR is stored raw; anything else is a format odu cannot read
 *  and therefore cannot vouch for. */
function decompressorOf(compression: string | null): string[] | null | { error: string } {
  switch (compression ?? "none") {
    case "none":
      return null;
    case "zstd":
      return ["zstd", "-dc"];
    case "xz":
      return ["xz", "-dc"];
    case "bzip2":
      return ["bzip2", "-dc"];
    default:
      return { error: `unsupported Compression: ${compression}` };
  }
}

/**
 * Hash an uploaded NAR the way Nix would: decompress it and sha256 the result.
 *
 * **This is the check the private-bucket story rests on.** `nix copy --from
 * file://<staged>` verifies the NarHash — but only when the path is NOT
 * already valid in the destination store, where it copies zero paths, opens
 * nothing and exits 0. A holder of a write token for any bucket could then
 * publish any path the server's store happens to hold, with a narinfo alone and
 * no bytes at all. So the bytes are hashed here, against the narinfo, BEFORE
 * the import is attempted; an upload with no NAR, a truncated NAR or a NAR
 * under another name is refused here rather than believed by Nix.
 *
 * Streamed: one chunk at a time, never the whole NAR.
 */
export async function verifyNarFile(path: string, compression: string | null): Promise<NarCheck> {
  const decompressor = decompressorOf(compression);
  if (decompressor !== null && !Array.isArray(decompressor)) {
    return { ok: false, absent: false, message: decompressor.error };
  }

  const { promise, resolve } = Promise.withResolvers<NarCheck>();
  const hash = createHash("sha256");
  let size = 0;
  let ended = false;
  let code: number | null = decompressor === null ? 0 : null;
  let settled = false;

  const settle = (): void => {
    if (settled || !ended || code === null) return;
    settled = true;
    resolve(
      code === 0
        ? { ok: true, narHash: `sha256:${base32(hash.digest())}`, narSize: size }
        : { ok: false, absent: false, message: `${decompressor?.[0] ?? "the NAR"} exited ${code}` },
    );
  };

  let source: Readable;
  if (decompressor === null) {
    source = createReadStream(path);
  } else {
    const child = spawn(decompressor[0] as string, decompressor.slice(1), {
      // The FILE goes in on stdin: a decompressor spawned with stdin closed
      // reads nothing and exits non-zero, which would refuse every upload.
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr?.resume();
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, absent: false, message: `${decompressor[0]}: ${String(err)}` });
    });
    child.on("close", (exit) => {
      code = exit ?? -1;
      settle();
    });
    if (child.stdout === null) {
      return { ok: false, absent: false, message: `${decompressor[0]} produced no output` };
    }
    // EPIPE once the child has had enough is the ordinary end of a pipe.
    child.stdin?.on("error", () => {});
    const file = createReadStream(path);
    file.on("error", (err) => {
      if (settled) return;
      settled = true;
      // The file going away between a `stat` and this open is the ordinary
      // consequence of a concurrent drain; it is absence, not bad bytes.
      const code = (err as NodeJS.ErrnoException).code;
      resolve({
        ok: false,
        absent: code === "ENOENT",
        message: String(err),
      });
    });
    file.pipe(child.stdin as NodeJS.WritableStream);
    source = child.stdout;
  }

  source.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    size += chunk.length;
  });
  source.on("error", (err) => {
    if (settled) return;
    settled = true;
    const code = (err as NodeJS.ErrnoException).code;
    resolve({ ok: false, absent: code === "ENOENT", message: String(err) });
  });
  source.on("end", () => {
    ended = true;
    settle();
  });
  return promise;
}

/** Copy a streamed body to a file, streaming. Used by the routes for an upload
 *  and by nothing else — a NAR is written to disk exactly as it arrives. */
export async function writeStreamToFile(
  body: ReadableStream<Uint8Array>,
  path: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await pipeline(Readable.fromWeb(body as never), createWriteStream(path));
}
