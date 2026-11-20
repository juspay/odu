import type { ResolvedPools } from "./hosts";
import {
  assertLeasePools,
  hostSlotKey,
  leaseBurstSlots,
  type LeaseHandle,
  type LeaseIdentity,
  leaseLanes,
  type LeaseLanesOpts,
  settleLeaseHandoff,
} from "./lease";
import { removePlatformLease, upsertPlatformLease } from "./leaseRecord";
import type { ResolveRunnerDrv } from "./runnerFlake";
import { shortHost } from "./hosts";

export type ClaimOutcome =
  | { ok: true; lanes: Record<string, string>; leases: LeaseHandle[] }
  | { ok: false; error: Error };

export type PreparedVenues =
  | {
      ok: true;
      venues: ReadonlyMap<string, PreparedVenue>;
    }
  | { ok: false; error: Error };

export interface PreparedVenue {
  host: string;
  leases: LeaseHandle[];
  bursts: LeaseHandle[];
}

export interface BurstRequest {
  platform: string;
  label: string;
  limit: number;
}

export interface PlatformClaimResult {
  platform: string;
  outcome: ClaimOutcome;
}

export async function claimPlatformsIndependently(
  platforms: readonly string[],
  claim: (platform: string) => Promise<ClaimOutcome>,
  onReady: (
    platform: string,
    outcome: Extract<ClaimOutcome, { ok: true }>,
  ) => void,
): Promise<PlatformClaimResult[]> {
  return await Promise.all(
    platforms.map(async (platform) => {
      const outcome = await claim(platform);
      if (outcome.ok) onReady(platform, outcome);
      return { platform, outcome };
    }),
  );
}

export interface PrepareVenuesOpts {
  claimed: Extract<ClaimOutcome, { ok: true }>;
  existingLanes: Readonly<Record<string, string>>;
  platforms: readonly string[];
  bursts: readonly BurstRequest[];
  pools: ResolvedPools;
  identity: LeaseIdentity;
  onLine: (msg: string, platform: string) => void;
  resolveDrvPath: ResolveRunnerDrv;
  leaseBurst?: typeof leaseBurstSlots;
}

export interface ClaimVenuesOpts {
  repoRoot: string;
  pools: ResolvedPools;
  platforms: readonly string[];
  validatePlatforms?: readonly string[];
  identity: LeaseIdentity;
  noWait: boolean;
  runLabel: string;
  onLine: (msg: string, platform: string) => void;
  resolveDrvPath: ResolveRunnerDrv;
  claim?: LeaseLanesOpts["claim"];
}

function bookkeep(what: string, write: () => void, warn: Warn): void {
  try {
    write();
  } catch (err) {
    warn(`odu: lease bookkeeping (${what}) failed: ${String(err)}`);
  }
}

type Warn = (msg: string) => void;

async function withWaitingRecords<T>(
  repoRoot: string,
  platforms: readonly string[],
  runLabel: string,
  warn: Warn,
  fn: () => Promise<T>,
): Promise<T> {
  for (const platform of platforms) {
    bookkeep(
      `mark ${platform} waiting`,
      () =>
        upsertPlatformLease(repoRoot, platform, {
          host: null,
          holderPid: process.pid,
          since: Date.now(),
          state: "waiting",
          waitingBehind: null,
          run: runLabel,
        }),
      warn,
    );
  }
  try {
    return await fn();
  } finally {
    for (const platform of platforms) {
      bookkeep(
        `clear ${platform}`,
        () => removePlatformLease(repoRoot, platform),
        warn,
      );
    }
  }
}

export async function claimVenues(
  opts: ClaimVenuesOpts,
): Promise<ClaimOutcome> {
  if (opts.platforms.length === 0) {
    return { ok: true, lanes: {}, leases: [] };
  }
  const asError = (err: unknown): Error =>
    err instanceof Error ? err : new Error(String(err));
  const warn: Warn = (msg) => opts.onLine?.(msg, opts.platforms[0] ?? "");
  try {
    assertLeasePools(opts.pools, opts.validatePlatforms ?? opts.platforms);
    return await withWaitingRecords(
      opts.repoRoot,
      opts.platforms,
      opts.runLabel,
      warn,
      async (): Promise<ClaimOutcome> => {
        try {
          const claimed = await leaseLanes({
            pools: opts.pools,
            platforms: opts.platforms,
            identity: opts.identity,
            noWait: opts.noWait,
            onLine: opts.onLine,
            resolveDrvPath: opts.resolveDrvPath,
            ...(opts.claim === undefined ? {} : { claim: opts.claim }),
          });
          return { ok: true, lanes: claimed.lanes, leases: claimed.leases };
        } catch (err) {
          return { ok: false, error: asError(err) };
        }
      },
    );
  } catch (err) {
    return { ok: false, error: asError(err) };
  }
}

export async function prepareVenues(
  opts: PrepareVenuesOpts,
): Promise<PreparedVenues> {
  const lanes = { ...opts.existingLanes, ...opts.claimed.lanes };
  const burst = opts.leaseBurst ?? leaseBurstSlots;
  const requests = new Map(opts.bursts.map((request) => [request.platform, request]));

  const attempts = await Promise.allSettled(
    opts.platforms.map(async (platform) => {
      const request = requests.get(platform);
      const primaryHost = lanes[platform];
      const primary = opts.claimed.leases.find(
        (lease) => lease.host === primaryHost,
      );
      if (request === undefined || primaryHost === undefined) {
        return { platform, primary, extras: [] };
      }
      const extras = await burst({
        platform,
        pool: opts.pools.hosts[platform] ?? [],
        identity: {
          holder: opts.identity.holder,
          run: `${opts.identity.run ?? "run"}:${request.label}`,
        },
        limit: request.limit,
        ...(primary === undefined
          ? {}
          : { exclude: new Set([hostSlotKey(primaryHost, primary.slot ?? 0)]) }),
        occupiedHosts: new Set([primaryHost]),
        onLine: (line) => opts.onLine(line, platform),
        resolveDrvPath: opts.resolveDrvPath,
      });
      return {
        platform,
        primary,
        extras,
      };
    }),
  );

  const candidates = attempts.flatMap((attempt) =>
    attempt.status === "fulfilled" ? [attempt.value] : [],
  );
  const failed = attempts.find(
    (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
  );
  if (failed !== undefined) {
    const all = new Set<LeaseHandle>(
      candidates.flatMap(({ extras }) => extras),
    );
    for (const lease of all) lease.release();
    return {
      ok: false,
      error:
        failed.reason instanceof Error
          ? failed.reason
          : new Error(String(failed.reason)),
    };
  }

  const handoffs = await Promise.all(
    candidates.map(async (candidate) => {
      if (candidate.primary !== undefined) {
        return {
          candidate,
          kind: "primary" as const,
          handoff: await settleLeaseHandoff(
            candidate.primary,
            candidate.extras,
          ),
        };
      }
      const first = candidate.extras[0];
      return first === undefined
        ? { candidate, kind: "none" as const, handoff: undefined }
        : {
            candidate,
            kind: "optional" as const,
            handoff: await settleLeaseHandoff(first, candidate.extras.slice(1)),
          };
    }),
  );
  const lost = handoffs.find(
    ({ kind, handoff }) => kind === "primary" && handoff === null,
  )?.candidate;
  if (lost !== undefined) {
    const all = new Set<LeaseHandle>(
      candidates.flatMap(({ extras }) => extras),
    );
    for (const lease of all) lease.release();
    return {
      ok: false,
      error: new Error(
        `venue lease stopped answering during final handoff for ${lost.platform}`,
      ),
    };
  }

  const venues = new Map<string, PreparedVenue>();
  for (const { candidate, kind, handoff } of handoffs) {
    let extras = candidate.extras;
    const leases: LeaseHandle[] = [];
    if (kind === "primary" && handoff !== null) {
      const previous = lanes[candidate.platform];
      if (previous !== handoff.primary.host) {
        opts.onLine(
          `${candidate.platform}: primary ${shortHost(previous ?? "unknown")} stopped answering during handoff; promoted ${shortHost(handoff.primary.host)}`,
          candidate.platform,
        );
      }
      lanes[candidate.platform] = handoff.primary.host;
      extras = handoff.extras;
      leases.push(handoff.primary);
    } else if (kind === "optional") {
      extras =
        handoff === null ? [] : [handoff.primary, ...handoff.extras];
    }
    for (const lease of extras) leases.push(lease);
    venues.set(candidate.platform, {
      host: lanes[candidate.platform]!,
      leases,
      bursts: requests.has(candidate.platform) ? extras : [],
    });
  }

  return { ok: true, venues };
}
