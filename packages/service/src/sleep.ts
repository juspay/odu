import { Effect } from "effect";

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = (): void => {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  if (signal.aborted) done();
  else signal.addEventListener("abort", done, { once: true });
  return promise;
}

export function interruptiblePoll<A>(
  poll: (signal: AbortSignal) => Promise<A>,
  outer?: AbortSignal,
): Effect.Effect<A> {
  return Effect.callback<A>((resume) => {
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    if (outer !== undefined) {
      if (outer.aborted) stop();
      else outer.addEventListener("abort", stop, { once: true });
    }
    void poll(controller.signal).then(
      (value) => resume(Effect.succeed(value)),
      (err: unknown) => resume(Effect.die(err)),
    );
    return Effect.sync(() => {
      controller.abort();
      outer?.removeEventListener("abort", stop);
    });
  });
}
