/**
 * THE OBJECT STORE — the bytes a cache serves, behind an interface.
 *
 * **The object IS the compressed NAR a pusher uploaded.** A push already sends
 * `nar/<narHash>.nar.zst`, whole or in parts; the write path assembles it and
 * proves it (NarHash over the DECOMPRESSED bytes) before recording the row. The
 * verified file then becomes the object, one `put` away, and nothing else is
 * stored on the server: no Nix store, no imported closures, no second copy.
 * That is the Cachix/Attic model, and it is what makes the pod's disk budget
 * work — the 166 GB Nix store was upstream closures nobody ever pulled from us.
 *
 * **Keys are content names under a bucket prefix:**
 * `<bucket>/nar/<narHash base32>.<ext>`, where the extension names the stored
 * compression. Objects are immutable; a key is never overwritten with different
 * bytes, and `put` is idempotent for the same key.
 *
 * **One owner, two implementations.** This module is the interface and its
 * DISK implementation. The cache row constructs it at apply; the routes serve
 * from it, staging puts into it, GC and the boot sweep delete from it. An S3
 * implementation arrives as a later phase and runs the SAME contract suite
 * (`objectStore.contract.ts`), which is why the suite is exported and the disk
 * implementation is only one caller of it.
 *
 * **A put is atomic.** The disk implementation writes a temp name beside the
 * final key and renames it into place; a crash leaves a `.tmp-*` tail, which
 * `list` skips and the boot sweep removes. No half object is ever visible under
 * its final key.
 *
 * **`localPath` is the disk implementation's extra.** The route can hand Bun a
 * real file (sendfile, Content-Length, Range); an object store that is not the
 * local filesystem answers `null` and the route streams `get` with its length.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { base32 } from "./narinfo";
import { writeAll } from "./sink";

/** What `put` learned while it wrote: the compressed bytes' own facts. */
export interface ObjectFacts {
  size: number;
  /** `sha256:<base32>` of the COMPRESSED bytes — Nix's `FileHash`. */
  sha256: string;
}

export interface StoredObject {
  stream: ReadableStream<Uint8Array>;
  size: number;
}

export interface ObjectStore {
  /** Write `stream` at `key`. Immutable: the same key with the same bytes is a
   *  no-op; a `.tmp-*` file is never visible. */
  put(key: string, stream: ReadableStream<Uint8Array>): Promise<ObjectFacts>;
  /** KEEP a file that is already on this store's filesystem: rename it into
   *  place, never copy. The disk implementation's fast path for a verified
   *  upload; an object store without a shared filesystem has no equivalent. */
  adopt?(key: string, file: string, facts?: ObjectFacts): Promise<ObjectFacts>;
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
  /** Every object under `prefix`, for the boot sweep and a stats line. */
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  /** The disk implementation's file, for a response that needs Range. */
  localPath(key: string): string | null;
  /** Delete `.tmp-*` files older than `current` — the boot sweep, before a
   *  mount can be writing. A younger temp file is a live put. */
  sweepTemp?(current: number): Promise<number>;
}

export interface DiskObjectStoreOptions {
  /** The cache's own directory; keys live under `<dir>/objects`. */
  dir: string;
}

/** A key is a relative path of plain segments: no `..`, no leading slash. */
function safeKey(key: string): string {
  const clean = key.replaceAll("\\", "/");
  if (clean.startsWith("/") || clean.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`"${key}" is not an object key`);
  }
  return clean;
}

export function diskObjectStore(options: DiskObjectStoreOptions): ObjectStore {
  const root = join(options.dir, "objects");
  const pathOf = (key: string): string => join(root, safeKey(key));

  /** The facts of a file already at `path`, without reading it twice. */
  async function factsOf(path: string): Promise<ObjectFacts> {
    const info = await stat(path);
    const hash = createHash("sha256");
    for await (const chunk of Bun.file(path).stream() as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
    }
    return { size: info.size, sha256: `sha256:${base32(hash.digest())}` };
  }

  async function put(key: string, stream: ReadableStream<Uint8Array>): Promise<ObjectFacts> {
    const target = pathOf(key);
    // IMMUTABLE: a key that exists is the object. A re-push does not rewrite
    // bytes, and the retained file is what the row already names.
    if ((await stat(target).catch(() => null)) !== null) {
      // THE STREAM'S PRODUCER MUST STOP: a migration twin found an object
      // another row already wrote, and abandoning the FIFO would leave its
      // dump process blocked on a full pipe for the life of the daemon.
      await stream.cancel().catch(() => {});
      return factsOf(target);
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temp = join(dirname(target), `.tmp-${randomUUID()}`);
    const hash = createHash("sha256");
    let size = 0;
    try {
      const sink = Bun.file(temp).writer({ highWaterMark: 1 << 20 });
      try {
        for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
          hash.update(chunk);
          size += chunk.length;
          await writeAll(sink, chunk, temp);
        }
      } finally {
        await sink.end();
      }
      await rename(temp, target);
    } catch (err) {
      await unlink(temp).catch(() => {});
      throw err;
    }
    return { size, sha256: `sha256:${base32(hash.digest())}` };
  }

  async function adopt(
    key: string,
    file: string,
    facts?: ObjectFacts,
  ): Promise<ObjectFacts> {
    const target = pathOf(key);
    if ((await stat(target).catch(() => null)) !== null) {
      await unlink(file).catch(() => {});
      return factsOf(target);
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await rename(file, target);
    } catch (err) {
      // A staged file on another filesystem cannot be renamed; copying is the
      // only answer, and it is the exception rather than the import path.
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await Bun.write(target, Bun.file(file));
      await unlink(file).catch(() => {});
    }
    return facts ?? factsOf(target);
  }

  return {
    put,
    adopt,

    async get(key) {
      const path = pathOf(key);
      const info = await stat(path).catch(() => null);
      if (info === null || !info.isFile()) return null;
      return { stream: Bun.file(path).stream(), size: info.size };
    },

    async head(key) {
      const info = await stat(pathOf(key)).catch(() => null);
      return info !== null && info.isFile() ? info.size : null;
    },

    async delete(key) {
      await unlink(pathOf(key)).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
    },

    async list(prefix) {
      const base = prefix === "" ? root : pathOf(prefix);
      const out: { key: string; size: number }[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const at = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(at);
          } else if (entry.isFile() && !entry.name.startsWith(".tmp-")) {
            const info = await stat(at).catch(() => null);
            if (info !== null) {
              out.push({
                key: normalize(at.slice(root.length + 1)).split(sep).join("/"),
                size: info.size,
              });
            }
          }
        }
      };
      await walk(base);
      return out;
    },

    localPath(key) {
      const path = pathOf(key);
      return path.startsWith(`${root}${sep}`) ? path : null;
    },

    async sweepTemp(current) {
      let removed = 0;
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const at = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(at);
            continue;
          }
          if (!entry.name.startsWith(".tmp-")) continue;
          const info = await stat(at).catch(() => null);
          // A temp file younger than this process is a put that is running now.
          if (info === null || info.mtimeMs > current) continue;
          await unlink(at).catch(() => {});
          removed += 1;
        }
      };
      await walk(root);
      return removed;
    },
  };
}
