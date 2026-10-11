/**
 * The `odu-lane` Worker: odu's door into Cloudflare Containers.
 *
 * Deployed to the operator's own account by `odu cloudflare setup`, which
 * generates the wrangler config (container image, instance type, R2 binding)
 * and puts the bearer secret. Nothing here is per-project.
 *
 *   /lane/<instance>/start    POST  start the container, streaming progress until :8080 answers
 *   /lane/<instance>/agent    WS    one dial: the bridge spawns `odu-runner --stdio` and splices it
 *   /lane/<instance>/import   WS    no-cache provisioning: ship missing closure paths as a NAR stream
 *   /lane/<instance>/state    GET   {running} without starting anything (cheap probes)
 *   /lane/<instance>/destroy  POST  SIGKILL the container (next dial cold-starts it)
 *   /nix-cache/<key>          GET/HEAD/PUT  the R2 bucket as a Nix binary cache
 *   /nix-cache-purge          POST  empty the bucket (teardown)
 *   /healthz                  GET   unauthenticated liveness
 *
 * One Durable Object — and so one container — per `<instance>` (suffixed with
 * CODE_VERSION, below), which is the
 * part of the hosts.json spelling after `cloudflare:` (`cloudflare` alone is
 * `default`). A WebSocket proxied through the DO's `containerFetch` counts as an
 * in-flight request, and each message renews the activity timer, so a lane that
 * is talking (Effect RPC pings every 5 s) is never put to sleep under a running
 * recipe; `sleepAfter` reaps a container nobody has dialled for a while.
 *
 * Typechecked by wrangler's esbuild, not by odu's root tsconfig (which has no
 * Workers runtime types) — see the root tsconfig's `exclude`.
 */

import { Container, getContainer } from "@cloudflare/containers";
import { authorized, nixCache, purgeCache } from "./http";
// Embedded as text via the wrangler `rules` that `odu cloudflare setup` writes.
// @ts-ignore -- text module
import bridgeSource from "./bridge.ts";
// @ts-ignore -- text module
import entrypointSource from "./entrypoint.sh";

/** bash inside docker.io/nixos/nix:2.35.2-amd64 (the image's own Cmd) — the
 *  image has no /bin/bash, so the entrypoint override names it absolutely. */
const BASH =
  "/nix/store/0641h8qfqaxnwrsw2nzrz6i1wbzyx92l-bash-interactive-5.3p9/bin/bash";
const PORT = 8080;

/** A short hash of what the container runs. A redeploy does not restart a
 *  running container (its entrypoint and env were fixed at start), so the
 *  Durable Object name carries this: new bridge/entrypoint code → new
 *  containers, and the old ones simply reach `sleepAfter`. */
const CODE_VERSION = (() => {
  let h = 0x811c9dc5;
  for (const c of `${bridgeSource as string}\0${entrypointSource as string}`) {
    h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  }
  return h.toString(36);
})();

interface Env {
  LANE: DurableObjectNamespace<OduLane>;
  /** Absent when R2 is not enabled on the account: lanes then provision over
   *  /import instead of a cache. */
  CACHE?: R2Bucket;
  /** Bearer for every route but /healthz; also the netrc password the
   *  container and the coordinator present to /nix-cache. */
  ODU_LANE_SECRET: string;
  /** Pinned bun store path (odu's own), realised by the entrypoint. */
  ODU_LANE_BUN: string;
  /** Pinned tini store path: the container's init. */
  ODU_LANE_TINI: string;
  /** Public key the coordinator signs lane-cache uploads with. */
  ODU_LANE_CACHE_PUBLIC_KEY: string;
  /** Space-separated substituter URL that REPLACES the Worker-proxied cache
   *  (e.g. an `s3://…r2.cloudflarestorage.com` URL); empty = use /nix-cache. */
  ODU_LANE_CACHE_URL?: string;
  /** Space-separated extra substituters/keys (odu's own OSS cache). */
  ODU_LANE_EXTRA_SUBSTITUTERS: string;
  ODU_LANE_EXTRA_TRUSTED_KEYS: string;
  /** Optional R2 S3 read credentials when ODU_LANE_CACHE_URL is s3://. */
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  /** Optional GitHub token (`odu cloudflare setup --github-token`): lets the
   *  runner fetch private origins and Nix reach api.github.com without the
   *  shared-egress rate limit. Written to root-only files by the entrypoint,
   *  never left in the environment. */
  GITHUB_TOKEN?: string;
}

export class OduLane extends Container<Env> {
  override defaultPort = PORT;
  override sleepAfter = "10m";
  override entrypoint = [BASH, "-c", entrypointSource as string];

  /** Per-start env. Derived at dial time because the Worker learns its own
   *  public origin from the request — setup never has to know it in advance. */
  private laneEnv(origin: string): Record<string, string> {
    // No bucket bound (R2 not enabled) → no lane cache at all; the closure
    // arrives over /import instead. Listing a cache that answers 503 would
    // cost every substitution Nix's full retry backoff.
    const cacheUrl =
      this.env.ODU_LANE_CACHE_URL !== undefined && this.env.ODU_LANE_CACHE_URL !== ""
        ? this.env.ODU_LANE_CACHE_URL
        : this.env.CACHE !== undefined
          ? `${origin}/nix-cache`
          : "";
    const host = new URL(origin).hostname;
    const env: Record<string, string> = {
      ODU_LANE_BUN: this.env.ODU_LANE_BUN,
      ODU_LANE_TINI: this.env.ODU_LANE_TINI,
      ODU_LANE_BRIDGE: bridgeSource as string,
      ODU_LANE_SUBSTITUTERS: `${cacheUrl} ${this.env.ODU_LANE_EXTRA_SUBSTITUTERS}`.trim(),
      ODU_LANE_TRUSTED_KEYS:
        `${this.env.ODU_LANE_CACHE_PUBLIC_KEY} ${this.env.ODU_LANE_EXTRA_TRUSTED_KEYS}`.trim(),
      ODU_LANE_NETRC: `machine ${host} login odu password ${this.env.ODU_LANE_SECRET}`,
    };
    if (this.env.AWS_ACCESS_KEY_ID) env.AWS_ACCESS_KEY_ID = this.env.AWS_ACCESS_KEY_ID;
    if (this.env.AWS_SECRET_ACCESS_KEY) env.AWS_SECRET_ACCESS_KEY = this.env.AWS_SECRET_ACCESS_KEY;
    if (this.env.GITHUB_TOKEN) env.ODU_LANE_GITHUB_TOKEN = this.env.GITHUB_TOKEN;
    return env;
  }

  private async ensureStarted(origin: string): Promise<void> {
    await this.startAndWaitForPorts({
      ports: PORT,
      startOptions: { envVars: this.laneEnv(origin) },
      // A cold container realises bun before the port opens; the default 20 s
      // readiness wait is far too short (measured: minutes on a cold image).
      cancellationOptions: { instanceGetTimeoutMS: 120_000, portReadyTimeoutMS: 600_000 },
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split("/")[3];
    if (action === "destroy") {
      await this.destroy();
      return new Response("destroyed\n");
    }
    if (action === "start") return this.streamStart(url.origin);
    if (action === "state") {
      // Answered by the Durable Object alone — it never starts a container,
      // so `odu hosts` and pool probes cost nothing on an idle instance. A
      // running one is asked about KVM (one local request, no boot).
      const running = this.ctx.container?.running === true;
      const health = running ? await this.health() : null;
      return Response.json({ running, kvm: health?.kvm ?? null, disk: health?.disk ?? null, version: CODE_VERSION });
    }
    if (action === "agent" || action === "import") {
      await this.ensureStarted(url.origin);
      return this.containerFetch(request, PORT);
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
  private streamStart(origin: string): Response {
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
          await this.ensureStarted(origin);
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

  override onStart(): void {
    console.log("odu-lane container started");
  }
  override onStop(params: unknown): void {
    console.log("odu-lane container stopped", JSON.stringify(params));
  }
  override onError(error: unknown): unknown {
    console.log("odu-lane container error", String(error));
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok\n");
    if (!authorized(request, env.ODU_LANE_SECRET)) {
      return new Response("unauthorized\n", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="odu-lane"' },
      });
    }
    if (url.pathname === "/nix-cache-purge" && request.method === "POST") return purgeCache(env.CACHE);
    if (url.pathname.startsWith("/nix-cache/")) {
      return nixCache(request, env.CACHE, url.pathname.slice("/nix-cache/".length));
    }
    const lane = /^\/lane\/([A-Za-z0-9_-]{1,64})\/(start|state|agent|import|destroy)$/.exec(url.pathname);
    if (lane !== null) {
      return getContainer(env.LANE, `${lane[1]}-${CODE_VERSION}`).fetch(request);
    }
    return new Response("not found\n", { status: 404 });
  },
};
