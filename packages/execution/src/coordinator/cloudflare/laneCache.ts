/**
 * Provisioning for a Cloudflare lane: what `nix copy --to ssh-ng://host` is on
 * an ssh lane, re-cut for a host that has no ssh and starts from an empty store.
 *
 * There is no store to copy INTO — a container's disk is gone when it sleeps —
 * so the runner closure is published to a binary cache instead, and every
 * container substitutes from it (`entrypoint.sh` puts it first in
 * `substituters`). The cache is an R2 bucket, reached either through the
 * Worker's own R2 binding (`https://<worker>/nix-cache`, the default — no R2
 * API token needed) or through R2's S3 endpoint (`s3://…`). Both are ordinary
 * Nix store URLs, so this module is `nix build` + `nix copy` and nothing else.
 *
 * Uploads are signed with a key `odu cloudflare setup` generated; containers
 * trust only its public half (plus cache.nixos.org and odu's own OSS cache), so
 * the bucket being writable by the Worker secret does not make it a way to
 * inject arbitrary store paths into a lane.
 */

import { type AgentBinaryCache, runCapture } from "@kolu/surface-remote";
import type { LaneCacheConfig } from "../../common/cloudflareConfig";

/** A provisioning child may be silent this long before it is judged wedged —
 *  the same order as surface-remote's speculative-copy bound. */
const SILENCE_MS = 600_000;

function describe(result: Awaited<ReturnType<typeof runCapture>>): string {
  switch (result.kind) {
    case "exit":
      return `exit ${result.code}`;
    case "signal":
      return `killed by ${result.signal}`;
    case "lifetime-expired":
      return `silent for ${SILENCE_MS / 1000}s — killed`;
    case "aborted":
      return "aborted";
    default:
      return result.message;
  }
}

/** Realise the runner's output in the coordinator's own store, prefetching
 *  from odu's declared caches. The ssh path does the same before it ships a
 *  closure; here the local store is the source the lane cache is filled from. */
export async function realiseLocally(opts: {
  drvPath: string;
  binaryCache: AgentBinaryCache;
  onProgress: (line: string) => void;
  signal: AbortSignal;
}): Promise<string> {
  const result = await runCapture(
    "nix",
    [
      "build",
      `${opts.drvPath}^out`,
      "--no-link",
      "--print-out-paths",
      "--extra-experimental-features",
      "nix-command",
      "--option",
      "extra-substituters",
      opts.binaryCache.substituters.join(" "),
      "--option",
      "extra-trusted-public-keys",
      opts.binaryCache.trustedPublicKeys.join(" "),
    ],
    { onProgress: opts.onProgress, policy: { kind: "progress-liveness", silenceMs: SILENCE_MS }, signal: opts.signal },
  );
  const out = result.stdout.trim().split("\n").pop() ?? "";
  if (!result.ok || !out.startsWith("/nix/store/")) {
    throw new Error(`nix build ${opts.drvPath}^out failed (${describe(result)})`);
  }
  return out;
}

/** The `nix copy --to` URL: the configured cache plus signing and compression.
 *  zstd rather than the binary-cache default xz — the closure is re-published
 *  every time odu changes, and xz on a few hundred MiB is minutes of CPU. */
export function laneCacheWriteUrl(cache: LaneCacheConfig): string {
  const sep = cache.url.includes("?") ? "&" : "?";
  return `${cache.url}${sep}secret-key=${cache.secretKeyFile}&compression=zstd`;
}

/** Publish `outPath`'s closure to the lane cache. Idempotent and cheap when
 *  warm: `nix copy` asks the cache which paths it already has and uploads only
 *  the rest. */
export async function publishToLaneCache(opts: {
  outPath: string;
  cache: LaneCacheConfig;
  onProgress: (line: string) => void;
  signal: AbortSignal;
}): Promise<void> {
  const args = [
    "copy",
    "--extra-experimental-features",
    "nix-command",
    "--to",
    laneCacheWriteUrl(opts.cache),
    opts.outPath,
  ];
  if (opts.cache.netrcFile !== null) args.push("--option", "netrc-file", opts.cache.netrcFile);
  const env: Record<string, string> = {};
  if (opts.cache.awsCredentialsFile !== null) {
    env.AWS_SHARED_CREDENTIALS_FILE = opts.cache.awsCredentialsFile;
  }
  const result = await runCapture("nix", args, {
    onProgress: opts.onProgress,
    env,
    policy: { kind: "progress-liveness", silenceMs: SILENCE_MS },
    signal: opts.signal,
  });
  if (!result.ok) {
    throw new Error(`nix copy ${opts.outPath} → lane cache failed (${describe(result)})`);
  }
}
