export interface SingleOwnerSlot<T> {
  /** The installed value, or `null` when nothing holds the slot. */
  held(): T | null;
  /** Install. Returns the withdrawal that empties the slot only while THIS
   *  claim still holds it; throws the refusal when one already does. */
  claim(value: T): () => void;
}

export function singleOwnerSlot<T>(refuse: () => Error): SingleOwnerSlot<T> {
  let holder: { readonly value: T } | null = null;
  return {
    held: () => holder?.value ?? null,
    claim(value) {
      if (holder !== null) throw refuse();
      const mine = { value };
      holder = mine;
      return () => {
        if (holder === mine) holder = null;
      };
    },
  };
}
