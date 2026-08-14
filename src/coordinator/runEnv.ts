/**
 * The run environment: how a run's lanes get their machines.
 *
 * `orchestrate` is a SEQUENCE — serve the socket, seed the reporter, open the
 * provisioning bracket, claim, publish, start lanes. *How* a lane's machine is
 * obtained is a different axis of change entirely (an agent-held `odu lease`
 * holder, a `--host` pin, a pool claim with rotation and wait-in-line, and
 * whatever comes next), and juspay/odu#84 is the receipt for keeping the two
 * apart: reordering the sequence forced six unrelated activities to be
 * rewritten because they all lived in one 1000-line closure scope.
 *
 * So the claim lives here, as a free function whose OUTPUT IS A VALUE. The
 * previous shape returned `Error | null` while its real products were entries
 * written into a `Record` declared 500 lines earlier and handles pushed into an
 * array owned two stack frames up — a signature that actively misled, and the
 * reason three sites downstream needed `as string` casts to assert an invariant
 * the return type declined to carry.
 */

import type { ResolvedPools } from "./hosts";
import {
  type LeaseHandle,
  type LeaseIdentity,
  leaseLanes,
  type LeaseLanesOpts,
} from "./lease";
import { removePlatformLease, upsertPlatformLease } from "./leaseRecord";
import type { ResolveRunnerDrv } from "./runnerFlake";

/** What a claim produced. All-or-nothing, exactly as `leaseLanes` decides it:
 *  on failure it has already released whatever it partially held, so there is
 *  no half-claimed state for a caller to reconcile. */
export type ClaimOutcome =
  | { ok: true; lanes: Record<string, string>; leases: LeaseHandle[] }
  | { ok: false; error: Error };

export interface ClaimVenuesOpts {
  repoRoot: string;
  pools: ResolvedPools;
  /** The platforms that still need a machine — NOT every active platform. An
   *  agent-held lane already has its host and is not part of this claim, which
   *  is also the scope its failure may be reported over. */
  platforms: readonly string[];
  identity: LeaseIdentity;
  noWait: boolean;
  runLabel: string;
  onLine: (msg: string, platform: string) => void;
  resolveDrvPath: (platform: string) => ResolveRunnerDrv;
  /** Injected by the unit test in place of a real ssh claim. */
  claim?: LeaseLanesOpts["claim"];
}

/** Hold the observable "waiting" rows in `.ci/odu-lease.json` for exactly the
 *  duration of `fn`, so the cross-process inventory (`odu hosts`) and this
 *  run's own claim cannot disagree about whether it is still waiting. One
 *  scope, one `finally` — not two clear-out paths kept in step by memory. */
async function withWaitingRecords<T>(
  repoRoot: string,
  platforms: readonly string[],
  runLabel: string,
  fn: () => Promise<T>,
): Promise<T> {
  for (const platform of platforms) {
    upsertPlatformLease(repoRoot, platform, {
      host: null,
      holderPid: process.pid,
      since: Date.now(),
      state: "waiting",
      waitingBehind: null,
      run: runLabel,
    });
  }
  try {
    return await fn();
  } finally {
    // Drop run-owned waiting records (this pid). Agent-held platforms were
    // never in `platforms`, so their records stay.
    for (const platform of platforms) removePlatformLease(repoRoot, platform);
  }
}

/**
 * Claim a venue for every platform that still needs one.
 *
 * Returns the failure rather than throwing it. By the time this runs the run
 * already has a socket, an ordinal and a fan-in state that observers are
 * reading, so a failure to get a machine is a fact ABOUT this run — it belongs
 * in the run's own state (a red `_ci-setup`, a durable record, a verdict)
 * rather than in an exception that unwinds past all three and leaves every
 * reader with a socket that simply vanished.
 */
export async function claimVenues(
  opts: ClaimVenuesOpts,
): Promise<ClaimOutcome> {
  if (opts.platforms.length === 0) {
    return { ok: true, lanes: {}, leases: [] };
  }
  return withWaitingRecords(
    opts.repoRoot,
    opts.platforms,
    opts.runLabel,
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
        return {
          ok: true,
          lanes: { ...claimed.lanes },
          leases: [...claimed.leases],
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
  );
}
