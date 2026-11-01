/**
 * THE OLD STORE, as the route suite's transition fixture.
 *
 * The cache no longer delegates bytes to a store; this fake stands only for the
 * ONE-TIME migration's source. A route test seeds a path's bytes, then asks the
 * cache for it while the row has no object yet — the legacy branch — and the
 * fake records that it was dumped.
 */
import { storePathHash } from "../src/narinfo";

export const hashOf = (storePath: string): string => storePathHash(storePath);

interface Entry {
  storePath: string;
  narHash: string;
  narSize: number;
  references: readonly string[];
  deriver?: string | null;
  sigs?: readonly string[];
  ca?: string | null;
  bytes?: Uint8Array;
  chunks?: number;
  present?: boolean;
}

export class FakeStore {
  readonly paths = new Map<string, Entry>();
  readonly calls: { op: string; storePath: string }[] = [];
  readonly present = new Set<string>();

  add(entry: Entry, present = true): Entry {
    const stored = { ...entry, present };
    this.paths.set(entry.storePath, stored);
    if (present) this.present.add(entry.storePath);
    return stored;
  }

  /** What the old store hands the migration/transition: the seeded bytes. */
  dump(storePath: string): ReadableStream<Uint8Array> {
    this.calls.push({ op: "dump", storePath });
    const entry = this.paths.get(storePath);
    if (entry === undefined) {
      return new ReadableStream({
        start(controller) {
          controller.error(new Error(`the old store has no ${storePath}`));
        },
      });
    }
    const bytes = entry.bytes ?? new Uint8Array(entry.narSize);
    const chunks = entry.chunks ?? 1;
    const size = Math.ceil(bytes.length / chunks);
    return new ReadableStream({
      start(controller) {
        for (let at = 0; at < bytes.length; at += size) {
          controller.enqueue(bytes.subarray(at, at + size));
        }
        controller.close();
      },
    });
  }
}
