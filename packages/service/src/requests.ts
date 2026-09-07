/**
 * SERVICE-SCOPED REQUEST RECEIPTS — how a `run.start` or a `run.cancel` that
 * may be asked for twice happens once.
 *
 * The catalog already answers this for a retry, and it answers it inside the
 * run the retry is about. A START has no run to be about — that is precisely
 * why it needs a receipt, because the thing a lost reply loses is the identity
 * of the run that was created. So the claim goes in the SERVICE's own state,
 * beside the catalog rather than inside it:
 *
 *     <state>/odu/runs/<RUN_ID>/receipts/<ID>.json     a retry, owned by a run
 *     <state>/odu/service/receipts/<ID>.json           a start or a cancel
 *
 * The primitive is the same one, not a copy of it: `@odu/run-history/receipts`
 * is generic over a directory (`ReceiptStore`), so the exclusive-create claim,
 * the digest conflict rule, the pre-minted run id and the two-phase
 * accept/dispatch/complete story are shared rather than re-derived. A second
 * implementation would be a second set of rules about what an unfinished claim
 * means, and those rules are the entire point.
 *
 * **The pre-minted run id is what makes a crash survivable.** A start claims
 * its id, mints the run id the coordinator will publish under, writes both, and
 * only then spawns. A repeat that finds an unfinished claim does not spawn
 * again to find out what happened — it asks the catalog whether that run id
 * exists. One question, one answer, no second coordinator.
 */

import { join } from "node:path";
import {
  claimReceipt,
  type ClaimOutcome,
  completeReceipt,
  digestOf,
  isRequestId,
  markDispatched,
  type ReceiptRecord,
  type ReceiptStore,
  readReceipt,
} from "@odu/run-history/receipts";
import { pidAlive } from "@odu/run-history/owner";
import { type CatalogOptions, handleFor, readManifest } from "@odu/run-history/store";
import { type StateEnv, stateRoot } from "@odu/run-history/paths";

/** The service's own state directory — sibling of `runs/`, never inside it.
 *  A request that has not produced a run yet has nowhere in the catalog to
 *  live, and putting it under some placeholder run id would make retention's
 *  evidence partition responsible for a record that is not evidence. */
export function serviceRoot(
  env?: StateEnv,
  platform?: NodeJS.Platform,
): string {
  return join(stateRoot(env, platform), "service");
}

/** Where a service-scoped receipt lives. `root` is injected the way every other
 *  reader of this state takes it, so a test names its own world. */
export function requestStore(opts: { root?: string } = {}): ReceiptStore {
  return { dir: opts.root ?? serviceRoot() };
}

/** How long a dispatched-but-unfinished claim is given before its silence is
 *  read as anything at all. Shared with the catalog's own retry reconciliation
 *  so the two cannot answer differently about the same kind of gap. */
export const DISPATCH_GRACE_MS = 120_000;

/**
 * What a repeat of an unfinished request should be told.
 *
 * Four answers, and the difference between the last two is the one that costs
 * something. `replay` and `refused` are settled. `nothing_happened` means the
 * claimant is provably gone and never got as far as dispatching, so re-issuing
 * is safe. `unresolved` means it DID dispatch and nobody knows what came of it
 * — and the correct advice there is never "try again with a fresh id", because
 * a fresh id is a licence to perform the mutation a second time.
 */
export type Reconciled =
  /** The receipt itself carries the answer. */
  | { kind: "replay"; result: unknown }
  /** The EFFECT is on disk even though the answer was lost — rebuild the answer
   *  from the run rather than from the receipt, because the run is what exists
   *  and the receipt is only what was intended. */
  | { kind: "run_exists"; runId: string }
  | { kind: "nothing_happened" }
  | { kind: "unresolved"; reason: string };

/**
 * Is the process that claimed this receipt still capable of finishing it?
 *
 * `null` means the question cannot be asked, and there are exactly two ways to
 * get there: a receipt from a build that stamped no claimant, and a claim made
 * on another machine. Both are UNKNOWN rather than dead, which is the safe
 * direction — elapsed time is not evidence about a process, and it is not
 * evidence at all about a host we cannot see.
 */
function claimantLives(
  receipt: ReceiptRecord,
  host: string,
  isAlive: (pid: number) => boolean,
): boolean | null {
  const claimant = receipt.claimant;
  if (claimant === undefined) return null;
  if (claimant.host !== host) return null;
  return isAlive(claimant.pid);
}

/**
 * Reconcile an unfinished START claim against the world.
 *
 * The evidence, in order:
 *
 *   1. **The pre-minted run exists.** Then the launch happened, whatever became
 *      of the reply, and the receipt is completed from the run itself.
 *   2. **It never dispatched, and its claimant is gone.** Then nothing was
 *      started: a claim is written before the spawn and the process that wrote
 *      it is not around to spawn any more.
 *   3. **Anything else** is unresolved, including a live claimant (it may be
 *      inside the spawn right now) and a dispatched claim with no run (the
 *      coordinator may be seconds from registering).
 */
export function reconcileStart(
  receipt: ReceiptRecord,
  opts: {
    catalog?: CatalogOptions;
    now: number;
    host: string;
    isAlive?: (pid: number) => boolean;
  },
): Reconciled {
  if (receipt.state === "completed") {
    return { kind: "replay", result: receipt.result };
  }
  const manifest = readManifest(handleFor(receipt.plannedRunId, opts.catalog ?? {}));
  if (manifest !== null) return { kind: "run_exists", runId: receipt.plannedRunId };
  const alive = claimantLives(receipt, opts.host, opts.isAlive ?? pidAlive);
  if (receipt.dispatchedAt === undefined) {
    if (alive === false) return { kind: "nothing_happened" };
    return {
      kind: "unresolved",
      reason:
        alive === null
          ? "the process that accepted it cannot be identified from here"
          : "the process that accepted it is still running and may be starting the run now",
    };
  }
  const waited = opts.now - receipt.dispatchedAt;
  return {
    kind: "unresolved",
    reason:
      alive === false && waited > DISPATCH_GRACE_MS
        ? `it was dispatched ${Math.round(waited / 1000)}s ago and the coordinator never registered a run`
        : "it was dispatched and no run has appeared yet",
  };
}

// Re-exported so a caller reaches ONE module for the whole receipt vocabulary
// rather than learning that half of it lives next door.
export {
  claimReceipt,
  completeReceipt,
  digestOf,
  isRequestId,
  markDispatched,
  readReceipt,
  type ClaimOutcome,
  type ReceiptRecord,
  type ReceiptStore,
};
