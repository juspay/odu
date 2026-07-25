/**
 * Platform → host-pool resolution. Keys are Nix system tuples; values are
 * pools of anything ssh can dial (or `localhost`, which short-circuits the
 * nix-copy transport). A plain string in hosts.json is a pool of one — fully
 * back-compatible. Missing platforms silently drop from the fanout — the
 * operator opts in per platform, exactly the justci hosts.json semantics. But
 * a config that names *no* platform at all is not "run everything here": that
 * is the juspay/odu#46 fork-bomb, so `fanoutPools` refuses it loudly rather
 * than synthesizing a localhost lane (running locally stays available only as
 * an explicit `--host PLAT=localhost` or `"PLAT": "localhost"` decision).
 *
 * Lookup order (`$ODU_HOSTS → ~/.config/odu/hosts.json →
 * ~/.config/justci/hosts.json`): the first file that exists wins. The justci
 * path is the compat fallback for machines still carrying a justci hosts file.
 * `--host PLAT=ADDR` upserts a single-host pool on top (and adds the platform
 * when absent — that is how a one-shot pin forces a specific box).
 *
 * Picking *which* free machine from a multi-host pool is the lease layer's job
 * (`lease.ts`); this module only resolves the declared inventory per platform.
 */

import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLocalHost } from "@kolu/surface-remote";

/** One platform's declared inventory — always a list (a bare string in the
 *  file normalizes to a one-element pool). Never empty after `loadHosts`: an
 *  empty array in the file is refused at parse time. */
export type HostPool = readonly string[];

export interface HostsConfig {
  hosts: Record<string, HostPool>;
  /** Which file won — named in run output so the operator can tell; `null`
   *  when no candidate file existed (typed absence, not a sentinel string, so
   *  consumers branch on it instead of matching display text). */
  source: string | null;
}

/** A resolution-chain slot: the label the operator sees and the path we probe
 *  (null for `$ODU_HOSTS` when it is unset — the slot still shows in the
 *  refusal so the chain reads in full). One source of truth for both the
 *  lookup in `loadHosts` and the named chain in the no-config refusal. */
interface HostsCandidate {
  label: string;
  path: string | null;
}

function hostsCandidates(): HostsCandidate[] {
  const oduHosts = process.env.ODU_HOSTS;
  return [
    {
      label: "$ODU_HOSTS",
      path: oduHosts !== undefined && oduHosts !== "" ? oduHosts : null,
    },
    {
      label: "~/.config/odu/hosts.json",
      path: join(homedir(), ".config", "odu", "hosts.json"),
    },
    {
      label: "~/.config/justci/hosts.json",
      path: join(homedir(), ".config", "justci", "hosts.json"),
    },
  ];
}

/** Parse one platform's value: a string, or a non-empty array of strings. */
function parsePool(
  path: string,
  platform: string,
  value: unknown,
): string[] {
  if (typeof value === "string") {
    if (value === "") {
      throw new Error(
        `odu: ${path}: host for "${platform}" must be a non-empty string`,
      );
    }
    return [value];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new Error(
        `odu: ${path}: host pool for "${platform}" must not be empty`,
      );
    }
    const pool: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string" || entry === "") {
        throw new Error(
          `odu: ${path}: host pool for "${platform}" must be an array of non-empty strings`,
        );
      }
      pool.push(entry);
    }
    return pool;
  }
  throw new Error(
    `odu: ${path}: host for "${platform}" must be a string or an array of strings`,
  );
}

export function loadHosts(): HostsConfig {
  const candidates = hostsCandidates()
    .map((c) => c.path)
    .filter((p): p is string => p !== null);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(`odu: ${path} must be a JSON object of platform → host`);
    }
    const hosts: Record<string, HostPool> = {};
    for (const [platform, value] of Object.entries(parsed)) {
      hosts[platform] = parsePool(path, platform, value);
    }
    return { hosts, source: path };
  }
  return { hosts: {}, source: null };
}

/** The loud refusal `fanoutPools` raises when a run resolves to *zero* pools —
 *  no hosts file anywhere, no `--host` pin, no `--platform` slice. A missing
 *  config is indistinguishable in outcome from an explicit `"…": "localhost"`,
 *  but only one is a decision someone made (juspay/odu#46): defaulting the
 *  no-config case to a localhost lane fork-bombed a production workstation, so
 *  we name the full resolution chain we checked and how to opt into localhost
 *  on purpose, and refuse. The message text — the chain, the `--host` syntax —
 *  lives beside `loadHosts`, the module that owns the chain. Takes the loaded
 *  `config` (not a fresh filesystem probe) so the diagnosis matches what
 *  resolution actually did — e.g. names the file that won but configured
 *  nothing, rather than mislabeling a shadowed lower-precedence file.
 *  Module-private: `fanoutPools` is the seam callers reach it through. */
function noHostsConfiguredError(config: HostsConfig): Error {
  const chain = hostsCandidates()
    .map((c) => `       ${c.label}`)
    .join("\n");
  // `loadHosts` sets `source` to the file it read, or null when none existed —
  // so we can say precisely why the fanout came up empty.
  const why =
    config.source === null
      ? "None of these exist."
      : `The file that won (${config.source}) configured no platform.`;
  return new Error(
    "odu: no hosts configured for any platform — refusing to run.\n" +
      "     A missing hosts config is not \"run everything here\": that silently\n" +
      "     turns a fanout into a local fork-bomb (juspay/odu#46). odu resolves\n" +
      "     hosts from the first of these that exists, in order:\n" +
      `${chain}\n` +
      `     ${why}\n` +
      "     Configure at least one platform (a JSON object of Nix-system -> host,\n" +
      "     where a host is an ssh target, a list of them (a pool), or \"localhost\"\n" +
      "     to run here on purpose),\n" +
      "     or pass --host PLATFORM=ADDR for this run. To run locally, name YOUR\n" +
      "     platform's lane localhost — e.g. --host aarch64-darwin=localhost on a\n" +
      "     Mac, --host x86_64-linux=localhost on Linux (a localhost lane runs the\n" +
      "     matching-platform runner, so the tuple must be this machine's).",
  );
}

/** Apply `--host PLAT=ADDR` pins and `--platform` slices to the config.
 *  Pins replace the pool with a single-host pool (the pin is a forced pick).
 *  Returns declared inventory — unjudged, and not post-lease lanes: locality
 *  is the lease seam's to enforce (`leaseLanes` / `acquireFromPool` entry),
 *  over exactly the pools a run claims. */
export function resolvePools(
  config: HostsConfig,
  hostPins: readonly string[],
  platforms: readonly string[],
): Record<string, HostPool> {
  const hosts: Record<string, HostPool> = { ...config.hosts };
  for (const pin of hostPins) {
    const eq = pin.indexOf("=");
    if (eq <= 0) {
      throw new Error(`odu: --host expects PLATFORM=ADDR, got "${pin}"`);
    }
    const platform = pin.slice(0, eq);
    const addr = pin.slice(eq + 1);
    if (addr === "") {
      throw new Error(`odu: --host expects PLATFORM=ADDR, got "${pin}"`);
    }
    hosts[platform] = [addr];
  }
  const resolved: Record<string, HostPool> = {};
  if (platforms.length === 0) {
    Object.assign(resolved, hosts);
  } else {
    for (const platform of platforms) {
      const pool = hosts[platform];
      if (pool === undefined) {
        throw new Error(
          `odu: --platform ${platform} has no host (configure it or pass --host ${platform}=ADDR)`,
        );
      }
      resolved[platform] = pool;
    }
  }
  return resolved;
}


/** The fanout pools for a run: `resolvePools` plus the no-config fail-fast.
 *  Zero resolved pools means the run named no host anywhere — the juspay/odu#46
 *  case — so we refuse loudly instead of defaulting to a localhost lane. This
 *  is the single seam `run` decides the inventory through; keeping the refusal
 *  here (not inline in `run`) keeps the decision pure and testable. Post-lease
 *  platform→host maps stay named `lanes` (`leaseLanes`). */
export function fanoutPools(
  config: HostsConfig,
  hostPins: readonly string[],
  platforms: readonly string[],
): Record<string, HostPool> {
  const pools = resolvePools(config, hostPins, platforms);
  if (Object.keys(pools).length === 0) {
    throw noHostsConfiguredError(config);
  }
  return pools;
}

/** Short label for a dial target: strip `user@` and any DNS domain suffix so
 *  the operator-facing pick/status lines stay compact (`nix@ci-3.foo` → `ci-3`).
 *  IPv4/IPv6 literals are left intact — first-dot splitting would collapse
 *  distinct pool targets (`10.0.0.1` and `10.0.0.2` both → `10`). */
export function shortHost(addr: string): string {
  const afterAt = addr.includes("@")
    ? addr.slice(addr.indexOf("@") + 1)
    : addr;
  // Bracketed IPv6 (ssh style): keep the full host part.
  if (afterAt.startsWith("[")) return afterAt;
  if (isIP(afterAt) !== 0) return afterAt;
  const dot = afterAt.indexOf(".");
  return dot > 0 ? afterAt.slice(0, dot) : afterAt;
}
