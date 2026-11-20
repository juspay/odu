/**
 * The edge between Effect and the Promise world: `await`ing an `Effect` yields
 * the object instead of dispatching the call, a `Stream` is lazy (the first
 * `next()` starts the producer), and closing the iterator interrupts the fiber,
 * which is the teardown.
 */

import { Cause, Effect, Option, Stream } from "effect";

/** Dispatch a UNARY member call as a Promise. Rejects with the SQUASHED
 *  failure — the tagged-error instance with its `_tag` and data intact. */
export async function runUnary<T>(
  call: Effect.Effect<T, unknown>,
): Promise<T> {
  return Effect.runPromise(call);
}

function endOnInterrupt<T>(
  stream: Stream.Stream<T, unknown>,
): Stream.Stream<T, unknown> {
  return Stream.catchCause(stream, (cause) =>
    Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
  );
}

/** The first frame of `stream`, or `undefined` when it ends without emitting.
 *  Taking the head ENDS the stream; a stream that FAILS rejects. */
export async function firstFrame<T>(
  stream: Stream.Stream<T, unknown>,
  opts: { deadlineMs?: number } = {},
): Promise<T | undefined> {
  const head = Stream.runHead(endOnInterrupt(stream));
  return Option.getOrUndefined(
    await Effect.runPromise(
      opts.deadlineMs === undefined ? head : withDeadline(head, opts.deadlineMs),
    ),
  );
}

/** A read that produced no answer within its deadline. */
export class NoAnswerWithin extends Error {
  readonly _tag = "NoAnswerWithin";
  constructor(readonly deadlineMs: number) {
    super(`no answer within ${deadlineMs}ms`);
  }
}

export function isNoAnswer(value: unknown): value is NoAnswerWithin {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _tag?: unknown })._tag === "NoAnswerWithin"
  );
}

/** Bound an effect's wait for its answer, failing with {@link NoAnswerWithin}.
 *  The timeout interrupts the effect it bounds. */
export function withDeadline<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  deadlineMs: number,
): Effect.Effect<A, E | NoAnswerWithin, R> {
  return Effect.timeoutOrElse(effect, {
    duration: deadlineMs,
    orElse: () => Effect.fail(new NoAnswerWithin(deadlineMs)),
  });
}

/** Subscribe to `stream` as an async iterable iterator, usable hand-advanced
 *  and in a `for await` over the same subscription. When `signal` is given, its
 *  abort unsubscribes and a parked `next()` resolves `{ done: true }`. */
export function subscribe<T>(
  stream: Stream.Stream<T, unknown>,
  signal?: AbortSignal,
): AsyncIterableIterator<T> {
  const iterator = Stream.toAsyncIterable(endOnInterrupt(stream))[
    Symbol.asyncIterator
  ]();
  const unsubscribe = (): void => {
    void Promise.resolve(iterator.return?.()).catch(() => {});
  };
  if (signal !== undefined) {
    if (signal.aborted) unsubscribe();
    else signal.addEventListener("abort", unsubscribe, { once: true });
  }
  return {
    next: () => iterator.next(),
    return: async () => {
      unsubscribe();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

export function runDetached(effect: Effect.Effect<void, Error>): void {
  Effect.runFork(effect);
}

/** Effect RPC defects arrive as the squashed cause — often a bare string — so
 *  `(err as Error).message` on one prints `undefined`. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message === "" ? String(err) : err.message;
  const message = (err as { message?: unknown } | null)?.message;
  if (typeof message === "string") return message;
  if (typeof err === "object" && err !== null) {
    try {
      const rendered = JSON.stringify(err);
      return rendered.length <= 512 ? rendered : rendered.slice(0, 512) + "…";
    } catch {
      return String(err);
    }
  }
  return String(err);
}

export function errorStack(err: unknown): string {
  return err instanceof Error && err.stack !== undefined ? err.stack : errorMessage(err);
}
