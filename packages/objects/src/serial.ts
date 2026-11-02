/**
 * ONE THING AT A TIME — a promise chain: the S3 store's per-key write queue.
 *
 * A copy of `@odu/cache`'s, not an import of it: this package is below the
 * cache and borrows nothing from it. Twelve lines, and the one line that
 * matters is the same in both: the tail never rejects, so one failed put does
 * not wedge every later put of its key.
 */

/** A queue of work, run in order, one at a time. */
export interface Chain {
  tail: Promise<void>;
}

export function newChain(): Chain {
  return { tail: Promise.resolve() };
}

/** Queue `work` behind everything already on `chain` and answer its result.
 *  The chain is a SCHEDULE, not a result: its tail never rejects. */
export function serial<T>(chain: Chain, work: () => Promise<T>): Promise<T> {
  const next = chain.tail.then(work, work);
  chain.tail = next.then(
    () => {},
    () => {},
  );
  return next;
}
