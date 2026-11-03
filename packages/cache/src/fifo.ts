/**
 * A FIFO A CHILD WRITES, AS A PULL STREAM.
 *
 * The node, the read end and their removal are all here, because they rev on
 * ONE clock — POSIX FIFO mechanics — while what writes the FIFO revs on its
 * own. A caller supplies the writer and nothing else.
 *
 * **BOTH CHILD PIPES BUFFER.** `node:child_process` and `Bun.spawn` read a
 * child's stdout into this process regardless of who consumes it (measured:
 * ~329 MiB and ~322 MiB at 10 s into a 2 MB/s read of a 320 MB NAR). A FIFO has
 * no parent pipe at all, so the kernel's 64 KiB pipe buffer is the only buffer:
 * when the consumer stops pulling, this read stops and the writer blocks.
 * Nothing is spooled, and the first byte arrives as soon as one is written.
 *
 * **The read end is opened NON-BLOCKING**, because a writer that could not
 * spawn never opens the write end and a blocking open would wait for ever.
 * That makes a read answer three different things, and conflating two of them
 * is how a valid NAR became an empty upload:
 *
 * | Answer | What the FIFO is saying | What to do |
 * | --- | --- | --- |
 * | `n > 0` | here are n bytes | hand them over |
 * | `EAGAIN` | a writer holds me and has nothing THIS INSTANT | read again |
 * | `0` | no process holds the write end at all | the writer's end decides |
 *
 * **`EAGAIN` IS "NOT YET", NEVER "NO MORE".** It used to be answered as a
 * zero-byte read, and a zero-byte read ends the stream as soon as the writer
 * has ended — so a read issued a moment before the bytes landed closed a
 * stream that had published nothing. A ZERO-BYTE READ is unambiguous once the
 * writer has ended: the buffer is empty and nothing will open the write end
 * again. Until then it only means the writer has not got there yet.
 */

import { spawnSync } from "node:child_process";
import { constants, mkdtempSync, rmSync } from "node:fs";
import { type FileHandle, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How a writer ended: well, or with the error its reader should raise. */
export type FifoEnd = { ok: true } | { ok: false; error: Error };

/** THE WRITER OF A FIFO, to its reader: whether it has ended, and how to stop
 *  it. Everything else about it — what it runs, what it says when it fails —
 *  stays with whoever started it. */
export interface FifoPipeline {
  /** `null` while it is still writing; otherwise how it ended. */
  ended: () => FifoEnd | null;
  /** Stop it: the stream was cancelled. */
  stop: () => void;
}

/** How long to wait before asking a FIFO with nothing in it again. Bounded
 *  below by nothing and above by a process start-up, which is three orders
 *  larger; no caller has a basis to choose it. */
const POLL_MS = 5;

/**
 * Make a FIFO, hand it to `producer`, and read it.
 *
 * `producer` is called once, with the path to write, and answers the handle on
 * what it started. The FIFO and its directory belong to the stream and are
 * gone before the consumer learns the stream ended.
 */
export function fifoStream(producer: (fifo: string) => FifoPipeline): ReadableStream<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "odu-fifo-"));
  const fifo = join(dir, "pipe");
  const made = spawnSync("mkfifo", [fifo]);
  if (made.status !== 0) {
    // NOTHING WAS STARTED: `producer` has not been called, so there is no
    // writer to stop and nothing but the directory to take back.
    rmSync(dir, { recursive: true, force: true });
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(`mkfifo failed: ${made.stderr?.toString() ?? "unknown"}`));
      },
    });
  }
  const writer = producer(fifo);
  let handle: FileHandle | null = null;
  let cleaned = false;
  const clean = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await handle?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      handle = await open(fifo, constants.O_RDONLY | constants.O_NONBLOCK).catch(async (err) => {
        // A writer with no reader would block for ever on a FIFO nobody will
        // read, so it goes with the node.
        writer.stop();
        await clean();
        controller.error(err);
        return null;
      });
    },
    async pull(controller) {
      if (handle === null) {
        controller.error(new Error("the FIFO could not be opened"));
        return;
      }
      // THE LOOP THAT MEASURED 17 MiB: one 64 KiB read per pull.
      for (;;) {
        const buffer = new Uint8Array(64 * 1024);
        let bytes: number;
        try {
          bytes = (await handle.read(buffer, 0, buffer.length, null)).bytesRead;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EAGAIN") {
            controller.error(err);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          continue;
        }
        if (bytes > 0) {
          controller.enqueue(buffer.subarray(0, bytes));
          return;
        }
        const end = writer.ended();
        if (end === null) {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          continue;
        }
        await clean();
        if (end.ok) controller.close();
        else controller.error(end.error);
        return;
      }
    },
    async cancel() {
      writer.stop();
      await clean();
    },
  });
}
