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
 * corrupts content-addressed handling. `zstd` IS pinned, on odu's wrapper PATH
 * and in the devShell, because compressing a NAR is odu's own work rather than
 * the host's.
 *
 * **`store` is one URI and every call carries it.** `null` means the daemon —
 * the production shape. `local?root=<tmp>` is the e2e shape: no trusted-user
 * setup on a CI host, and nothing the suite pushes lands in the host's store.
 *
 * **A NAR is never held in memory.** `dump` is a two-process pipeline
 * (`nix store dump-path | zstd -T0 -c`) whose stdout is handed out as a
 * ReadableStream; the routes stream that to the socket. The only way this
 * package could hold a multi-gigabyte NAR is by reading the stream, and
 * nothing does.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { canonicalNarHash, NarinfoError, storePathHash } from "./narinfo";

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
  /** `defer` is the one interesting arm: the path's REFERENCES are not valid
   *  yet, which happens whenever a client uploads a closure out of order. The
   *  upload is not wrong, it is early, so the caller keeps it staged and tries
   *  again after the next narinfo lands. Anything else is the client's error. */
  | { ok: false; defer: boolean; message: string };

export type DeleteOutcome = "deleted" | "kept";

export interface BlobStore {
  has(storePath: string): Promise<boolean>;
  pathInfo(storePath: string): Promise<PathInfo | null>;
  import(staged: StagedImport): Promise<ImportOutcome>;
  /** A zstd-compressed NAR, streamed. */
  dump(storePath: string): ReadableStream<Uint8Array>;
  retain(bucket: string, storePath: string): Promise<void>;
  release(bucket: string, storePath: string): Promise<void>;
  delete(storePath: string): Promise<DeleteOutcome>;
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

export function nixStore(options: NixStoreOptions): BlobStore {
  const storeArgs = options.store === null ? [] : ["--store", options.store];

  /**
   * `nix path-info --json` in the shape that has no deprecation warning, with a
   * fallback for a Nix old enough not to know `--json-format`. The warning goes
   * to stderr and would otherwise appear on every push.
   */
  async function pathInfoJson(storePath: string): Promise<Record<string, unknown> | null> {
    const formatted = await run("nix", [
      "path-info",
      "--json",
      "--json-format",
      "1",
      ...storeArgs,
      storePath,
    ]);
    if (formatted.code !== 0) {
      // A path the store does not have is `null`; a Nix too old for the flag is
      // retried once without it. Both are one answer from this function.
      if (!/unrecognised flag|unrecognized option|unknown flag/i.test(formatted.stderr)) {
        return null;
      }
      const plain = await run("nix", ["path-info", "--json", ...storeArgs, storePath]);
      if (plain.code !== 0) return null;
      return parsePathInfo(plain.stdout, storePath);
    }
    return parsePathInfo(formatted.stdout, storePath);
  }

  async function pathInfo(storePath: string): Promise<PathInfo | null> {
    const raw = await pathInfoJson(storePath);
    if (raw === null) return null;
    try {
      return {
        storePath,
        narHash: canonicalNarHash(String(raw["narHash"])),
        narSize: Number(raw["narSize"]),
        references: (raw["references"] as string[] | undefined) ?? [],
        deriver: (raw["deriver"] as string | null | undefined) ?? null,
        sigs: (raw["signatures"] as string[] | undefined) ?? [],
      };
    } catch (err) {
      if (err instanceof NarinfoError) return null;
      throw err;
    }
  }

  function rootPath(bucket: string, storePath: string): string {
    return join(options.gcrootsRoot, bucket, storePathHash(storePath));
  }

  return {
    async has(storePath) {
      return (await pathInfoJson(storePath)) !== null;
    },

    pathInfo,

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
      // "is not valid" is Nix saying a REFERENCE is missing, which is an
      // ordering fact rather than a bad upload.
      const message = (result.stderr || result.stdout).trim().split("\n").slice(-1)[0] ?? "";
      return { ok: false, defer: /is not valid/.test(result.stderr), message };
    },

    dump(storePath) {
      return nixDump(storePath, options.store);
    },

    async retain(bucket, storePath) {
      const root = rootPath(bucket, storePath);
      await mkdir(dirname(root), { recursive: true });
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
      const result = await run("nix-store", ["--delete", ...storeArgs, storePath]);
      // "still alive" is another root's answer, not a failure: something else
      // on this machine is holding the path and odu has no business forcing it.
      if (/is still alive/.test(result.stderr)) return "kept";
      if (result.code !== 0) {
        throw new Error(`nix-store --delete failed: ${result.stderr.trim()}`);
      }
      return "deleted";
    },
  };
}

/** `nix path-info --json` answers an object keyed by store path (format 1) or,
 *  in the shape older Nixes produce, the same object under `info`. Both are
 *  read; a `null` entry means "this store does not have it". */
function parsePathInfo(stdout: string, storePath: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const outer = parsed as Record<string, unknown>;
  const table = (outer["info"] ?? outer) as Record<string, unknown>;
  const entry = table[storePath];
  return entry === null || typeof entry !== "object" ? null : (entry as Record<string, unknown>);
}

/**
 * A NAR as a zstd stream: `nix store dump-path <path> | zstd -T0 -c`.
 *
 * One implementation for the server's reads and the push client's uploads —
 * they are the same bytes through the same two programs, and a second spelling
 * would be a second place for the pipeline to be got wrong.
 */
export function nixDump(storePath: string, store: string | null): ReadableStream<Uint8Array> {
  const storeArgs = store === null ? [] : ["--store", store];
  const nix = spawn("nix", ["store", "dump-path", ...storeArgs, storePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const zstd = spawn("zstd", ["-T0", "-c"], { stdio: ["pipe", "pipe", "pipe"] });
  // A broken consumer closes zstd's stdout, and the SIGPIPE walks back up the
  // pipeline; the `nix` child is killed explicitly so a cancelled download does
  // not leave a dump-path writing into a dead pipe.
  nix.stdout?.pipe(zstd.stdin);
  nix.on("close", () => {
    if (zstd.stdin !== null && !zstd.stdin.destroyed) zstd.stdin.end();
  });
  zstd.on("close", () => nix.kill("SIGKILL"));
  nix.stderr?.resume();
  zstd.stderr?.resume();
  return Readable.toWeb(zstd.stdout as Readable) as unknown as ReadableStream<Uint8Array>;
}

/** Copy a streamed body to a file, streaming. Used by the routes for an upload
 *  and by nothing else — a NAR is written to disk exactly as it arrives. */
export async function writeStreamToFile(
  body: ReadableStream<Uint8Array>,
  path: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await pipeline(Readable.fromWeb(body as never), createWriteStream(path));
}
