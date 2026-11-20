export class SlotsClosed extends Error {
  constructor() {
    super("the fetch queue's owner closed");
  }
}

export interface Slots {
  withSlot<T>(work: () => Promise<T>): Promise<T>;
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
