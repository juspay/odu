/**
 * DELETING A SET OF KEYS FROM ONE STORE — the mechanism, with no policy in it.
 *
 * Two callers delete a bucket's whole prefix: `bucket.delete`, which takes the
 * bucket away, and a finished move's `deleting` phase, which takes the OLD
 * store's copies away. They were the same loop written twice — bounded by the
 * row's slots, one `delete` per key — around two decisions that genuinely
 * differ, which is what this file separates out rather than flattens:
 *
 * - **What a failed delete means.** A copier must not stall on one key: the
 *   move is already flipped and the bucket is served from the new store, so a
 *   key that will not go is a leftover for the next sweep. A DELETE must stop:
 *   it is about to answer with the bytes it freed and then drop the rows that
 *   name them, and reporting a key it did not remove is a lie a person cannot
 *   check afterwards. So `failed` is the caller's function — throwing from it
 *   stops the purge, returning carries on — rather than a flag this file
 *   branches on.
 * - **What was removed.** Only one caller counts, and only keys the store had
 *   actually listed; `removed` is how it hears about them.
 */

import type { ObjectStore } from "@odu/objects";
import type { Slots } from "./slots";

export interface PurgeKeys {
  objects: ObjectStore;
  /** Every key to delete. Deleting an absent key is not an error in any
   *  store, so a caller may name keys it only believes are there. */
  keys: Iterable<string>;
  /** The row's own throttle — this never opens more deletes than the rest of
   *  the row's background work is allowed. */
  slots: Slots;
  /** True once the row is closing: a purge that keeps going into a closing
   *  database is a purge whose caller cannot record what it did. */
  stop?: () => boolean;
  /** One key gone. */
  removed?: (key: string) => void;
  /** One key that would not go. THROW to end the purge, return to carry on. */
  failed: (key: string, reason: unknown) => void;
}

export async function purgeKeys(input: PurgeKeys): Promise<void> {
  let failure: unknown = null;
  await Promise.all(
    [...input.keys].map((key) =>
      input.slots
        .withSlot(async () => {
          if (failure !== null || input.stop?.() === true) return;
          await input.objects.delete(key);
          input.removed?.(key);
        })
        .catch((reason: unknown) => {
          // THE CALLER DECIDES, and a throw from it is kept rather than
          // rethrown here: the remaining deletes are already in flight, and
          // the first reason is what the caller is told once they settle.
          try {
            input.failed(key, reason);
          } catch (decided) {
            failure ??= decided;
          }
        }),
    ),
  );
  if (failure !== null) throw failure;
}
