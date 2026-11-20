/**
 * A log tail: a clamped in-memory buffer plus a delta channel, keyed by an
 * opaque string. `end` is idempotent, `reset` re-opens an ended log, and
 * `append` after `end` THROWS.
 */

import {
  type Channel,
  inMemoryChannel,
  streamFromAbortableSource,
} from "@kolu/surface/server";
import type { Stream } from "effect";
import { clampLog, type NodeLogMessage } from "@odu/run-client/surface";

interface LogTail {
  buffer: string;
  bus: Channel<NodeLogMessage>;
  ended: boolean;
}

export interface CreateLogTailResult {
  /** Clamp `buffer + text` and publish an `append` frame. Throws on a log that
   *  has already ended. */
  append: (id: string, text: string) => void;
  /** Clamp `text` as the new buffer and publish a `snapshot` frame. Re-opens an
   *  ended log. */
  reset: (id: string, text: string) => void;
  /** Latch this node's log complete and publish the terminal `end` frame.
   *  Idempotent. */
  end: (id: string) => void;
  isNoopReset: (id: string, text: string) => boolean;
  isEnded: (id: string) => boolean;
  streamSource: (input: { id: string }) => Stream.Stream<NodeLogMessage>;
}

export function createLogTail(): CreateLogTailResult {
  const logs = new Map<string, LogTail>();
  const logFor = (id: string): LogTail => {
    let log = logs.get(id);
    if (log === undefined) {
      log = { buffer: "", bus: inMemoryChannel<NodeLogMessage>(), ended: false };
      logs.set(id, log);
    }
    return log;
  };

  const append = (id: string, text: string): void => {
    const log = logFor(id);
    if (log.ended) {
      throw new Error(
        `logTail: append to ${id} after its log ended — a terminal frame promises no further bytes; call reset() to re-open the log instead`,
      );
    }
    log.buffer = clampLog(log.buffer + text);
    log.bus.publish({ kind: "append", text });
  };
  const reset = (id: string, text: string): void => {
    const log = logFor(id);
    log.buffer = clampLog(text);
    log.ended = false;
    log.bus.publish({ kind: "snapshot", text: log.buffer });
  };
  const end = (id: string): void => {
    const log = logFor(id);
    if (log.ended) return;
    log.ended = true;
    log.bus.publish({ kind: "end" });
  };

  const isEnded = (id: string): boolean => logFor(id).ended;

  const isNoopReset = (id: string, text: string): boolean => {
    const log = logFor(id);
    return text === "" && log.buffer === "" && !log.ended;
  };

  const streamSource = ({ id }: { id: string }): Stream.Stream<NodeLogMessage> =>
    streamFromAbortableSource(async function* (signal) {
      const log = logFor(id);
      // `subscribe()` adds the subscriber to the registry before it RETURNS
      // (see `inMemoryChannel` in @kolu/surface).
      const deltas = log.bus.subscribe(signal);
      const snapshot = log.buffer;
      const alreadyEnded = log.ended;
      yield { kind: "snapshot", text: snapshot } satisfies NodeLogMessage;
      if (alreadyEnded && log.ended) yield { kind: "end" } satisfies NodeLogMessage;
      yield* deltas;
    });

  return { append, reset, end, isEnded, isNoopReset, streamSource };
}

export function isSealedLogAppendError(err: unknown): err is Error {
  return err instanceof Error && err.message.includes("after its log ended");
}

export function absorbSealedLogAppend(err: unknown): void {
  if (!isSealedLogAppendError(err)) throw err;
  process.stderr.write(`odu: ${err.message}\n`);
}
