/**
 * odu's ONE bridge from a surface stream member back to the pull-a-frame-at-a-
 * time shape the coordinator, the CLI and the MCP tools are written in.
 *
 * Every streaming member used to be `await client.surface.X.get(input, {signal})
 * → AsyncIterable<T>`; under Effect it is `client.surface.X.get(input) →
 * Stream<T>`, returned SYNCHRONOUSLY and LAZY, with no `AbortSignal` anywhere
 * (kolu PLAN D10/#18: cancellation is fiber interruption). Two consequences this
 * module owns so no caller re-derives them:
 *
 *   - **Subscribing is pulling.** A `Stream` value registers nothing; the first
 *     `next()` is what starts the producer. A caller that must be subscribed
 *     BEFORE it causes the event it waits on has to issue that first pull
 *     itself — `runTool`'s coordinator-startup poll and `waitTool`'s settle
 *     watcher both do, and their comments say so.
 *   - **Unsubscribing is `return()`.** Closing the iterator interrupts the fiber
 *     running the stream, which IS the teardown. So the `AbortSignal` a caller
 *     still legitimately owns (a Ctrl+C, an MCP request cancellation, the live
 *     view's focus switch) is wired to `return()` here rather than threaded into
 *     a call option that no longer exists.
 *
 * `return()` is deliberately NOT awaited: a producer parked upstream settles its
 * close late, and awaiting it would stall the next subscription (or a `for
 * await`'s own `break`). The close is fire-and-forget and its rejection is
 * swallowed — closing an already-failed stream can reject, and that rejection is
 * about the teardown, never about the data the caller already read.
 *
 * This is a LEAF, not a receptacle: a bounded algorithm over one call shape,
 * hiding no volatility. `@kolu/surface`'s own `runStreamScoped` is the shared
 * answer but is only reachable through its Solid barrel, which a Node process
 * should not import; kolu's own CLIs carry the same ~25 lines for the same
 * reason, and its W2 reports ask three times for a `./run-stream` subpath.
 */

import { Effect, Option, Stream } from "effect";

/**
 * The first frame of `stream`, or `undefined` when it ends without emitting.
 *
 * Taking the head ENDS the stream, which releases the subscription through its
 * own finalizers — the Effect equivalent of the old `for await … return`, and
 * the reason this does not leak a held-open `get` on a socket the caller is
 * about to close.
 *
 * `undefined` means the producer genuinely emitted nothing, which every caller
 * treats as a protocol failure and reports as one. A stream that FAILS rejects
 * here rather than collapsing to `undefined`: a dropped link must never read as
 * "the run has no state".
 */
export async function firstFrame<T>(
  stream: Stream.Stream<T, unknown>,
): Promise<T | undefined> {
  return Option.getOrUndefined(await Effect.runPromise(Stream.runHead(stream)));
}

/**
 * Subscribe to `stream` and expose it as an async iterable ITERATOR — usable
 * both hand-advanced (`await sub.next()`, for a first-frame guard) and in a `for
 * await`, over the SAME subscription, so a caller that inspects the opening
 * frame and then pumps the rest opens exactly one.
 *
 * When `signal` is given, its abort unsubscribes: a parked `next()` then
 * resolves `{ done: true }` (the fiber is interrupted, and an interruption is
 * not a failure), so a `for await` ends cleanly instead of throwing — callers
 * distinguish "we tore this down" from "the feed died" by reading the signal,
 * exactly as they did when it was a call option. Omit it for a one-shot read
 * bounded by the stream itself.
 */
export function subscribe<T>(
  stream: Stream.Stream<T, unknown>,
  signal?: AbortSignal,
): AsyncIterableIterator<T> {
  const iterator = Stream.toAsyncIterable(stream)[Symbol.asyncIterator]();
  const unsubscribe = (): void => {
    void Promise.resolve(iterator.return?.()).catch(() => {});
  };
  if (signal !== undefined) {
    if (signal.aborted) unsubscribe();
    else signal.addEventListener("abort", unsubscribe, { once: true });
  }
  return {
    next: () => iterator.next(),
    // Resolve immediately rather than awaiting the close (see the header): the
    // caller is leaving, and the interrupt it just issued needs no witness.
    return: async () => {
      unsubscribe();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
