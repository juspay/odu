/**
 * Cloudflare lanes: the host spelling and the per-user config that makes one
 * dialable.
 *
 * A hosts.json entry of `"cloudflare"` or `"cloudflare:<instance>"` is a lane
 * host like any ssh target — it lives in a pool, it is leased, it runs
 * `odu-runner --stdio` — but it is dialled through the `odu-lane` Worker on
 * the operator's own Cloudflare account instead of ssh. `<instance>` names the
 * Durable Object, and so the container: two instances are two machines, the
 * same instance is the same machine (the lease and the lane that follows it
 * land in one container, which is what makes the venue flock mean anything).
 *
 * The Worker URL, its bearer secret and the lane cache are written once by
 * `odu cloudflare setup` to `~/.config/odu/cloudflare.json` (mode 0600). A
 * FILE rather than env vars because runs execute in the shared service daemon,
 * whose environment is an allowlist (`spawn.ts`), not the caller's shell.
 */

import { readFileSync } from "node:fs";
import { hostsCandidates } from "./hostsFile";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLOUDFLARE_HOST = "cloudflare";
const INSTANCE = /^[A-Za-z0-9_-]{1,64}$/;

/** True for `cloudflare` and `cloudflare:<instance>`. */
export function isCloudflareHost(host: string): boolean {
  return host === CLOUDFLARE_HOST || host.startsWith(`${CLOUDFLARE_HOST}:`);
}

/** Expand one cloudflare hosts.json entry into its machines.
 *
 *  On ssh, `{"host": "ci-1", "slots": 4}` is four flocks on ONE box. On
 *  Cloudflare there is no box to share: a container is 4 vCPU, so four slots
 *  are only worth declaring as four containers. They are therefore spelled as
 *  four distinct HOSTS — `cloudflare:default-0` … `cloudflare:default-3` — so
 *  the lease dial and the lane dial that follows it name the same container
 *  without the slot having to travel separately through the run. A single
 *  slot keeps the spelling it was written with. */
export function expandCloudflareSlots(host: string, slots: number): string[] {
  const base = cloudflareInstance(host); // validates the spelling either way
  if (slots === 1) return [host];
  return Array.from({ length: slots }, (_, n) => `${CLOUDFLARE_HOST}:${base}-${n}`);
}

/** The Durable Object / container name a cloudflare host dials. */
export function cloudflareInstance(host: string): string {
  if (host === CLOUDFLARE_HOST) return "default";
  const instance = host.slice(CLOUDFLARE_HOST.length + 1);
  if (!INSTANCE.test(instance)) {
    throw new Error(
      `odu: "${host}" — a cloudflare lane is "cloudflare" or "cloudflare:<instance>" with <instance> matching ${INSTANCE.source}`,
    );
  }
  return instance;
}

/** Where the lane runner's closure is published for containers to substitute. */
export interface LaneCacheConfig {
  /** A Nix store URL `nix copy --to` accepts: the Worker-proxied R2 cache
   *  (`https://<worker>/nix-cache`) or R2's S3 endpoint
   *  (`s3://<bucket>?endpoint=<account>.r2.cloudflarestorage.com&region=auto`). */
  url: string;
  /** Nix signing key for uploads; containers trust its public half. */
  secretKeyFile: string;
  publicKey: string;
  /** netrc with the Worker secret — for the Worker-proxied cache. */
  netrcFile: string | null;
  /** AWS-style credentials file with R2 S3 keys — for an s3:// cache. */
  awsCredentialsFile: string | null;
}

export interface CloudflareConfig {
  workerUrl: string;
  secret: string;
  cache: LaneCacheConfig | null;
  /** What setup deployed — `status` compares it with what hosts.json now
   *  declares. Absent in configs written before it existed. */
  maxInstances?: number;
  githubToken?: boolean;
}

export function oduConfigDir(): string {
  return join(homedir(), ".config", "odu");
}

export function cloudflareConfigPath(): string {
  return join(oduConfigDir(), "cloudflare.json");
}

/** Validate a Worker origin once, at the boundary: an https origin and
 *  nothing else (no path, credentials, query), so every URL built from it
 *  below can only address the odu-lane Worker. */
export function parseWorkerUrl(raw: string, source: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`odu: ${source}: workerUrl ${JSON.stringify(raw)} is not a URL`);
  }
  // Plain http only for a loopback Worker (the connector's tests): a real
  // Worker carries the bearer, which must never cross the network in clear.
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  const scheme = url.protocol === "https:" || (loopback && url.protocol === "http:");
  if (!scheme || url.username !== "" || url.password !== "" || url.search !== "" || url.pathname.replace(/\/+$/, "") !== "") {
    throw new Error(`odu: ${source}: workerUrl must be a bare https origin, got ${JSON.stringify(raw)}`);
  }
  return url.origin;
}

export function readCloudflareConfig(): Readonly<CloudflareConfig> | null {
  const path = cloudflareConfigPath();
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const raw = JSON.parse(text) as Partial<CloudflareConfig>;
  if (typeof raw.workerUrl !== "string" || typeof raw.secret !== "string" || !/^[A-Za-z0-9_-]{16,}$/.test(raw.secret)) {
    throw new Error(`odu: ${path} is missing workerUrl/secret — re-run \`odu cloudflare setup\``);
  }
  return Object.freeze({
    workerUrl: parseWorkerUrl(raw.workerUrl, path),
    secret: raw.secret,
    cache: raw.cache ?? null,
    ...(typeof raw.maxInstances === "number" ? { maxInstances: raw.maxInstances } : {}),
    ...(raw.githubToken === true ? { githubToken: true } : {}),
  });
}

export type LaneAction = "start" | "state" | "agent" | "import" | "destroy";

/** The ONE place a lane route's URL is spelled. `wss` gives the WebSocket
 *  scheme for the two upgrade routes (`ws` for a loopback test Worker). */
export function laneEndpoint(
  config: Pick<CloudflareConfig, "workerUrl">,
  instance: string,
  action: LaneAction,
  scheme: "https" | "wss" = "https",
): URL {
  if (!INSTANCE.test(instance)) throw new Error(`odu: bad cloudflare instance ${JSON.stringify(instance)}`);
  const url = new URL(`/lane/${instance}/${action}`, config.workerUrl);
  const secure = url.protocol === "https:";
  if (scheme === "wss") url.protocol = secure ? "wss:" : "ws:";
  return url;
}

/** The ONE place the bearer leaves the config: as the Authorization header
 *  of a request to the Worker it was minted for. */
export function laneAuthHeaders(config: Pick<CloudflareConfig, "secret">): Record<string, string> {
  return { authorization: `Bearer ${config.secret}` };
}

/** The config a dial needs, or the sentence that gets one. */
export function requireCloudflareConfig(): Readonly<CloudflareConfig> {
  const config = readCloudflareConfig();
  if (config === null) {
    throw new Error(
      `odu: a cloudflare lane needs ${cloudflareConfigPath()} — run \`odu cloudflare setup\` once to deploy the odu-lane Worker to your account`,
    );
  }
  return config;
}

/** Every cloudflare host the operator's hosts file declares, slots expanded —
 *  the containers a run can ask for at once, which is what `odu cloudflare
 *  setup` sizes `max_instances` from. Reads the same chain the coordinator
 *  does (`hostsFile.ts`); a malformed entry is left for the coordinator to
 *  refuse, as here it only sizes a deployment. */
export function declaredCloudflareHosts(override?: string): { source: string | null; hosts: string[] } {
  for (const { path } of hostsCandidates(override)) {
    if (path === null) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const hosts = new Set<string>();
    for (const value of Object.values(parsed ?? {})) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        const host = typeof entry === "string" ? entry : (entry as { host?: unknown })?.host;
        const slots = typeof entry === "string" ? 1 : Number((entry as { slots?: unknown })?.slots ?? 1);
        if (typeof host !== "string" || !isCloudflareHost(host)) continue;
        for (const expanded of expandCloudflareSlots(host, Number.isInteger(slots) && slots > 0 ? slots : 1)) hosts.add(expanded);
      }
    }
    return { source: path, hosts: [...hosts] };
  }
  return { source: null, hosts: [] };
}
