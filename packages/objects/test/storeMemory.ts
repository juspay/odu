/**
 * `bun test/storeMemory.ts '<spec json>'` puts 300 MiB, reads it back with a
 * slow reader, and prints `{"put":<bytes>,"get":<bytes>}` of peak RSS growth.
 */
import { diskObjectStore } from "../src/diskStore";
import type { ObjectStore } from "../src/objectStore";
import { s3ObjectStore } from "../src/s3Store";
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
  const spec = JSON.parse(process.argv[2] as string) as StoreSpec;
  // A URL crosses the argument as its href; the target holds it parsed.
  const store = storeOf(
    spec.kind === "s3" ? { ...spec, target: { ...spec.target, endpoint: new URL(spec.target.endpoint) } } : spec,
  );
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
