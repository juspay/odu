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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLOUDFLARE_HOST = "cloudflare";
const INSTANCE = /^[A-Za-z0-9_-]{1,64}$/;

/** True for `cloudflare` and `cloudflare:<instance>`. */
export function isCloudflareHost(host: string): boolean {
  return host === CLOUDFLARE_HOST || host.startsWith(`${CLOUDFLARE_HOST}:`);
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
}

export function oduConfigDir(): string {
  return join(homedir(), ".config", "odu");
}

export function cloudflareConfigPath(): string {
  return join(oduConfigDir(), "cloudflare.json");
}

export function readCloudflareConfig(): CloudflareConfig | null {
  const path = cloudflareConfigPath();
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<CloudflareConfig>;
  if (typeof raw.workerUrl !== "string" || typeof raw.secret !== "string") {
    throw new Error(`odu: ${path} is missing workerUrl/secret — re-run \`odu cloudflare setup\``);
  }
  return { workerUrl: raw.workerUrl.replace(/\/+$/, ""), secret: raw.secret, cache: raw.cache ?? null };
}

/** The config a dial needs, or the sentence that gets one. */
export function requireCloudflareConfig(): CloudflareConfig {
  const config = readCloudflareConfig();
  if (config === null) {
    throw new Error(
      `odu: a cloudflare lane needs ${cloudflareConfigPath()} — run \`odu cloudflare setup\` once to deploy the odu-lane Worker to your account`,
    );
  }
  return config;
}
