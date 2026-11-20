/**
 * **BOTH CHILD PIPES BUFFER.** `node:child_process` and `Bun.spawn` read a
 * child's stdout into this process regardless of who consumes it (measured:
 * ~329 MiB and ~322 MiB at 10 s into a 2 MB/s read of a 320 MB NAR). A FIFO has
 * no parent pipe at all, so the kernel's 64 KiB pipe buffer is the only buffer:
 * when the consumer stops pulling, this read stops and the writer blocks.
 * Nothing is spooled, and the first byte arrives as soon as one is written.
 *
 * **The read end is opened NON-BLOCKING**, because a writer that could not
 * spawn never opens the write end and a blocking open would wait for ever.
 *
 * | Answer | What the FIFO is saying | What to do |
 * | --- | --- | --- |
 * | `n > 0` | here are n bytes | hand them over |
 * | `EAGAIN` | a writer holds me and has nothing THIS INSTANT | read again |
 * | `0` | no process holds the write end at all | the writer's end decides |
 *
 * **`EAGAIN` IS "NOT YET", NEVER "NO MORE".** A ZERO-BYTE READ is unambiguous
 * once the writer has ended: the buffer is empty and nothing will open the
 * write end again. Until then it only means the writer has not got there yet.
 */

import { spawnSync } from "node:child_process";
import { constants, mkdtempSync, rmSync } from "node:fs";
import { type FileHandle, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FifoEnd = { ok: true } | { ok: false; error: Error };

export interface FifoPipeline {
  ended: () => FifoEnd | null;
  stop: () => void;
}

const POLL_MS = 5;

export function fifoStream(producer: (fifo: string) => FifoPipeline): ReadableStream<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "odu-fifo-"));
  const fifo = join(dir, "pipe");
  const made = spawnSync("mkfifo", [fifo]);
  if (made.status !== 0) {
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
