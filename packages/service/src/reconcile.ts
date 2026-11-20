import { listReceipts, RECEIPT_RULES } from "@odu/run-history/receipts";
import { formatCursor } from "@odu/run-history/ids";
import type { RunManifest } from "@odu/run-history/schema";
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

export function reconcileRequests(opts: ReconcileOptions): number {
  const catalog = opts.catalog ?? {};
  let settled = 0;
  for (const receipt of listReceipts(opts.requests)) {
    if (receipt.state === "completed") continue;
    if (!RECEIPT_RULES[receipt.kind].reconciled) continue;
    const outcome = reconcileStart(receipt, {
      catalog,
      now: opts.now,
      host: opts.host,
      ...(opts.isAlive === undefined ? {} : { isAlive: opts.isAlive }),
    });
    if (outcome.kind !== "run_exists") continue;
    const manifest = readManifest(handleFor(outcome.runId, catalog));
    if (manifest === null) continue;
    const rebuilt = reconstructedReceipt(outcome.runId, receipt.requestId, manifest);
    completeReceipt(opts.requests, receipt.requestId, recordedStart(rebuilt), opts.now);
    settled += 1;
  }
  return settled;
}

function reconstructedReceipt(
  runId: string,
  requestId: string,
  manifest: RunManifest,
): StartReceipt {
  return {
    accepted: true,
    runId,
    requestId,
    replayed: true,
    sha: manifest.sha,
    scope: manifest.scope,
    endpoint: manifest.registeredBy.endpoint,
    cursor: formatCursor({ runId, seq: 0 }),
  };
}
