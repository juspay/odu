/**
 * THE DISK STORE — objects as files under `<dir>/objects`, facts in sidecar
 * files under `<dir>/objects/.facts`. What a store promises is `./objectStore`'s;
 * this module is how a filesystem keeps it.
 */

import { randomUUID } from "node:crypto";
import { open, link, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import {
  factsCounter,
  type ObjectBody,
  type ObjectFacts,
  type ObjectStore,
  type PutOptions,
  type PutOutcome,
  safeKey,
  sameFacts,
  TEMP,
} from "./objectStore";
import { writeAll } from "./sink";

export interface DiskObjectStoreOptions {
  /** The store's directory; keys live under `<dir>/objects`. */
  dir: string;
}

/**
 * A FILE AS A PULL STREAM, 64 KiB per read.
 *
 * NEVER a `BunFile`'s own stream: a Node HTTP adapter does not write that body,
 * so the response headers go out and the socket then waits for ever. An
 * `open`/`handle.read` loop is a stream every consumer knows, and it reads only
 * the range asked for.
 */
function fileBody(path: string, start: number, length: number): ReadableStream<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let position = start;
  let left = length;
  return new ReadableStream({
    async pull(controller) {
      try {
        handle ??= await open(path, "r");
        if (left <= 0) {
          await handle.close();
          handle = null;
          controller.close();
          return;
        }
        const size = Math.min(64 * 1024, left);
        const buffer = new Uint8Array(size);
        const { bytesRead } = await handle.read(buffer, 0, size, position);
        if (bytesRead === 0) {
          await handle.close();
          handle = null;
          controller.error(new Error(`${path} ended ${left} bytes early`));
          return;
        }
        position += bytesRead;
        left -= bytesRead;
        controller.enqueue(bytesRead === size ? buffer : buffer.subarray(0, bytesRead));
      } catch (err) {
        await handle?.close().catch(() => {});
        handle = null;
        controller.error(err);
      }
    },
    async cancel() {
      await handle?.close().catch(() => {});
      handle = null;
    },
  });
}

export function diskObjectStore(options: DiskObjectStoreOptions): ObjectStore {
  const root = join(options.dir, "objects");
  /** The facts kept beside each object, under a name no key's first segment
   *  can share with an object (a dot-name, which `list` never shows). */
  const factsRoot = join(root, ".facts");
  const pathOf = (key: string): string => join(root, safeKey(key));
  const factsPathOf = (key: string): string => join(factsRoot, safeKey(key));

  const isFile = async (path: string): Promise<number | null> => {
    const info = await stat(path).catch(() => null);
    return info !== null && info.isFile() ? info.size : null;
  };

  async function writeFacts(key: string, facts: ObjectFacts): Promise<void> {
    const target = factsPathOf(key);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temp = join(dirname(target), `${TEMP}${randomUUID()}`);
    await writeFile(temp, JSON.stringify(facts), { mode: 0o600 });
    await rename(temp, target);
  }

  async function factsOf(key: string): Promise<ObjectFacts | null> {
    const size = await isFile(pathOf(key));
    if (size === null) return null;
    const kept = await readFile(factsPathOf(key), "utf-8")
      .then((text) => JSON.parse(text) as ObjectFacts)
      .catch(() => null);
    if (kept !== null && kept.size === size) return kept;
    // AN OBJECT WRITTEN BEFORE FACTS WERE KEPT really has no sidecar (nor one
    // whose writer died between link and sidecar): hash it once, keep the answer.
    const computed = await hashStream(fileBody(pathOf(key), 0, size));
    await writeFacts(key, computed).catch(() => {});
    return computed;
  }

  /** The kept object's refusal: it exists, and these are its facts. */
  async function exists(key: string): Promise<PutOutcome> {
    const facts = await factsOf(key);
    if (facts === null) throw new Error(`${key} vanished while its put was refused`);
    return { ok: false, refusal: { kind: "exists", key, facts } };
  }

  /** LINK, never rename: `link` refuses an existing name, so of two writers of
   *  one key exactly one makes the object. The source name stays the caller's. */
  async function linkInto(key: string, file: string, facts: ObjectFacts): Promise<PutOutcome | "cross-device"> {
    const target = pathOf(key);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await link(file, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return exists(key);
      if (code === "EXDEV") return "cross-device";
      throw err;
    }
    // THE SOURCE NAME GOES: a link shares the inode, and a caller that later
    // wrote to its staged file would be writing into the object.
    await unlink(file).catch(() => {});
    await writeFacts(key, facts);
    return { ok: true, facts };
  }

  // `_options` IS ACCEPTED AND DROPPED: a file has no response of its own to
  // carry a content type or a cache lifetime, and nothing fetches an object
  // from this store without going through odu, which decides them itself.
  // There is no `presignGet` here for the same reason: these objects are
  // files on odu's machine, reachable only by reading them.
  async function put(key: string, body: ObjectBody, expected?: ObjectFacts, _options?: PutOptions): Promise<PutOutcome> {
    const stream = body instanceof Blob ? body.stream() : body;
    const target = pathOf(key);
    if ((await isFile(target)) !== null) {
      // THE STREAM'S PRODUCER MUST STOP: abandoning a stream a pipe feeds
      // would leave its writer blocked on the full pipe for ever.
      await stream.cancel().catch(() => {});
      return exists(key);
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temp = join(dirname(target), `${TEMP}${randomUUID()}`);
    const counter = factsCounter();
    try {
      const sink = Bun.file(temp).writer({ highWaterMark: 1 << 20 });
      try {
        for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
          counter.update(chunk);
          await writeAll(sink, chunk, temp);
        }
      } finally {
        await sink.end();
      }
      const facts = counter.facts();
      if (expected !== undefined && !sameFacts(expected, facts)) {
        return { ok: false, refusal: { kind: "facts_mismatch", key, expected, actual: facts } };
      }
      const linked = await linkInto(key, temp, facts);
      if (linked === "cross-device") throw new Error(`${temp} and ${target} are one directory`);
      return linked;
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  /** ONE KEY GONE: the object and the facts beside it. Absent is not an
   *  error — the store's promise, kept for `delete` and `deleteMany` alike
   *  from one place. */
  async function removeKey(key: string): Promise<void> {
    for (const path of [pathOf(key), factsPathOf(key)]) {
      await unlink(path).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
    }
  }

  return {
    put,

    async link(key, file, facts) {
      const linked = await linkInto(key, file, facts);
      // A FILE ON ANOTHER FILESYSTEM cannot be linked; copying it through
      // `put` is the exception rather than the write path.
      if (linked !== "cross-device") return linked;
      const copied = await put(key, Bun.file(file), facts);
      if (copied.ok) await unlink(file).catch(() => {});
      return copied;
    },

    async get(key, range) {
      const path = pathOf(key);
      const size = await isFile(path);
      if (size === null) return null;
      const start = range?.start ?? 0;
      const end = range?.end ?? size - 1;
      return { stream: fileBody(path, start, Math.max(0, end - start + 1)), size };
    },

    head: (key) => isFile(pathOf(key)),

    facts: factsOf,

    delete: removeKey,

    // A LOOP, because a filesystem has no batch call and needs none: these
    // are local unlinks, not round trips. The port's verb is one call so an
    // S3 bucket can answer it in one request; here it is the same per-key
    // delete, and an absent key is no more an error in a set than alone.
    async deleteMany(keys) {
      for (const key of keys) await removeKey(key);
    },

    async list(prefix) {
      const base = prefix === "" ? root : pathOf(prefix);
      const out: { key: string; size: number }[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          // `.facts` and `.tmp-*` are the store's own, never objects.
          if (entry.name.startsWith(".")) continue;
          const at = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(at);
          } else if (entry.isFile()) {
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

    async sweepTemp(prefix, current) {
      let removed = 0;
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const at = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(at);
            continue;
          }
          if (!entry.name.startsWith(TEMP)) continue;
          const info = await stat(at).catch(() => null);
          // A temp file younger than this process is a put that is running now.
          if (info === null || info.mtimeMs > current) continue;
          await unlink(at).catch(() => {});
          removed += 1;
        }
      };
      await walk(prefix === "" ? root : pathOf(prefix));
      return removed;
    },
  };
}

/** Read a whole stream through a counter: the fallback for a disk object whose
 *  facts nobody wrote down (one written before they were kept). */
async function hashStream(stream: ReadableStream<Uint8Array>): Promise<ObjectFacts> {
  const counter = factsCounter();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) counter.update(chunk);
  return counter.facts();
}
