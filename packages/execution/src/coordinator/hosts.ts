import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HostSlot {
  host: string;
  slot: number;
  slots: number;
}

export type HostPool = readonly (string | HostSlot)[];

export function asHostSlot(entry: string | HostSlot): HostSlot {
  return typeof entry === "string"
    ? { host: entry, slot: 0, slots: 1 }
    : entry;
}

export interface HostsConfig {
  hosts: Record<string, HostPool>;
  source: string | null;
}

interface HostsCandidate {
  label: string;
  path: string | null;
}

function hostsCandidates(override?: string): HostsCandidate[] {
  const oduHosts = override ?? process.env.ODU_HOSTS;
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

interface HostCapacity {
  host: string;
  slots: number;
}

function parseHostCapacity(
  path: string,
  platform: string,
  value: unknown,
): HostCapacity {
  if (typeof value === "string" && value !== "") {
    return { host: value, slots: 1 };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    if (
      typeof raw.host === "string" &&
      raw.host !== "" &&
      Number.isInteger(raw.slots) &&
      (raw.slots as number) >= 1
    ) {
      return { host: raw.host, slots: raw.slots as number };
    }
  }
  throw new Error(
    `odu: ${path}: host pool for "${platform}" must contain non-empty strings or {"host": string, "slots": positive integer}`,
  );
}

function parsePool(
  path: string,
  platform: string,
  value: unknown,
): HostPool {
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length === 0) {
    throw new Error(
      `odu: ${path}: host pool for "${platform}" must not be empty`,
    );
  }
  if (entries.every((entry) => typeof entry === "string" && entry !== "")) {
    return entries as string[];
  }
  const capacities = entries.map((entry) =>
    parseHostCapacity(path, platform, entry),
  );
  const maxSlots = Math.max(...capacities.map((entry) => entry.slots));
  const pool: HostSlot[] = [];
  for (let slot = 0; slot < maxSlots; slot += 1) {
    for (const entry of capacities) {
      if (slot < entry.slots) {
        pool.push({ host: entry.host, slot, slots: entry.slots });
      }
    }
  }
  return pool;
}

export function loadHosts(override?: string): HostsConfig {
  const candidates = hostsCandidates(override)
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

function noHostsConfiguredError(config: HostsConfig): Error {
  const chain = hostsCandidates()
    .map((c) => `       ${c.label}`)
    .join("\n");
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
  if (platforms.length === 0) return hosts;
  const sliced: Record<string, HostPool> = {};
  for (const platform of platforms) {
    const pool = hosts[platform];
    if (pool === undefined) {
      throw new Error(
        `odu: --platform ${platform} has no host (configure it or pass --host ${platform}=ADDR)`,
      );
    }
    sliced[platform] = pool;
  }
  return sliced;
}

export interface ResolvedPools {
  hosts: Record<string, HostPool>;
  source: string | null;
}

export function fanoutPools(
  config: HostsConfig,
  hostPins: readonly string[],
  platforms: readonly string[],
): ResolvedPools {
  const hosts = resolvePools(config, hostPins, platforms);
  if (Object.keys(hosts).length === 0) {
    throw noHostsConfiguredError(config);
  }
  return { hosts, source: config.source };
}

export function shortHost(addr: string): string {
  const afterAt = addr.includes("@")
    ? addr.slice(addr.indexOf("@") + 1)
    : addr;
  if (afterAt.startsWith("[")) return afterAt;
  if (isIP(afterAt) !== 0) return afterAt;
  const dot = afterAt.indexOf(".");
  return dot > 0 ? afterAt.slice(0, dot) : afterAt;
}
