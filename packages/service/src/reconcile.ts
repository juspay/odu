/**
 * STARTUP RECONCILIATION — what the service settles before it says it is ready.
 *
 * ## Requests: settle what a crash left in flight
 *
 * A `run.start` claims its request id and pre-mints the run id BEFORE it spawns
 * anything. A service that dies in the window between those two facts leaves an
 * `accepted` receipt whose coordinator may or may not have registered a run —
 * and the whole reason the run id was minted first is that the question then has
 * an answer: does a run with that id exist in the catalog?
 *
 * So this asks it, once, for every unfinished start claim, and completes the
 * ones whose effect is on disk. A repeat of that request id afterwards replays
 * the recorded answer instead of reconciling again, and — the property that
 * matters — never starts a second coordinator for one request.
 *
 * What it does NOT do is decide anything about a claim whose run is absent. An
 * absent run means either "the launch never happened" or "the coordinator is
 * seconds from registering", and startup is exactly the moment those two are
 * least distinguishable. They are left in flight, and the next caller to present
 * that id gets `reconcileStart`'s own three-way answer against a world that has
 * had time to settle.
 *
 * ## Runs: nothing to write, and that is the design
 *
 * A surviving coordinator is not this service's to adopt or to bury. The
 * temptation is to dial each surviving endpoint at startup and mark the
 * unreachable ones dead. That is precisely the inference the fence exists to
 * refuse: **link loss is not proof of death.**
 */

import { listReceipts } from "@odu/run-history/receipts";
import { formatCursor } from "@odu/run-history/ids";
import { type CatalogOptions, handleFor, readManifest } from "@odu/run-history/store";
import type { StartReceipt } from "@odu/service-client/surface";
import { completeReceipt, reconcileStart, type ReceiptStore } from "./requests";
import { recordedStart } from "./start";

export interface ReconcileOptions {
  requests: ReceiptStore;
  catalog?: CatalogOptions;
  now: number;
  host: string;
  isAlive?: (pid: number) => boolean;
}

/** Settle every unfinished start claim whose run exists, and report how many. */
export function reconcileRequests(opts: ReconcileOptions): number {
  const catalog = opts.catalog ?? {};
  let settled = 0;
  for (const receipt of listReceipts(opts.requests)) {
    if (receipt.state === "completed") continue;
    if (receipt.kind !== "start") continue;
    const outcome = reconcileStart(receipt, {
      catalog,
      now: opts.now,
      host: opts.host,
      ...(opts.isAlive === undefined ? {} : { isAlive: opts.isAlive }),
    });
    if (outcome.kind !== "run_exists") continue;
    const manifest = readManifest(handleFor(outcome.runId, catalog));
    if (manifest === null) continue;
    const rebuilt: StartReceipt = {
      accepted: true,
      runId: outcome.runId,
      requestId: receipt.requestId,
      replayed: true,
      sha: manifest.sha,
      scope: manifest.scope,
      endpoint: manifest.registeredBy.endpoint,
      cursor: formatCursor({ runId: outcome.runId, seq: 0 }),
    };
    completeReceipt(opts.requests, receipt.requestId, recordedStart(rebuilt), opts.now);
    settled += 1;
  }
  return settled;
}
