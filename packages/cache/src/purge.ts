import type { ObjectStore } from "@odu/objects";
import type { Slots } from "./slots";

export interface PurgeKeys {
  objects: ObjectStore;
  keys: Iterable<string>;
  slots: Slots;
  stop?: () => boolean;
  removed?: (key: string) => void;
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
