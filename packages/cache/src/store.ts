/**
 * THE LOCAL NIX STORE, as the PUSH CLIENT and the MIGRATION need it — never as
 * the server's storage.
 *
 * A cache object is the compressed NAR a pusher sent, kept by `ObjectStore`;
 * this module no longer imports, roots or deletes anything. It is the seam for
 * the three places a Nix store is still the right fact:
 *
 * - **The pusher's closure.** `nix path-info -r --json` and
 *   `nix store dump-path | zstd` read the machine that BUILT the paths.
 * - **The verifier.** {@link verifyNarFile} decompresses an upload and hashes
 *   both the NAR and the compressed file before anything is kept.
 * - **The one-time migration.** The old store is read with the same
 *   `dump-path` pipeline (`null` means the host's `/nix/store`).
 *
 * **Nix comes from PATH, deliberately.** The repo does not pin it (see
 * `default.nix` near "deliberately NOT pinned"): the host provides the client.
 * The COMPRESSORS are pinned on odu's wrapper PATH and in the devShell —
 * `zstd`, `xz` and `bzip2` — because verifying and serving a NAR is odu's own
 * work, whatever a client uploaded.
 *
 * **A NAR is never held in memory.** `dump` is a two-process pipeline whose
 * stdout is a ReadableStream; the only reader that touches every byte,
 * {@link verifyNarFile}, hashes one chunk at a time.
 *
 * **A stream that ended cleanly is not a stream that succeeded.** `nix store
 * dump-path` failing halfway closes zstd's stdin, and zstd then writes a
 * perfectly valid frame of a truncated NAR. `dump` holds the stream open until
 * both children exit and fails the read unless both exited 0.
 */

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants, createReadStream, createWriteStream, mkdtempSync, statSync } from "node:fs";
import { mkdir, open, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  /** Nix's `CA:` fact about the path — `fixed:r:sha256:…` or null. The STORE
   *  owns it; a pusher's narinfo line is only a hint. */
  ca: string | null;
  sigs: readonly string[];
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
        ca: (entry["ca"] as string | null | undefined) ?? null,
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
/** One old-store path's facts, for the migration's CA backfill. */
export async function nixPathInfo(
  storePath: string,
  store: string | null,
): Promise<PathInfo | null> {
  const answer = await pathInfoArgs(["path-info"], store, [storePath]);
  return answer.ok ? (parsePathInfoTable(answer.stdout).get(storePath) ?? null) : null;
}

export async function nixClosure(paths: readonly string[], store: string | null): Promise<PathInfo[]> {
  const answer = await pathInfoArgs(["path-info", "-r"], store, paths);
  // A FAILURE IS NOT AN EMPTY CLOSURE. A caller that got `[]` would report "no
  // such path in the store" for a store it could not read at all.
  if (!answer.ok) throw new Error(`nix path-info -r failed: ${answer.message}`);
  return [...parsePathInfoTable(answer.stdout).values()];
}

/**
 * A NAR as a zstd stream, through a FIFO.
 *
 * BOTH CHILD PIPES BUFFER: `node:child_process` and `Bun.spawn` read a child's
 * stdout into this process regardless of who consumes it (measured: ~329 MiB
 * and ~322 MiB at 10 s into a 2 MB/s read of a 320 MB NAR). A FIFO has no
 * parent pipe at all. The kernel's 64 KiB pipe buffer is the only buffer:
 * when the socket stops pulling, this read stops, the FIFO fills, zstd blocks,
 * and nix blocks. The first byte arrives as soon as zstd emits it; nothing is
 * spooled; N pullers share one dump per pull, not N files.
 *
 * The read does not END until the pipeline exited 0 (`pipefail` makes nix's
 * exit the pipeline's); a non-zero exit errors the stream rather than handing
 * out a valid frame of a truncated NAR. Cancel kills the pipeline's process
 * group.
 */
export function nixDump(storePath: string, store: string | null): ReadableStream<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "odu-nar-"));
  const fifo = join(dir, "nar.zst");
  const made = spawnSync("mkfifo", [fifo]);
  if (made.status !== 0) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(`mkfifo failed: ${made.stderr?.toString() ?? "unknown"}`));
      },
    });
  }
  const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;
  const pipelineLine = [
    "nix store dump-path",
    ...storeArgsOf(store),
    quote(storePath),
    "| zstd -T0 -c >",
    quote(fifo),
  ].join(" ");
  const child = spawn("bash", ["-c", `set -o pipefail; ${pipelineLine}`], {
    env: Bun.env,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let tail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    tail = `${tail}${chunk.toString("utf8")}`.slice(-2000);
  });
  let exitCode: number | null = null;
  const exited = new Promise<number>((resolve) => {
    const settle = (code: number): void => {
      exitCode = code;
      resolve(code);
    };
    child.on("error", () => settle(-1));
    child.on("close", (code) => settle(code ?? -1));
  });
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let cleaned = false;
  const clean = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await handle?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // NON-BLOCKING: a pipeline that could not spawn never opens the write
      // end, and a blocking open would wait for ever. `pull` retries an empty
      // read until the child has exited, which is when EOF is real.
      handle = await open(fifo, constants.O_RDONLY | constants.O_NONBLOCK).catch((err) => {
        controller.error(err);
        return null;
      });
    },
    async pull(controller) {
      if (handle === null) {
        controller.error(new Error("the NAR FIFO could not be opened"));
        return;
      }
      // THE LOOP THAT MEASURED 17 MiB: one 64 KiB read per pull.
      for (;;) {
        const buffer = new Uint8Array(64 * 1024);
        const read = await handle.read(buffer, 0, buffer.length, null).catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException).code === "EAGAIN") return { bytesRead: 0 };
          controller.error(err);
          return null;
        });
        if (read === null) return;
        if (read.bytesRead > 0) {
          controller.enqueue(buffer.subarray(0, read.bytesRead));
          return;
        }
        // No byte yet. EOF is only real once the pipeline has exited.
        if (exitCode !== null) {
          if (exitCode === 0) controller.close();
          else {
            controller.error(
              new Error(
                `nix store dump-path | zstd exited ${exitCode}` +
                  (tail.trim() === "" ? "" : `: ${tail.trim().split("\n").at(-1)}`),
              ),
            );
          }
          await clean();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    async cancel() {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      await clean();
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
  | {
      ok: true;
      narHash: string;
      narSize: number;
      /** The COMPRESSED file's sha256 and size, learned as it streamed. */
      fileHash: string;
      fileSize: number;
    }
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
  const fileHash = createHash("sha256");
  let fileSize = 0;
  let size = 0;
  let ended = false;
  let fileEnded = false;
  let code: number | null = decompressor === null ? 0 : null;
  let settled = false;

  const settle = (): void => {
    if (settled || !ended || !fileEnded || code === null) return;
    settled = true;
    if (code !== 0) {
      resolve({ ok: false, absent: false, message: `${decompressor?.[0] ?? "the NAR"} exited ${code}` });
      return;
    }
    // THE DECOMPRESSOR CAN EXIT 0 EARLY (bzip2 warns about trailing garbage),
    // so the COMPRESSED read must also have reached the end, and the bytes it
    // hashed must be the file a client will receive.
    let actual: number;
    try {
      actual = statSync(path).size;
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      resolve({ ok: false, absent: missing, message: String(err) });
      return;
    }
    if (actual !== fileSize) {
      resolve({
        ok: false,
        absent: false,
        message: `${path} is ${actual} bytes but ${fileSize} were read`,
      });
      return;
    }
    resolve({
      ok: true,
      narHash: `sha256:${base32(hash.digest())}`,
      narSize: size,
      fileHash: `sha256:${base32(fileHash.digest())}`,
      fileSize,
    });
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
    file.on("data", (chunk: string | Buffer) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      fileHash.update(bytes);
      fileSize += bytes.length;
    });
    file.on("end", () => {
      fileEnded = true;
      settle();
    });
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
    // For an uncompressed NAR the file IS the bytes hashed above.
    if (decompressor === null) {
      fileHash.update(chunk);
      fileSize += chunk.length;
    }
  });
  source.on("error", (err) => {
    if (settled) return;
    settled = true;
    const code = (err as NodeJS.ErrnoException).code;
    resolve({ ok: false, absent: code === "ENOENT", message: String(err) });
  });
  source.on("end", () => {
    ended = true;
    if (decompressor === null) fileEnded = true;
    settle();
  });
  return promise;
}

/** Copy a streamed body to a file, streaming. Used by the routes for an upload
 *  and by nothing else — a NAR is written to disk exactly as it arrives. */
