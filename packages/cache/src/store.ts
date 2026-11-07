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
import { spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { ObjectChanged } from "@odu/objects";
import { fifoStream } from "./fifo";
import { describeFailure } from "./failure";
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
  /** THE SPAWN ITSELF FAILING, described in full — an `ENOENT` for a `nix`
   *  that is not on this machine's PATH, an `EACCES`, an `E2BIG`. It is not
   *  an exit code and must never be reported as one: `String(err)` keeps the
   *  sentence and drops the `code`, which is the only part that says which of
   *  those happened. Null when the child ran at all. */
  failure: string | null;
  /** The argv, as it would be typed. A failure that does not say which
   *  command produced it leaves a reader guessing between the two `nix
   *  path-info` spellings below and the `--store` one of them carries. */
  argv: string;
}

/** One `nix`/`nix-store` invocation, collected. Used for everything that is not
 *  a byte stream: a path-info read, an import, a root, a delete. */
function run(command: string, args: readonly string[]): Promise<Run> {
  const { promise, resolve } = Promise.withResolvers<Run>();
  const argv = [command, ...args].join(" ");
  const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.on("error", (err) =>
    resolve({ code: null, stdout, stderr, argv, failure: describeFailure(err) }),
  );
  child.on("close", (code) => resolve({ code, stdout, stderr, argv, failure: null }));
  return promise;
}

/**
 * WHY ONE INVOCATION FAILED — the argv, what became of the child, and
 * everything it said.
 *
 * All three, because any two of them leave a question: "nix exited 1" does
 * not say which `nix`, the stderr alone does not say whether the process even
 * started, and the argv alone does not say what went wrong. This is the whole
 * of what the push client can tell an operator about a store it could not
 * read.
 */
function whyRunFailed(result: Run): string {
  const said = result.stderr.trim();
  const head =
    result.failure === null
      ? `\`${result.argv}\` exited ${String(result.code)}`
      : `\`${result.argv}\` could not be run: ${result.failure}`;
  return said === "" ? head : `${head}: ${said}`;
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
    return { ok: false, message: whyRunFailed(formatted) };
  }
  const plain = await run("nix", [...base, "--json", ...storeArgsOf(store), ...paths]);
  // BOTH SPELLINGS' REASONS when the fallback also failed. The first failure
  // is the one that said `--json-format` is unrecognised; the second is the
  // real one, and a reader who sees only it cannot tell that this Nix was
  // tried twice.
  return plain.code === 0
    ? { ok: true, stdout: plain.stdout }
    : { ok: false, message: `${whyRunFailed(plain)} (after ${whyRunFailed(formatted)})` };
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
  if (!answer.ok) throw new Error(`the closure could not be read: ${answer.message}`);
  return [...parsePathInfoTable(answer.stdout).values()];
}

/**
 * A CHILD'S LAST WORDS, drained and kept.
 *
 * Its stderr MUST be consumed — a child whose stderr nobody reads blocks on a
 * full pipe — and what it said is the whole of why it failed, so one reader
 * does both. The answer is `: <everything it said>`, ready to splice onto a
 * sentence, or nothing at all.
 *
 * ALL OF IT, not the last line: `nix store dump-path` reports a missing path
 * over several lines and `error: …` is rarely the last of them, so quoting
 * one line routinely quoted the least useful one. Collapsed to a single line
 * because these become lines in a push's log. The last two kilobytes is a
 * bound on THIS process's memory against a child that writes without end, not
 * an opinion about how much of a failure is worth reading.
 */
function stderrTail(stream: Readable | null): () => string {
  let kept = "";
  stream?.on("data", (chunk: Buffer) => {
    kept = `${kept}${chunk.toString("utf8")}`.slice(-2000);
  });
  return () => {
    const said = kept.replace(/\s+/g, " ").trim();
    return said === "" ? "" : `: ${said}`;
  };
}

/**
 * A NAR as a zstd stream, through a FIFO.
 *
 * A FIFO rather than a child pipe because `node:child_process` and `Bun.spawn`
 * both read a child's stdout into this process whether or not anyone is
 * consuming it; {@link fifoStream} is the reading half, and holds that
 * measurement. N pullers share one dump per pull, not N files.
 *
 * The read does not END until the pipeline exited 0 (`pipefail` makes nix's
 * exit the pipeline's); a non-zero exit errors the stream rather than handing
 * out a valid frame of a truncated NAR. Cancel kills the pipeline's process
 * group.
 *
 * **THIS IS WHERE AN EMPTY NAR CAME FROM.** The reader used to answer a FIFO's
 * `EAGAIN` as a zero-byte read, and for a NAR small enough that zstd's only
 * write and the pipeline's exit land in the same breath that published ZERO
 * bytes: the pusher PUT an empty body, staging kept a 0-byte file, and the
 * narinfo was refused with `zstd exited 1`. Measured at 24 empty dumps in 640
 * on a 95-byte NAR.
 */
export function nixDump(storePath: string, store: string | null): ReadableStream<Uint8Array> {
  const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;
  return fifoStream((fifo) => {
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
    const said = stderrTail(child.stderr);
    let exitCode: number | null = null;
    // THE SPAWN FAILING IS NOT AN EXIT CODE. `bash` missing, or a fork that
    // could not be made, arrives here as an `Error` with a `code` on it and
    // never reaches `close`; reporting it as "exited -1" names a pipeline
    // that never ran.
    let spawnFailure: string | null = null;
    const settle = (code: number): void => {
      exitCode = code;
    };
    child.on("error", (err) => {
      spawnFailure = describeFailure(err);
      settle(-1);
    });
    child.on("close", (code) => settle(code ?? -1));
    return {
      ended: () =>
        exitCode === null
          ? null
          : exitCode === 0
            ? { ok: true }
            : {
                ok: false,
                // THE WHOLE PIPELINE, as it was run: a dump that failed for a
                // path or a store this process was not given access to is
                // unreadable without the argv, and `--store` is in it.
                error: new Error(
                  spawnFailure === null
                    ? `\`${pipelineLine}\` exited ${exitCode}${said()}`
                    : `\`${pipelineLine}\` could not be run: ${spawnFailure}${said()}`,
                ),
              },
      stop: () => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      },
    };
  });
}

/** Nix's `HashModuloSink`: replace every occurrence of the path's own 32-char
 *  hash part with 32 zero bytes and sha256 the result. Matches can straddle
 *  read chunks, so the last 31 bytes wait for the next one.
 *
 *  Nix 2.34's `RewritingSink` calls `rewriteStrings` and records no match
 *  positions (`matches` stays empty), so there is NO `|pos` fold — pinned by a
 *  `nix store make-content-addressed` vector in the suite. Matching the Nix
 *  that produces the CA is the only useful definition. */
export function narHashModuloHasher(hashPart: string): {
  update(chunk: Uint8Array): void;
  finish(): string;
} {
  const hash = createHash("sha256");
  const pattern = Buffer.from(hashPart, "utf8");
  const zeros = Buffer.alloc(pattern.length);
  let pending = Buffer.alloc(0);
  return {
    update(chunk) {
      const data = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
      let at = 0;
      for (;;) {
        const found = data.indexOf(pattern, at);
        if (found === -1) break;
        hash.update(data.subarray(at, found));
        hash.update(zeros);
        at = found + pattern.length;
      }
      // A match may begin in the last 31 bytes; keep them for the next chunk.
      const safe = Math.max(at, data.length - (pattern.length - 1));
      hash.update(data.subarray(at, safe));
      pending = data.subarray(safe);
    },
    finish() {
      hash.update(pending);
      return `sha256:${base32(hash.digest())}`;
    },
  };
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
      /** The self-reference modulo hash, when one was requested. */
      selfHash: string | null;
    }
  | {
      ok: false;
      absent: boolean;
      message: string;
      /** THE BYTES MOVED WHILE THEY WERE BEING READ — a store answering an
       *  {@link ObjectChanged}, not a NAR that is wrong. The upload is refused
       *  either way; the caller says which happened, because "the temp key was
       *  rewritten under the readback" and "the client sent a bad NAR" are two
       *  different operator problems (issue #160). */
      changed?: true;
    };

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
export function verifyNarFile(
  path: string,
  compression: string | null,
  /** The row's own hash part when its references include itself. */
  selfHashPart: string | null = null,
): Promise<NarCheck> {
  return verifyNar(
    { name: path, open: () => createReadStream(path), size: () => statSync(path).size },
    compression,
    selfHashPart,
  );
}

/**
 * THE SAME CHECK over a KEPT OBJECT, from whichever store holds it — the
 * self-CA pass reads a row's bytes this way, so it needs no file of its own.
 *
 * THE WEB STREAM IS READ BY HAND rather than through `Readable.fromWeb`: Bun
 * 1.3.13 drops a failing web stream's error on the floor there — no `'error'`
 * on the Readable, an unhandled rejection in the process, and a daemon that
 * exits 1 while refusing one upload (issue #160). A reader loop hands the
 * failure to `destroy`, which is the `'error'` this function already knows how
 * to turn into `{ok: false}`.
 */
export function verifyNarStream(
  object: { stream: ReadableStream<Uint8Array>; size: number },
  compression: string | null,
  selfHashPart: string | null = null,
): Promise<NarCheck> {
  return verifyNar(
    { name: "the stored object", open: () => readableOf(object.stream), size: () => object.size },
    compression,
    selfHashPart,
  );
}

/** A web stream as a `Readable`, FAILURES INCLUDED. One read in flight at a
 *  time: `push` may call `read` again from inside itself, and a second
 *  `reader.read()` on a reader already reading rejects. */
function readableOf(stream: ReadableStream<Uint8Array>): Readable {
  const reader = stream.getReader();
  let reading = false;
  const readable = new Readable({
    read() {
      if (reading) return;
      reading = true;
      reader.read().then(
        ({ done, value }) => {
          reading = false;
          readable.push(done ? null : value);
        },
        (err: unknown) => {
          reading = false;
          readable.destroy(err instanceof Error ? err : new Error(String(err)));
        },
      );
    },
    destroy(err, done) {
      void reader.cancel(err ?? undefined).catch(() => {});
      done(err);
    },
  });
  return readable;
}

/**
 * WHY A READ COULD NOT BE JUDGED, from the error that ended it.
 *
 * Three failures, three different operator problems: a file that is not there
 * (`absent`, which another proof may still answer), an object the store
 * rewrote under the read (`changed`), and everything else — a broken pipe, a
 * refused connection, bad bytes.
 */
const unreadable = (err: unknown): NarCheck => ({
  ok: false,
  absent: (err as NodeJS.ErrnoException).code === "ENOENT",
  message: String(err),
  ...(err instanceof ObjectChanged ? { changed: true as const } : {}),
});

/** The bytes a verify reads: opened ONCE, and the length they should have. */
interface NarBytes {
  name: string;
  open(): Readable;
  size(): number;
}

async function verifyNar(
  bytes: NarBytes,
  compression: string | null,
  selfHashPart: string | null,
): Promise<NarCheck> {
  const decompressor = decompressorOf(compression);
  if (decompressor !== null && !Array.isArray(decompressor)) {
    return { ok: false, absent: false, message: decompressor.error };
  }

  const { promise, resolve } = Promise.withResolvers<NarCheck>();
  const hash = createHash("sha256");
  const fileHash = createHash("sha256");
  const modulo = selfHashPart === null ? null : narHashModuloHasher(selfHashPart);
  let fileSize = 0;
  let size = 0;
  let ended = false;
  let fileEnded = false;
  let code: number | null = decompressor === null ? 0 : null;
  let settled = false;
  /** WHAT THE DECOMPRESSOR SAID. A bare "zstd exited 1" is the same sentence
   *  for an empty upload, a truncated one and a corrupt one; the operator
   *  reading a refused push needs the one zstd actually printed. */
  let said: () => string = () => "";

  const settle = (): void => {
    if (settled || !ended || !fileEnded || code === null) return;
    settled = true;
    if (code !== 0) {
      resolve({
        ok: false,
        absent: false,
        message: `${decompressor?.[0] ?? "the NAR"} exited ${code}${said()}`,
      });
      return;
    }
    // THE DECOMPRESSOR CAN EXIT 0 EARLY (bzip2 warns about trailing garbage),
    // so the COMPRESSED read must also have reached the end, and the bytes it
    // hashed must be the file a client will receive.
    let actual: number;
    try {
      actual = bytes.size();
    } catch (err) {
      resolve(unreadable(err));
      return;
    }
    if (actual !== fileSize) {
      resolve({
        ok: false,
        absent: false,
        message: `${bytes.name} is ${actual} bytes but ${fileSize} were read`,
      });
      return;
    }
    resolve({
      ok: true,
      narHash: `sha256:${base32(hash.digest())}`,
      narSize: size,
      fileHash: `sha256:${base32(fileHash.digest())}`,
      fileSize,
      selfHash: modulo === null ? null : modulo.finish(),
    });
  };

  let source: Readable;
  if (decompressor === null) {
    source = bytes.open();
  } else {
    const child = spawn(decompressor[0] as string, decompressor.slice(1), {
      // The FILE goes in on stdin: a decompressor spawned with stdin closed
      // reads nothing and exits non-zero, which would refuse every upload.
      stdio: ["pipe", "pipe", "pipe"],
    });
    said = stderrTail(child.stderr);
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
    const file = bytes.open();
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
      // NOTHING WILL FEED THE DECOMPRESSOR NOW. Its stdin stays open while it
      // waits for bytes that are not coming, so it is ended here rather than
      // left running past the answer this read already has.
      child.stdin?.end();
      // The file going away between a `stat` and this open is the ordinary
      // consequence of a concurrent drain; it is absence, not bad bytes.
      resolve(unreadable(err));
    });
    file.pipe(child.stdin as NodeJS.WritableStream);
    source = child.stdout;
  }

  source.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    modulo?.update(chunk);
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
    resolve(unreadable(err));
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
