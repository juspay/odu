/**
 * odu-lane's CONTROL PLANE: the public `odu-lane` Worker.
 *
 * Deployed to the operator's own account by `odu cloudflare setup`. It
 * authenticates every request, serves the R2 bucket as the lane's Nix binary
 * cache, and routes lane requests to the data plane (dataPlane.ts, the
 * `odu-lane-dp` script) with the container's start env attached. Everything
 * that changes with configuration lives here, so redeploying it — setup,
 * a secret, the cache — never touches an attached lane.
 *
 *   /lane/<instance>/start    POST  start the container, streaming progress until :8080 answers
 *   /lane/<instance>/state    GET   {running, kvm, disk} without starting anything (cheap probes)
 *   /lane/<instance>/agent    WS    one dial: the bridge spawns `odu-runner --stdio` and splices it
 *   /lane/<instance>/import   WS    no-cache provisioning: ship missing closure paths as a NAR stream
 *   /lane/<instance>/destroy  POST  SIGKILL the container (next dial cold-starts it)
 *   /nix-cache/<key>          GET/HEAD/PUT  the R2 bucket as a Nix binary cache
 *   /nix-cache-purge          POST  empty the bucket (teardown)
 *   /healthz                  GET   unauthenticated liveness
 *
 * One Durable Object — one container — per `<instance>`, suffixed with the
 * data plane's version so new container code always gets fresh containers.
 *
 * Typechecked by wrangler's esbuild, not by odu's root tsconfig (which has no
 * Workers runtime types) — see the root tsconfig's `exclude`.
 */

import { getContainer } from "@cloudflare/containers";
import { authorized, nixCache, purgeCache } from "./http";

/** Must equal dataPlane.ts's START_ENV_HEADER (not imported: importing it
 *  would bundle the data plane, and its text modules, into this script). */
const START_ENV_HEADER = "x-odu-lane-start-env";

interface Env {
  LANE: DurableObjectNamespace;
  /** Absent when R2 is not enabled on the account: lanes then provision over
   *  /import instead of a cache. */
  CACHE?: R2Bucket;
  /** Bearer for every route but /healthz; also the netrc password the
   *  container and the coordinator present to /nix-cache. */
  ODU_LANE_SECRET: string;
  /** The data plane's deploy fingerprint, set by setup: part of every
   *  Durable Object name. */
  ODU_LANE_DP_VERSION: string;
  /** Pinned bun store path (odu's own), realised by the entrypoint. */
  ODU_LANE_BUN: string;
  /** Pinned tini store path: the container's init. */
  ODU_LANE_TINI: string;
  /** Space-separated store paths whose bin/ joins the runner's PATH. */
  ODU_LANE_BASE: string;
  /** Public key the coordinator signs lane-cache uploads with. */
  ODU_LANE_CACHE_PUBLIC_KEY: string;
  /** A substituter URL that REPLACES the Worker-proxied cache (an
   *  `s3://…r2.cloudflarestorage.com` URL); empty = use /nix-cache. */
  ODU_LANE_CACHE_URL?: string;
  /** Space-separated extra substituters/keys (odu's own OSS cache). */
  ODU_LANE_EXTRA_SUBSTITUTERS: string;
  ODU_LANE_EXTRA_TRUSTED_KEYS: string;
  /** R2 S3 read credentials when ODU_LANE_CACHE_URL is s3://. */
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  /** Optional GitHub token (`odu cloudflare setup --github-token`): lets the
   *  runner fetch private origins and Nix reach api.github.com without the
   *  shared-egress rate limit. Written to root-only files by the entrypoint,
   *  never left in the environment. */
  GITHUB_TOKEN?: string;
}

/** The container's start env. Built per request because the Worker learns
 *  its own public origin from the request — setup never has to know it. */
function startEnv(env: Env, origin: string): Record<string, string> {
  // No bucket bound (R2 not enabled) → no lane cache at all; the closure
  // arrives over /import instead. Listing a cache that answers 503 would
  // cost every substitution Nix's full retry backoff.
  const cacheUrl =
    env.ODU_LANE_CACHE_URL !== undefined && env.ODU_LANE_CACHE_URL !== ""
      ? env.ODU_LANE_CACHE_URL
      : env.CACHE !== undefined
        ? `${origin}/nix-cache`
        : "";
  const vars: Record<string, string> = {
    ODU_LANE_BUN: env.ODU_LANE_BUN,
    ODU_LANE_TINI: env.ODU_LANE_TINI,
    ODU_LANE_BASE: env.ODU_LANE_BASE ?? "",
    ODU_LANE_SUBSTITUTERS: `${cacheUrl} ${env.ODU_LANE_EXTRA_SUBSTITUTERS}`.trim(),
    ODU_LANE_TRUSTED_KEYS: `${env.ODU_LANE_CACHE_PUBLIC_KEY} ${env.ODU_LANE_EXTRA_TRUSTED_KEYS}`.trim(),
    ODU_LANE_NETRC: `machine ${new URL(origin).hostname} login odu password ${env.ODU_LANE_SECRET}`,
  };
  if (env.AWS_ACCESS_KEY_ID) vars.AWS_ACCESS_KEY_ID = env.AWS_ACCESS_KEY_ID;
  if (env.AWS_SECRET_ACCESS_KEY) vars.AWS_SECRET_ACCESS_KEY = env.AWS_SECRET_ACCESS_KEY;
  if (env.GITHUB_TOKEN) vars.ODU_LANE_GITHUB_TOKEN = env.GITHUB_TOKEN;
  return vars;
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
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      headers.set(START_ENV_HEADER, btoa(JSON.stringify(startEnv(env, url.origin))));
      return getContainer(env.LANE as never, `${lane[1]}-${env.ODU_LANE_DP_VERSION}`).fetch(new Request(request, { headers }));
    }
    return new Response("not found\n", { status: 404 });
  },
};
