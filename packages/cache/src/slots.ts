/**
 * A BOUNDED SET OF SLOTS, OWNED BY WHOEVER CREATED IT.
 *
 * The cache row creates one per activation and closes it with the row. It is
 * NOT module state: two caches in one process have two bounds, and a job left
 * waiting on a closed row's queue is refused rather than resumed after the
 * row's lifetime.
 */

/** The refusal a queued job gets when its owner closed. */
export class SlotsClosed extends Error {
  constructor() {
    super("the fetch queue's owner closed");
  }
}

export interface Slots {
  /** Run `work` in a slot. Once the owner closes, every waiter is refused and
   *  no new job starts. */
  withSlot<T>(work: () => Promise<T>): Promise<T>;
  /** Refuse everything still waiting. A job already running is not stopped —
   *  the owner joins it through its own queue. */
  close(): void;
}

export function createSlots(limit: number): Slots {
  let running = 0;
  let closed = false;
  const waiters: { resolve: () => void; reject: (reason: SlotsClosed) => void }[] = [];

  return {
    async withSlot<T>(work: () => Promise<T>): Promise<T> {
      if (closed) throw new SlotsClosed();
      if (running >= limit) {
        await new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
      } else {
        running += 1;
      }
      try {
        if (closed) throw new SlotsClosed();
        return await work();
      } finally {
        const next = waiters.shift();
        if (next === undefined) running -= 1;
        else next.resolve();
      }
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter.reject(new SlotsClosed());
    },
  };
}
