/**
 * odu-lane's DATA PLANE: the Durable Object that owns one container per lane
 * instance, deployed as its own Worker script (`odu-lane-dp`).
 *
 * Split from the control plane (worker.ts) because a new version of a script
 * evicts its Durable Objects, and every attached lane's WebSocket runs through
 * one — measured: dropped ~5 min after any deploy, a `secret put` included.
 * This script therefore holds nothing that changes with configuration: no
 * secret, no cache URL, no binding but its own namespace. The control plane
 * sends the container's start env with each request (START_ENV_HEADER), so
 * `odu cloudflare setup`, secret rotation and cache changes deploy only the
 * control plane, and attached lanes ride through. This script changes only
 * when the code a container runs changes (this file, bridge.ts,
 * entrypoint.sh, the image, the instance type, max_instances).
 *
 * Not publicly routable: `workers_dev` is off and its own fetch handler
 * answers 404. Only the control plane's Durable Object binding reaches it.
 */

import { Container } from "@cloudflare/containers";
import { chunkEnv } from "./http";
// Embedded as text via the wrangler `rules` that `odu cloudflare setup` writes.
// @ts-ignore -- text module
import bridgeSource from "./bridge.ts";
// @ts-ignore -- text module
import entrypointSource from "./entrypoint.sh";

/** Request header carrying the container's start env from the control plane:
 *  base64 of a JSON object of strings. */
export const START_ENV_HEADER = "x-odu-lane-start-env";

/** bash inside docker.io/nixos/nix:2.35.2-amd64 (the image's own Cmd) — the
 *  image has no /bin/bash, so the entrypoint override names it absolutely. */
const BASH =
  "/nix/store/0641h8qfqaxnwrsw2nzrz6i1wbzyx92l-bash-interactive-5.3p9/bin/bash";
const PORT = 8080;

/** Cloudflare caps a container env var at 16,000 bytes, and bridge.ts is past
 *  it as plain text. Shipped gzip'd and base64'd, split across numbered vars
 *  (`chunkEnv`), and reassembled and decoded by the entrypoint with the
 *  pinned bun — so the bridge's size has no ceiling. */
let bridgeGz: Promise<string> | undefined;
function bridgeEncoded(): Promise<string> {
  bridgeGz ??= (async () => {
    const gz = new Blob([bridgeSource as string]).stream().pipeThrough(new CompressionStream("gzip"));
    const bytes = new Uint8Array(await new Response(gz).arrayBuffer());
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  })();
  return bridgeGz;
}

/** A short hash of what the container runs, reported by /state. */
const CODE_VERSION = (() => {
  let h = 0x811c9dc5;
  for (const c of `${bridgeSource as string}\0${entrypointSource as string}`) {
    h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  }
  return h.toString(36);
})();

/** One lifecycle fact, kept in the Durable Object's own storage so that a
 *  lane that dropped can be explained afterwards (`/state`), without the
 *  Worker logs: when this object started (a restart means Cloudflare reset
 *  or moved it, or a deploy evicted it), and when the container started,
 *  stopped (with its exit code) or errored. */
export interface LaneEvent {
  t: number;
  kind: "object-start" | "container-start" | "container-stop" | "container-error";
  exitCode?: number;
  reason?: string;
  message?: string;
}
const JOURNAL_KEY = "odu-lane-journal";
const JOURNAL_LIMIT = 40;

export class OduLaneContainer extends Container {
  override defaultPort = PORT;
  override sleepAfter = "10m";
  override entrypoint = [BASH, "-c", entrypointSource as string];
  private objectStartRecorded = false;

  private async record(event: Omit<LaneEvent, "t">): Promise<void> {
    try {
      const journal = ((await this.ctx.storage.get<LaneEvent[]>(JOURNAL_KEY)) ?? []).slice(-(JOURNAL_LIMIT - 1));
      journal.push({ t: Date.now(), ...event });
      await this.ctx.storage.put(JOURNAL_KEY, journal);
    } catch (error) {
      console.log("odu-lane journal write failed", error instanceof Error ? error.message : String(error));
    }
  }

  /** The container's start env, handed over by the control plane with each
   *  request (worker.ts). This script holds no secret and no configuration,
   *  so changing either never redeploys it — and never drops a lane. */
  private async startEnv(request: Request): Promise<Record<string, string>> {
    const raw = request.headers.get(START_ENV_HEADER);
    const env = raw === null ? {} : (JSON.parse(atob(raw)) as Record<string, string>);
    return { ...env, ...chunkEnv("ODU_LANE_BRIDGE_GZ", await bridgeEncoded()) };
  }

  private async ensureStarted(envVars: Record<string, string>): Promise<void> {
    await this.startAndWaitForPorts({
      ports: PORT,
      startOptions: { envVars },
      // A cold container realises bun before the port opens; the default 20 s
      // readiness wait is far too short (measured: minutes on a cold image).
      cancellationOptions: { instanceGetTimeoutMS: 120_000, portReadyTimeoutMS: 600_000 },
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (!this.objectStartRecorded) {
      this.objectStartRecorded = true;
      await this.record({ kind: "object-start" });
    }
    const url = new URL(request.url);
    const action = url.pathname.split("/")[3];
    if (action === "destroy") {
      await this.destroy();
      return new Response("destroyed\n");
    }
    if (action === "start") return this.streamStart(await this.startEnv(request));
    if (action === "state") {
      // Answered by the Durable Object alone — it never starts a container,
      // so `odu hosts` and pool probes cost nothing on an idle instance. A
      // running one is asked about KVM (one local request, no boot).
      const running = this.ctx.container?.running === true;
      const health = running ? await this.health() : null;
      const journal = (await this.ctx.storage.get<LaneEvent[]>(JOURNAL_KEY)) ?? [];
      return Response.json({ running, kvm: health?.kvm ?? null, disk: health?.disk ?? null, version: CODE_VERSION, journal });
    }
    if (action === "agent" || action === "import") {
      await this.ensureStarted(await this.startEnv(request));
      // The bridge never sees the start env (it carries secrets).
      const headers = new Headers(request.headers);
      headers.delete(START_ENV_HEADER);
      return this.containerFetch(new Request(request, { headers }), PORT);
    }
    return new Response("not found\n", { status: 404 });
  }

  /** The bridge's live view of the container; null when it cannot be asked. */
  private async health(): Promise<{ kvm: boolean; disk: unknown } | null> {
    try {
      const response = await this.containerFetch("http://container/healthz", {}, PORT);
      const body = (await response.json()) as { kvm?: unknown; disk?: unknown };
      return { kvm: body.kvm === true, disk: body.disk ?? null };
    } catch {
      return null;
    }
  }

  private async kvm(): Promise<boolean | null> {
    return (await this.health())?.kvm ?? null;
  }

  /** Start the container, narrating the wait. The coordinator reads this
   *  before it opens the agent WebSocket, so a cold start shows up as
   *  progress in `_ci-setup` instead of as one silent multi-minute upgrade. */
  private streamStart(envVars: Record<string, string>): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const t0 = Date.now();
    const was = this.ctx.container?.running === true ? "warm" : "cold";
    void writer.write(enc.encode(`container ${was}; starting\n`));
    const tick = setInterval(() => {
      void writer.write(enc.encode(`waiting for container (${Math.round((Date.now() - t0) / 1000)}s)\n`));
    }, 10_000);
    this.ctx.waitUntil(
      (async () => {
        try {
          await this.ensureStarted(envVars);
          const kvm = await this.kvm();
          if (kvm !== true) {
            // The entrypoint exits without KVM, so this is a lost race or a
            // regression — never a lane to hand out.
            await writer.write(enc.encode(`error: KVM is not usable in this container (kvm=${kvm}) — refusing the lane\n`));
            return;
          }
          await writer.write(enc.encode(`ready (${was}, ${Math.round((Date.now() - t0) / 1000)}s, KVM)\n`));
        } catch (error) {
          await writer.write(enc.encode(`error: ${(error as Error).message}\n`));
        } finally {
          clearInterval(tick);
          await writer.close();
        }
      })(),
    );
    return new Response(readable, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  override async onStart(): Promise<void> {
    console.log("odu-lane container started");
    await this.record({ kind: "container-start" });
  }
  override async onStop(params: { exitCode: number; reason: string }): Promise<void> {
    console.log("odu-lane container stopped", JSON.stringify(params));
    await this.record({ kind: "container-stop", exitCode: params.exitCode, reason: params.reason });
  }
  override onError(error: unknown): unknown {
    // Logged and returned, never rethrown: a throw here breaks the Durable
    // Object's in-flight request, so /start ended mid-stream with no verdict
    // instead of reporting the error (measured, when the bridge outgrew the
    // env limit below).
    const message = error instanceof Error ? error.message : String(error);
    console.log("odu-lane container error", message);
    this.ctx.waitUntil(this.record({ kind: "container-error", message }));
    return error;
  }
}

export default {
  fetch(): Response {
    return new Response("not found\n", { status: 404 });
  },
};
