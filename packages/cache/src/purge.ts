import type { ObjectStore } from "@odu/objects";
import type { Slots } from "./slots";

export interface PurgeKeys {
  objects: ObjectStore;
  keys: Iterable<string>;
  slots: Slots;
  stop?: () => boolean;
  removed?: (key: string) => void;
  failed: (key: string, reason: unknown) => "stop" | "continue";
}

export async function purgeKeys(input: PurgeKeys): Promise<void> {
  let failure: unknown = null;
  let stopped = false;
  await Promise.all(
    [...input.keys].map((key) =>
      input.slots
        .withSlot(async () => {
          if (stopped || input.stop?.() === true) return;
          await input.objects.delete(key);
          input.removed?.(key);
        })
        .catch((reason: unknown) => {
          if (input.failed(key, reason) === "continue") return;
          stopped = true;
          failure ??= reason;
        }),
    ),
  );
  if (failure !== null) throw failure;
}
