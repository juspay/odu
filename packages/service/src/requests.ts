import { join } from "node:path";
import {
  claimReceipt,
  type ClaimOutcome,
  completeReceipt,
  digestOf,
  isRequestId,
  markDispatched,
  optionalPart,
  type ReceiptRecord,
  type ReceiptStore,
  readReceipt,
} from "@odu/run-history/receipts";
import { pidAlive } from "@odu/run-history/owner";
import { type CatalogOptions, handleFor, readManifest } from "@odu/run-history/store";
import { type StateEnv, stateRoot } from "@odu/run-history/paths";
import { ServiceRefused } from "@odu/service-client/surface";

export function serviceRoot(
  env?: StateEnv,
  platform?: NodeJS.Platform,
): string {
  return join(stateRoot(env, platform), "service");
}

export function requestStore(opts: { root?: string } = {}): ReceiptStore {
  return { dir: opts.root ?? serviceRoot() };
}

export const DISPATCH_GRACE_MS = 120_000;

export type Reconciled =
  | { kind: "replay"; result: unknown }
  | { kind: "run_exists"; runId: string }
  | { kind: "nothing_happened" }
  | { kind: "unresolved"; reason: string };

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

export {
  claimReceipt,
  completeReceipt,
  digestOf,
  isRequestId,
  markDispatched,
  optionalPart,
  readReceipt,
  type ClaimOutcome,
  type ReceiptRecord,
  type ReceiptStore,
};

export async function onceOnly<T>(
  store: ReceiptStore,
  request: {
    requestId: string;
    kind: "venue.hold" | "venue.release" | "protect.apply";
    digest: string;
    now: number;
  },
  perform: () => Promise<T>,
): Promise<{ ok: true; value: T; replayed: boolean } | { ok: false; refusal: ServiceRefused }> {
  if (!isRequestId(request.requestId)) {
    return {
      ok: false,
      refusal: new ServiceRefused({
        code: "bad_input",
        message:
          `odu: "${request.requestId}" is not a usable request id — ` +
          "1–200 characters of letters, digits, dot, dash, underscore or colon",
      }),
    };
  }
  const claim = claimReceipt(store, {
    requestId: request.requestId,
    kind: request.kind,
    digest: request.digest,
    plannedRunId: "",
    now: request.now,
  });
  if (claim === null) {
    return {
      ok: false,
      refusal: new ServiceRefused({
        code: "bad_input",
        message: `odu: could not record request ${request.requestId}`,
      }),
    };
  }
  if (claim.kind === "conflict") {
    return {
      ok: false,
      refusal: new ServiceRefused({
        code: "request_conflict",
        message:
          `odu: request id "${request.requestId}" was already used for a ` +
          "different request — use a fresh id, or repeat the original exactly",
      }),
    };
  }
  if (claim.kind === "replay") {
    const recorded = claim.receipt.result;
    if (recorded !== undefined && recorded !== null) {
      return { ok: true, value: recorded as T, replayed: true };
    }
  }
  if (claim.kind === "in_flight" || claim.kind === "replay") {
    return {
      ok: false,
      refusal: new ServiceRefused({
        code: "request_unresolved",
        message:
          `odu: request "${request.requestId}" was accepted and its outcome is ` +
          "not recorded. Do not re-issue it under a new id — read the current " +
          "state (`odu ci hosts`, `odu ci protect --dry-run`) and decide from there.",
      }),
    };
  }
  const value = await perform();
  completeReceipt(store, request.requestId, value, request.now);
  return { ok: true, value, replayed: false };
}
