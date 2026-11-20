/** The wait a polling stream source does between reads.
 *
 *  Resolves on the deadline OR on the subscription's interrupt, whichever comes
 *  first, and detaches its listener either way. */
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
