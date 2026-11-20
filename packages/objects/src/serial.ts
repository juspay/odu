export interface Chain {
  tail: Promise<void>;
}

export function newChain(): Chain {
  return { tail: Promise.resolve() };
}

export function serial<T>(chain: Chain, work: () => Promise<T>): Promise<T> {
  const next = chain.tail.then(work, work);
  chain.tail = next.then(
    () => {},
    () => {},
  );
  return next;
}
