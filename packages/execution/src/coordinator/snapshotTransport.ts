import { open } from "node:fs/promises";
import type { LaneClient } from "../common/laneSurface";
import { runUnary } from "../common/effectEdge";

export interface LaneSnapshot {
  commit: string;
  requires: string[];
  bundlePath: string | null;
  bytes: number;
}
const CHUNK_BYTES = 2 * 1024 * 1024;
/** Called only after the cheap first nodes frame satisfies the watchdog. */
export async function uploadSnapshot(
  client: LaneClient["surface"],
  snapshot: LaneSnapshot,
  origin: string,
  host: string,
  output: (line: string) => void,
): Promise<boolean> {
  if (snapshot.bundlePath === null) return false;
  const { present } = await runUnary(
    client.snapshot.has({ origin, commit: snapshot.commit }),
  );
  if (present) {
    output(`[odu] snapshot ${snapshot.commit.slice(0, 7)} already on ${host}`);
    return false;
  }
  output(
    `[odu] uploading snapshot ${snapshot.commit.slice(0, 7)} (${snapshot.bytes} bytes, ${Math.ceil(snapshot.bytes / CHUNK_BYTES)} chunks)`,
  );
  const file = await open(snapshot.bundlePath, "r");
  try {
    let offset = 0;
    const buffer = Buffer.alloc(CHUNK_BYTES);
    while (offset < snapshot.bytes) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(CHUNK_BYTES, snapshot.bytes - offset),
        offset,
      );
      if (bytesRead === 0) throw new Error("snapshot bundle ended early");
      const ack = await runUnary(
        client.snapshot.put({
          commit: snapshot.commit,
          offset,
          total: snapshot.bytes,
          data: buffer.subarray(0, bytesRead).toString("base64"),
        }),
      );
      if (!ack.ok || ack.received !== offset + bytesRead)
        throw new Error(ack.error ?? "snapshot upload offset mismatch");
      offset += bytesRead;
    }
  } finally {
    await file.close();
  }
  output(`[odu] snapshot ${snapshot.commit.slice(0, 7)} uploaded`);
  return true;
}
