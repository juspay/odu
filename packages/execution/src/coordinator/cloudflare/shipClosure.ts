/**
 * No-cache provisioning: ship the runner closure to a container over the
 * odu-lane Worker, as `nix copy --to ssh-ng://` would ship it to an ssh host.
 *
 * Used when no lane cache is configured (`odu cloudflare setup --no-cache`, or
 * R2 not enabled on the account). The container first substitutes everything
 * the public caches have — for a runner that is 112 of its 114 paths — and
 * names what is left (odu's own `odu-base` tree and the wrapper); only that
 * crosses the wire, as gzip'd `nix-store --export`. A warm container answers
 * "nothing missing" in one round trip.
 *
 * Measured (standard-4, from a residential uplink): 6.1 s substitution, 51.9
 * MiB gzip shipped in ~4 s. The lane cache (`laneCache.ts`) is the better
 * steady state — containers substitute from Cloudflare's own network and a
 * cold container costs the coordinator's uplink nothing — hence fallback.
 *
 * Flow control is credit-based: the bridge acks bytes it has handed to
 * `nix-store --import`, and we keep at most IN_FLIGHT unacknowledged, so a
 * slow import backs up into `nix-store --export` here instead of into memory
 * on either side.
 */

import { spawn } from "node:child_process";
import { createGzip } from "node:zlib";
import type { CloudflareConfig } from "../../common/cloudflareConfig";
import { captureProcess } from "../runnerFlake";
import { lineSplitter, openLaneSocket } from "./workerApi";

const STDERR = 0x02;
const CHUNK = 1024 * 1024;
const IN_FLIGHT = 16 * 1024 * 1024;

export async function shipClosure(opts: {
  config: Readonly<CloudflareConfig>;
  instance: string;
  outPath: string;
  onProgress: (line: string) => void;
  signal: AbortSignal;
}): Promise<void> {
  const { stdout } = await captureProcess("nix-store", ["--query", "--requisites", opts.outPath]);
  const paths = stdout.split("\n").filter((p) => p !== "");
  const ws = await openLaneSocket({ config: opts.config, instance: opts.instance, action: "import", signal: opts.signal });
  const t0 = Date.now();
  const progress = lineSplitter(opts.onProgress);

  let acked = 0;
  let wakeSender: (() => void) | null = null;
  let resolveMissing!: (missing: string[]) => void;
  const missing = new Promise<string[]>((resolve) => {
    resolveMissing = resolve;
  });
  let exit: number | null | undefined;
  const done = new Promise<void>((resolve, reject) => {
    ws.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as ArrayBuffer | string;
      if (typeof data === "string") {
        const message = JSON.parse(data) as { missing?: string[]; ack?: number; exit?: number | null };
        if (message.missing !== undefined) resolveMissing(message.missing);
        if (message.ack !== undefined) {
          acked = message.ack;
          wakeSender?.();
        }
        if ("exit" in message) exit = message.exit ?? null;
        return;
      }
      const bytes = new Uint8Array(data);
      if (bytes[0] === STDERR) progress(bytes.subarray(1));
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      wakeSender?.();
      if (exit === 0) resolve();
      else reject(new Error(`closure import into ${opts.instance} failed (exit ${exit ?? `none; WebSocket ${event.code} ${event.reason}`})`));
    });
  });
  void done.catch(() => {});
  const abort = (): void => ws.close(1000, "aborted");
  opts.signal.addEventListener("abort", abort, { once: true });

  try {
    ws.send(JSON.stringify({ paths }));
    const toShip = await Promise.race([missing, done.then(() => [] as string[])]);
    if (toShip.length > 0) {
      opts.onProgress(`[cloudflare] shipping ${toShip.length} path(s): ${toShip.map((p) => p.slice(44)).join(", ")}`);
      const exporter = spawn("nix-store", ["--export", ...toShip], { stdio: ["ignore", "pipe", "pipe"] });
      exporter.stderr.on("data", (chunk: Buffer) => progress(chunk));
      const gzip = createGzip({ level: 3 });
      exporter.stdout.pipe(gzip);
      let sent = 0;
      let lastReport = Date.now();
      for await (const chunk of gzip as AsyncIterable<Buffer>) {
        for (let offset = 0; offset < chunk.byteLength; offset += CHUNK) {
          while (sent - acked > IN_FLIGHT && ws.readyState === WebSocket.OPEN) {
            await new Promise<void>((resolve) => {
              wakeSender = resolve;
            });
            wakeSender = null;
          }
          if (ws.readyState !== WebSocket.OPEN) {
            exporter.kill();
            await done; // rejects with the bridge's reason
          }
          const piece = chunk.subarray(offset, offset + CHUNK);
          ws.send(piece);
          sent += piece.byteLength;
        }
        if (Date.now() - lastReport > 5_000) {
          lastReport = Date.now();
          opts.onProgress(`[cloudflare] shipped ${(sent / 1048576).toFixed(1)} MiB (gzip)`);
        }
      }
      ws.send(JSON.stringify({ done: true }));
      opts.onProgress(`[cloudflare] shipped ${(sent / 1048576).toFixed(1)} MiB (gzip) in ${((Date.now() - t0) / 1000).toFixed(1)}s; importing`);
    }
    await done;
    opts.onProgress(`[cloudflare] closure present in ${opts.instance} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    opts.signal.removeEventListener("abort", abort);
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, "done");
  }
}
