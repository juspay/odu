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
 *   /lane/<instance>/destroy  POST  SIGKILL the container (next dial cold-starts it)
 *   /nix-cache/<key>          GET/HEAD/PUT  the R2 bucket as a Nix binary cache
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
  /** Optional GitHub token for private origins / api.github.com (TODO). */
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
      ODU_LANE_BRIDGE: bridgeSource as string,
      ODU_LANE_SUBSTITUTERS: `${cacheUrl} ${this.env.ODU_LANE_EXTRA_SUBSTITUTERS}`.trim(),
      ODU_LANE_TRUSTED_KEYS:
        `${this.env.ODU_LANE_CACHE_PUBLIC_KEY} ${this.env.ODU_LANE_EXTRA_TRUSTED_KEYS}`.trim(),
      ODU_LANE_NETRC: `machine ${host} login odu password ${this.env.ODU_LANE_SECRET}`,
    };
    if (this.env.AWS_ACCESS_KEY_ID) env.AWS_ACCESS_KEY_ID = this.env.AWS_ACCESS_KEY_ID;
    if (this.env.AWS_SECRET_ACCESS_KEY) env.AWS_SECRET_ACCESS_KEY = this.env.AWS_SECRET_ACCESS_KEY;
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
    if (action === "agent" || action === "import") {
      await this.ensureStarted(url.origin);
      return this.containerFetch(request, PORT);
    }
    return new Response("not found\n", { status: 404 });
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
          await writer.write(enc.encode(`ready (${was}, ${Math.round((Date.now() - t0) / 1000)}s)\n`));
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

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.byteLength !== eb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ea, eb);
}

/** Bearer (coordinator) or Basic with the secret as password (Nix's netrc). */
function authorized(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) return timingSafeEqual(header.slice(7), secret);
  if (header.startsWith("Basic ")) {
    let decoded = "";
    try {
      decoded = atob(header.slice(6));
    } catch {
      return false;
    }
    return timingSafeEqual(decoded.slice(decoded.indexOf(":") + 1), secret);
  }
  return false;
}

const NIX_CACHE_INFO = "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 20\n";

/** The R2 bucket as a Nix HTTP binary cache — read by containers, written by
 *  the coordinator's `nix copy --to https://…/nix-cache`. Through the Worker's
 *  own binding, so neither side needs R2 S3 credentials. */
async function nixCache(request: Request, env: Env, key: string): Promise<Response> {
  const bucket = env.CACHE;
  if (bucket === undefined) return new Response("no R2 bucket bound\n", { status: 503 });
  if (key === "nix-cache-info") {
    return request.method === "PUT"
      ? new Response(null, { status: 204 })
      : new Response(request.method === "HEAD" ? null : NIX_CACHE_INFO, {
          headers: { "content-type": "text/x-nix-cache-info" },
        });
  }
  if (key === "" || key.includes("..")) return new Response("bad key\n", { status: 400 });
  switch (request.method) {
    case "GET": {
      const object = await bucket.get(key);
      if (object === null) return new Response("not found\n", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("content-length", String(object.size));
      return new Response(object.body, { headers });
    }
    case "HEAD": {
      const object = await bucket.head(key);
      if (object === null) return new Response(null, { status: 404 });
      return new Response(null, { headers: { "content-length": String(object.size) } });
    }
    case "PUT": {
      const length = request.headers.get("content-length");
      if (length === null) return new Response("content-length required\n", { status: 411 });
      const contentType = request.headers.get("content-type") ?? "application/octet-stream";
      // A known-length body streams straight into R2.
      const body = request.body ?? new Uint8Array();
      await bucket.put(key, body, { httpMetadata: { contentType } });
      return new Response(null, { status: 201 });
    }
    default:
      return new Response("method not allowed\n", { status: 405 });
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
    if (url.pathname.startsWith("/nix-cache/")) {
      return nixCache(request, env, url.pathname.slice("/nix-cache/".length));
    }
    const lane = /^\/lane\/([A-Za-z0-9_-]{1,64})\/(start|agent|import|destroy)$/.exec(url.pathname);
    if (lane !== null) {
      return getContainer(env.LANE, `${lane[1]}-${CODE_VERSION}`).fetch(request);
    }
    return new Response("not found\n", { status: 404 });
  },
};
