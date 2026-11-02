/**
 * ONE STORE'S MEMORY, IN A PROCESS OF ITS OWN — the contract's constant-memory
 * case. Run in-process, a 300 MB read's RSS mixed the store's footprint with
 * the garbage of every test before it, and an S3 store's windows (fetch bodies
 * Bun frees at its next collection) read as growth that was only lag. A fresh
 * process measures the store and nothing else.
 *
 * `bun test/storeMemory.ts '<spec json>'` puts 300 MiB, reads it back with a
 * slow reader, and prints `{"put":<bytes>,"get":<bytes>}` of peak RSS growth.
 */
import { diskObjectStore, type ObjectStore, s3ObjectStore } from "../src/objectStore";
import type { S3Target } from "../src/s3sign";

export type StoreSpec =
  | { kind: "disk"; dir: string }
  | { kind: "s3"; target: S3Target; partSize: number };

export function storeOf(spec: StoreSpec): ObjectStore {
  return spec.kind === "disk"
    ? diskObjectStore({ dir: spec.dir })
    : s3ObjectStore({ target: spec.target, partSize: spec.partSize });
}

async function growth(work: () => Promise<void>): Promise<number> {
  Bun.gc(true);
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 10);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  return peak - baseline;
}

if (import.meta.main) {
  const store = storeOf(JSON.parse(process.argv[2] as string) as StoreSpec);
  const key = "main/nar/big.nar.zst";
  const MIB = 1024 * 1024;
  const chunk = new Uint8Array(MIB).fill(0x5a);
  let remaining = 300;
  const put = await growth(async () => {
    const outcome = await store.put(
      key,
      new ReadableStream({
        pull(controller) {
          if (remaining-- === 0) controller.close();
          else controller.enqueue(chunk);
        },
      }),
    );
    if (!outcome.ok || outcome.facts.size !== 300 * MIB) throw new Error(`put: ${JSON.stringify(outcome)}`);
  });
  // A SLOW READER, like a Nix client on a thin link: a store whose stream ran
  // ahead of its consumer (Bun's S3 body does, unwindowed) holds the object.
  const get = await growth(async () => {
    const got = await store.get(key);
    let read = 0;
    let pieces = 0;
    for await (const piece of got?.stream as unknown as AsyncIterable<Uint8Array>) {
      read += piece.length;
      if (++pieces % 32 === 0) await Bun.sleep(1);
    }
    if (read !== 300 * MIB) throw new Error(`get read ${read}`);
  });
  process.stdout.write(`${JSON.stringify({ put, get })}\n`);
}
