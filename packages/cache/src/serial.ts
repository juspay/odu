/**
 * ONE THING AT A TIME — a promise chain, and the only spelling of it here.
 *
 * Two places in the cache need a mutex and they need it for the same reason:
 * a decision is taken, an `await` follows, and something else must not slip in
 * between. The write lock guards `record`, `pin` and `gc` so a collection
 * cannot delete what a pin just promised to keep, nor an object a push is
 * recording; the proof queue guards one staged NAR name so a second narinfo
 * for it sees the object the first kept.
 *
 * They differ in SCOPE and in nothing else — one chain for the cache, one per
 * staged name — so the chain is here once and the keying is the caller's business.
 * A second copy of this trick is how the two would drift: one of them would
 * eventually get the "keep the chain alive on rejection" line wrong, and the
 * symptom would be a single failed PUT wedging every later one.
 */

/** A queue of work, run in order, one at a time. */
export interface Chain {
  tail: Promise<void>;
}

export function newChain(): Chain {
  return { tail: Promise.resolve() };
}

/**
 * Queue `work` behind everything already on `chain` and answer its result.
 *
 * The chain's tail is replaced with a promise that never rejects, because the
 * chain is a SCHEDULE, not a result: one failed item must not fail every item
 * queued after it. The caller still sees the real rejection through the
 * promise this returns.
 */
export function serial<T>(chain: Chain, work: () => Promise<T>): Promise<T> {
  const next = chain.tail.then(work, work);
  chain.tail = next.then(
    () => {},
    () => {},
  );
  return next;
}
