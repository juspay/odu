import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { ObjectChanged } from "@odu/objects";
import { fifoStream } from "./fifo";
import { describeFailure } from "./failure";
import { base32, canonicalNarHash, NarinfoError, storePathHash } from "./narinfo";
import type { SelfHashes } from "./storePath";

export interface PathInfo {
  storePath: string;
  narHash: string;
  narSize: number;
  references: readonly string[];
  deriver: string | null;
  /** Nix's `CA:` fact about the path — `fixed:r:sha256:…` or null. */
  ca: string | null;
  sigs: readonly string[];
}

type RunOutcome = {
  stdout: string;
  stderr: string;
  argv: string;
} & ({ kind: "exited"; code: number | null } | { kind: "never-ran"; failure: string });

function run(command: string, args: readonly string[]): Promise<RunOutcome> {
  const { promise, resolve } = Promise.withResolvers<RunOutcome>();
  const argv = [command, ...args].join(" ");
  const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.on("error", (err) =>
    resolve({ kind: "never-ran", stdout, stderr, argv, failure: describeFailure(err) }),
  );
  child.on("close", (code) => resolve({ kind: "exited", stdout, stderr, argv, code }));
  return promise;
}

const exitedCleanly = (result: RunOutcome): boolean => result.kind === "exited" && result.code === 0;

function whyRunFailed(result: RunOutcome): string {
  const said = result.stderr.trim();
  const head =
    result.kind === "exited"
      ? `\`${result.argv}\` exited ${String(result.code)}`
      : `\`${result.argv}\` could not be run: ${result.failure}`;
  return said === "" ? head : `${head}: ${said}`;
}

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
  if (exitedCleanly(formatted)) return { ok: true, stdout: formatted.stdout };
  if (!/unrecognised flag|unrecognized option|unknown flag/i.test(formatted.stderr)) {
    return { ok: false, message: whyRunFailed(formatted) };
  }
  const plain = await run("nix", [...base, "--json", ...storeArgsOf(store), ...paths]);
  return exitedCleanly(plain)
    ? { ok: true, stdout: plain.stdout }
    : { ok: false, message: `${whyRunFailed(plain)} (after ${whyRunFailed(formatted)})` };
}

/**
 * `nix path-info --json` has answered in three shapes across its life — an
 * object keyed by store path (format 1), the same object under `info`
 * (format 2), and a bare ARRAY of records keyed by their own `path` (every
 * Nix before `--json-format` existed, which is what the fallback above
 * reaches).
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
      // A `null` entry is a store saying "I do not have this".
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

export async function nixPathInfo(
  storePath: string,
  store: string | null,
): Promise<PathInfo | null> {
  const answer = await pathInfoArgs(["path-info"], store, [storePath]);
  return answer.ok ? (parsePathInfoTable(answer.stdout).get(storePath) ?? null) : null;
}

export async function nixClosure(paths: readonly string[], store: string | null): Promise<PathInfo[]> {
  const answer = await pathInfoArgs(["path-info", "-r"], store, paths);
  if (!answer.ok) throw new Error(`the closure could not be read: ${answer.message}`);
  return [...parsePathInfoTable(answer.stdout).values()];
}

/**
 * Its stderr MUST be consumed — a child whose stderr nobody reads blocks on a
 * full pipe.
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
 * A FIFO rather than a child pipe because `node:child_process` and `Bun.spawn`
 * both read a child's stdout into this process whether or not anyone is
 * consuming it; {@link fifoStream} is the reading half.
 *
 * The read does not END until the pipeline exited 0 (`pipefail` makes nix's
 * exit the pipeline's); a non-zero exit errors the stream rather than handing
 * out a valid frame of a truncated NAR.
 */
export function nixDump(storePath: string, store: string | null): ReadableStream<Uint8Array> {
  const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;
  return fifoStream((fifo) => {
    const script = [
      "set -o pipefail;",
      store === null
        ? 'nix store dump-path "$ODU_NIX_DUMP_PATH"'
        : 'nix store dump-path --store "$ODU_NIX_DUMP_STORE" "$ODU_NIX_DUMP_PATH"',
      '| zstd -T0 -c > "$ODU_NIX_DUMP_FIFO"',
    ].join(" ");
    const pipelineLine = [
      "nix store dump-path",
      ...storeArgsOf(store),
      quote(storePath),
      "| zstd -T0 -c >",
      quote(fifo),
    ].join(" ");
    const child = spawn("bash", ["-c", script], {
      env: {
        ...Bun.env,
        ODU_NIX_DUMP_PATH: storePath,
        ODU_NIX_DUMP_FIFO: fifo,
        ...(store === null ? {} : { ODU_NIX_DUMP_STORE: store }),
      },
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const said = stderrTail(child.stderr);
    let exitCode: number | null = null;
    // `bash` missing, or a fork that could not be made, arrives here as an
    // `Error` with a `code` on it and never reaches `close`.
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
 *  RELEASED NIX WRITES TWO FORMS, and both kinds of path exist:
 *
 *  - Nix 2.17 through 2.34: the zeroed bytes and nothing else. Its
 *    `RewritingSink` records no match positions, so nothing follows them.
 *  - Nix 2.35 and later: the same zeroed bytes, then `|<offset>` for each
 *    occurrence, in order, where the offset is the occurrence's byte position
 *    in the uncompressed NAR (`HashModuloSink::finish`, now that
 *    `rewriteStrings` records `matches`). */
export function narHashModuloHasher(hashPart: string): {
  update(chunk: Uint8Array): void;
  finish(): SelfHashes;
} {
  const hash = createHash("sha256");
  const pattern = Buffer.from(hashPart, "utf8");
  const zeros = Buffer.alloc(pattern.length);
  let pending = Buffer.alloc(0);
  let hashed = 0;
  const offsets: number[] = [];
  return {
    update(chunk) {
      const data = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
      let at = 0;
      for (;;) {
        const found = data.indexOf(pattern, at);
        if (found === -1) break;
        offsets.push(hashed + found);
        hash.update(data.subarray(at, found));
        hash.update(zeros);
        at = found + pattern.length;
      }
      const safe = Math.max(at, data.length - (pattern.length - 1));
      hash.update(data.subarray(at, safe));
      hashed += safe;
      pending = data.subarray(safe);
    },
    finish() {
      hash.update(pending);
      const positioned = hash.copy();
      for (const offset of offsets) positioned.update(`|${offset}`);
      return {
        withoutOffsets: `sha256:${base32(hash.digest())}`,
        withOffsets: `sha256:${base32(positioned.digest())}`,
      };
    },
  };
}

export type NarCheck =
  | {
      ok: true;
      narHash: string;
      narSize: number;
      fileHash: string;
      fileSize: number;
      selfHash: SelfHashes | null;
    }
  | {
      ok: false;
      message: string;
      why?: "absent" | "changed";
    };

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
 * `nix copy --from file://<staged>` verifies the NarHash — but only when the
 * path is NOT already valid in the destination store, where it copies zero
 * paths, opens nothing and exits 0. So the bytes are hashed here, against the
 * narinfo, BEFORE the import is attempted.
 */
export function verifyNarFile(
  path: string,
  compression: string | null,
  selfHashPart: string | null = null,
): Promise<NarCheck> {
  return verifyNar(
    { name: path, open: () => createReadStream(path), size: () => statSync(path).size },
    compression,
    selfHashPart,
  );
}

/**
 * THE WEB STREAM IS READ BY HAND rather than through `Readable.fromWeb`: Bun
 * 1.3.13 drops a failing web stream's error on the floor there — no `'error'`
 * on the Readable, an unhandled rejection in the process, and a daemon that
 * exits 1 while refusing one upload (issue #160).
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

/** One read in flight at a time: `push` may call `read` again from inside
 *  itself, and a second `reader.read()` on a reader already reading
 *  rejects. */
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

const classifyReadFailure = (err: unknown): NarCheck => ({
  ok: false,
  message: String(err),
  ...(err instanceof ObjectChanged
    ? { why: "changed" as const }
    : (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { why: "absent" as const }
      : {}),
});

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
    return { ok: false, message: decompressor.error };
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
  let said: () => string = () => "";

  const settle = (): void => {
    if (settled || !ended || !fileEnded || code === null) return;
    settled = true;
    if (code !== 0) {
      resolve({ ok: false, message: `${decompressor?.[0] ?? "the NAR"} exited ${code}${said()}` });
      return;
    }
    // THE DECOMPRESSOR CAN EXIT 0 EARLY (bzip2 warns about trailing garbage),
    // so the COMPRESSED read must also have reached the end, and the bytes it
    // hashed must be the file a client will receive.
    let actual: number;
    try {
      actual = bytes.size();
    } catch (err) {
      resolve(classifyReadFailure(err));
      return;
    }
    if (actual !== fileSize) {
      resolve({ ok: false, message: `${bytes.name} is ${actual} bytes but ${fileSize} were read` });
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
      resolve({ ok: false, message: `${decompressor[0]}: ${String(err)}` });
    });
    child.on("close", (exit) => {
      code = exit ?? -1;
      settle();
    });
    if (child.stdout === null) {
      return { ok: false, message: `${decompressor[0]} produced no output` };
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
      // Its stdin stays open while it waits for bytes that are not coming.
      child.stdin?.end();
      resolve(classifyReadFailure(err));
    });
    file.pipe(child.stdin as NodeJS.WritableStream);
    source = child.stdout;
  }

  source.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    modulo?.update(chunk);
    size += chunk.length;
    if (decompressor === null) {
      fileHash.update(chunk);
      fileSize += chunk.length;
    }
  });
  source.on("error", (err) => {
    if (settled) return;
    settled = true;
    resolve(classifyReadFailure(err));
  });
  source.on("end", () => {
    ended = true;
    if (decompressor === null) fileEnded = true;
    settle();
  });
  return promise;
}
