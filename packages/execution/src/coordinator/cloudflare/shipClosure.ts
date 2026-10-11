/**
 * No-cache provisioning: ship the runner closure to a container over the
 * odu-lane Worker, as `nix copy --to ssh-ng://` would ship it to an ssh host.
 *
 * Used when no lane cache is configured (R2 not enabled on the account, or not
 * set up yet). The container first substitutes everything the public caches
 * have — for a runner that is all of nixpkgs' part of the closure — and names
 * what is left (in practice odu's own `odu-base` tree); only that crosses the
 * wire, as gzip'd `nix-store --export`. A warm container answers "nothing
 * missing" and the step costs one round trip.
 *
 * The cache path (`laneCache.ts`) is the better steady state — every container
 * substitutes in parallel, from Cloudflare's own network, and a cold container
 * pays nothing to the coordinator's uplink — which is why this is the fallback.
 */

import { spawn } from "node:child_process";
import { createGzip } from "node:zlib";
import { captureProcess } from "../runnerFlake";
import type { CloudflareConfig } from "../../common/cloudflareConfig";
import { openLaneSocket } from "./laneSocket";

const STDERR = 0x02;
const CHUNK = 1024 * 1024;
const HIGH_WATER = 8 * 1024 * 1024;

async function drained(ws: WebSocket): Promise<void> {
  while (ws.bufferedAmount > HIGH_WATER && ws.readyState === WebSocket.OPEN) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function shipClosure(opts: {
  config: Readonly<CloudflareConfig>;
  instance: string;
  outPath: string;
  onProgress: (line: string) => void;
  signal: AbortSignal;
}): Promise<void> {
  const { stdout } = await captureProcess("nix-store", ["--query", "--requisites", opts.outPath]);
  const paths = stdout.split("\n").filter((p) => p !== "");
  const ws = openLaneSocket(opts.config, opts.instance, "import");
  const decoder = new TextDecoder();
  const t0 = Date.now();

  let resolveMissing!: (missing: string[]) => void;
  const missing = new Promise<string[]>((resolve) => {
    resolveMissing = resolve;
  });
  const done = new Promise<void>((resolve, reject) => {
    let exit: number | null | undefined;
    ws.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as ArrayBuffer | string;
      if (typeof data === "string") {
        const message = JSON.parse(data) as { missing?: string[]; exit?: number | null };
        if (message.missing !== undefined) resolveMissing(message.missing);
        if ("exit" in message) exit = message.exit ?? null;
        return;
      }
      const bytes = new Uint8Array(data);
      if (bytes[0] === STDERR) {
        for (const line of decoder.decode(bytes.subarray(1)).split("\n")) {
          if (line.trim() !== "") opts.onProgress(line.trimEnd());
        }
      }
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      if (exit === 0) resolve();
      else reject(new Error(`closure import into ${opts.instance} failed (exit ${exit ?? `none; ws ${event.code} ${event.reason}`})`));
    });
  });
  void done.catch(() => {});
  const abort = (): void => ws.close(1000, "aborted");
  opts.signal.addEventListener("abort", abort, { once: true });

  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("close", () => reject(new Error(`odu-lane /import to ${opts.instance} did not open`)), { once: true });
    });
    ws.send(JSON.stringify({ paths }));
    const toShip = await Promise.race([missing, done.then(() => [] as string[])]);
    if (toShip.length > 0) {
      opts.onProgress(`[cloudflare] shipping ${toShip.length} path(s): ${toShip.map((p) => p.slice(44)).join(", ")}`);
      const exporter = spawn("nix-store", ["--export", ...toShip], { stdio: ["ignore", "pipe", "pipe"] });
      exporter.stderr.on("data", (chunk: Buffer) => opts.onProgress(chunk.toString().trimEnd()));
      const gzip = createGzip({ level: 3 });
      exporter.stdout.pipe(gzip);
      let sent = 0;
      let lastReport = Date.now();
      for await (const chunk of gzip as AsyncIterable<Buffer>) {
        for (let offset = 0; offset < chunk.byteLength; offset += CHUNK) {
          await drained(ws);
          ws.send(chunk.subarray(offset, offset + CHUNK));
        }
        sent += chunk.byteLength;
        if (Date.now() - lastReport > 5_000) {
          lastReport = Date.now();
          opts.onProgress(`[cloudflare] shipped ${(sent / 1048576).toFixed(1)} MiB (gzip)`);
        }
      }
      await drained(ws);
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
