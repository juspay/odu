import type { Logger } from "@kolu/surface-daemon";
import type { Surface, SurfaceSpec } from "@kolu/surface/define";
import type { ExposeMap } from "@kolu/surface/expose";
import type { RootedSurfacesRuntime } from "@kolu/surface/server";
import type { ServeSurfaceAppOptions } from "@kolu/surface-app/serve";
import { type Plugin, serviceTag } from "@olai/effect-cordis";
import type { MetricsSources } from "./metrics";
import { singleOwnerSlot } from "./slot";

export const StateDir = serviceTag<string>("odu:stateDir");

export const DaemonHome = serviceTag<string>("odu:daemonHome");

export const BoundOrigin = serviceTag<string>("odu:boundOrigin");

/** `null` means the bound origin IS the public one. */
export const PublicOrigin = serviceTag<string | null>("odu:publicOrigin");

export const RootToken = serviceTag<string | null>("odu:rootToken");

/** The OLD store a cache migrates from — `$ODU_CACHE_STORE`, or `null` for the
 *  host's own `/nix/store`. */
export const NixStore = serviceTag<string | null>("odu:nixStore");

export const Build = serviceTag<{
  readonly oduVersion: string;
  readonly commit: string | null;
  readonly buildId: string | null;
  readonly self: string | null;
}>("odu:build");

export const RowContracts = serviceTag<Readonly<Record<string, string>>>("odu:rowContracts");

export const Log = serviceTag<Logger>("odu:log");

export const Shutdown = serviceTag<() => void>("odu:shutdown");

export const Bundle = serviceTag<RootedSurfacesRuntime<never>>("odu:bundle");

export const SERVICE_DOOR_PATH = "/_odu/door";

export const SERVICE_ROWS_PATH = "/_odu/rows";

/**
 * `null` is UNKNOWN (the host did not answer), deliberately not `[]`.
 */
export async function readRows(
  origin: string,
  ask: typeof fetch = fetch,
): Promise<ReadonlyArray<string> | null> {
  try {
    const response = await ask(new URL(SERVICE_ROWS_PATH, origin), {
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { rows?: unknown };
    if (!Array.isArray(body.rows)) return null;
    return body.rows.filter((row): row is string => typeof row === "string");
  } catch {
    return null;
  }
}

/**
 * `null` is UNKNOWN — the host did not answer — and it is deliberately not
 * `false`. The request is BOUNDED.
 */
export async function readDoor(
  origin: string,
  ask: typeof fetch = fetch,
): Promise<boolean | null> {
  try {
    const response = await ask(new URL(SERVICE_DOOR_PATH, origin), {
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { door?: unknown };
    return body.door === true;
  } catch {
    return null;
  }
}

export function agentInstructions(
  core: RowAgent | null,
  siblings: Readonly<Record<string, RowAgent>>,
): string {
  return [core?.instructions, ...Object.values(siblings).map((row) => row.instructions)]
    .filter((text): text is string => text !== undefined && text !== "")
    .join("\n\n");
}

export type RowRoutes = NonNullable<ServeSurfaceAppOptions["routes"]>;

/**
 * Each entry is exact, or ends in `*` for a WALK — one or more characters after
 * the prefix (`/cache/*` claims `/cache/b/x`, not `/cache/`).
 */
export interface ClaimedRoutes<Layer extends RowRoutes = RowRoutes> {
  readonly layer: Layer;
  readonly paths: ReadonlyArray<string>;
}

export interface HttpRoutes {
  /** Add a layer and its claim. The returned function removes THAT one and no
   *  other. */
  add(routes: ClaimedRoutes): () => void;
  /** Every layer registered so far, with its claim, in registration order. Read
   *  once, at bind — by the router for the layers and by the door gate for the
   *  paths. */
  layers(): ReadonlyArray<ClaimedRoutes>;
}

export const Routes = serviceTag<HttpRoutes>("odu:httpRoutes");

export const Metrics = serviceTag<MetricsSources>("odu:metrics");

export interface CachePurge {
  announce(urls: readonly string[]): void;
  /** Install the purger. Returns its withdrawal; throws
   *  {@link PurgeClaimRefused} when one is already installed. */
  register(purge: (urls: readonly string[]) => void): () => void;
  listening(): boolean;
}

export class PurgeClaimRefused extends Error {
  readonly _tag = "PurgeClaimRefused";
  constructor() {
    super(
      "odu: a cache purger is already installed on this daemon — exactly one " +
        "row may front the cache's URLs",
    );
  }
}

export const CachePurge = serviceTag<CachePurge>("odu:cachePurge");

export function purgeBroker(): CachePurge {
  const slot = singleOwnerSlot<(urls: readonly string[]) => void>(() => new PurgeClaimRefused());
  return {
    announce(urls) {
      const purge = slot.held();
      if (purge === null || urls.length === 0) return;
      purge(urls);
    },
    register: (purge) => slot.claim(purge),
    listening: () => slot.held() !== null,
  };
}

export interface CacheGrants {
  /** IS A CACHE REGISTERED AT ALL. Not "at which origin": where a push goes is
   *  a property of the BUCKET, answered by {@link GrantedBucket}. */
  serves(): boolean;
  /** The bucket this daemon serves AT THAT SUBSTITUTER URL, or `null`. See
   *  {@link GrantedBucket} for why the URL and never a probe. */
  bucketAt(substituter: string): GrantedBucket | null;
  /** `null` when no cache is registered or the bucket is gone. */
  mint(request: { bucket: string; runId: string }): { id: string; token: string } | null;
  /** Let a minted token go, by id. Idempotent: an unknown id is not an error. */
  revoke(id: string): void;
  /** Install the answerer. Returns its withdrawal; throws
   *  {@link GrantClaimRefused} when one is already installed. */
  register(grantor: CacheGrantor): () => void;
}

/** One bucket this daemon serves, decided by the advertised URL, never by a
 *  response body. */
export interface GrantedBucket {
  readonly name: string;
  /** The key a consumer needs in `trusted-public-keys` to USE what is pushed. */
  readonly publicKey: string;
  /** `Odu-Origin`: where a push to this bucket is aimed. */
  readonly origin: string;
  /** The advertised substituter URL that matched. */
  readonly substituter: string;
}

export interface CacheGrantor {
  bucketAt(substituter: string): GrantedBucket | null;
  mint(request: { bucket: string; runId: string }): { id: string; token: string } | null;
  revoke(id: string): void;
}

export class GrantClaimRefused extends Error {
  readonly _tag = "GrantClaimRefused";
  constructor() {
    super(
      "odu: a cache grantor is already installed on this daemon — exactly one " +
        "row may mint a run's write token",
    );
  }
}

export const CacheGrants = serviceTag<CacheGrants>("odu:cacheGrants");

export function grantsBroker(): CacheGrants {
  const slot = singleOwnerSlot<CacheGrantor>(() => new GrantClaimRefused());
  return {
    serves: () => slot.held() !== null,
    bucketAt: (substituter) => slot.held()?.bucketAt(substituter) ?? null,
    mint: (request) => slot.held()?.mint(request) ?? null,
    revoke: (id) => slot.held()?.revoke(id),
    register: (grantor) => slot.claim(grantor),
  };
}

export interface BucketDomainFact {
  readonly bucket: string;
  readonly domain: string;
}

export interface BucketDomains {
  current(): readonly BucketDomainFact[];
  subscribe(listener: () => void): () => void;
  /** The paths the cache row answers: its claims are the whole list. */
  paths: ReadonlyArray<string>;
  /** The bucket a path names, in either protocol spelling — or `null` when it
   *  names none. */
  bucketOf(path: string): string | null;
}

export const BucketDomains = serviceTag<BucketDomains>("odu:bucketDomains");

export interface RowAgent {
  readonly surface: Surface<SurfaceSpec>;
  readonly expose: ExposeMap<SurfaceSpec>;
  readonly instructions: string;
}

/** `key` is the word its surface is served under; `null` for the ROOT row.
 *  `contract` is the row's own version, `major.minor`. */
export interface RowFacts {
  readonly name: string;
  readonly key: string | null;
  readonly agent: RowAgent;
  readonly contract: string;
}

export interface Row extends RowFacts {
  readonly plugin: Plugin;
}
