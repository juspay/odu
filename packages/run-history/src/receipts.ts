import { readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { createExclusive, writeAtomic } from "./atomic";
import { RUN_FILES } from "./paths";
import { RUN_RECORD_FORMAT } from "./schema";


/** A request id becomes a filename: it is constrained rather than escaped. */
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isRequestId(value: string): boolean {
  return REQUEST_ID_RE.test(value) && value !== "." && value !== "..";
}

export const ReceiptSchema = Schema.Struct({
  version: Schema.Literal(RUN_RECORD_FORMAT),
  requestId: Schema.String,
  /** What kind of mutation this receipt is for. `retry` is claimed against ONE
   *  RUN's evidence directory; `start`, `cancel` and `catalog` are claimed
   *  against the service's own. */
  kind: Schema.Literals([
    "retry",
    "start",
    "cancel",
    "catalog",
    "venue.hold",
    "venue.release",
    "protect.apply",
  ]),
  /** A hash of the request's meaningful input. A repeat with the same id and a
   *  different digest is a conflict, not a replay. */
  digest: Schema.String,
  /** `accepted` — claimed, not yet known to have happened.
   *  `completed` — it happened, and `result` describes it. */
  state: Schema.Literals(["accepted", "completed"]),
  acceptedAt: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
  /**
   * The run id this request would act THROUGH if it needs a new run, minted at
   * accept time and never after. The run actually acted on is in `result`,
   * once there is one.
   */
  plannedRunId: Schema.String,
  /** When this request actually put a mutation on the wire, if it got that
   *  far. */
  dispatchedAt: Schema.optionalKey(Schema.Number),
  /** WHICH PROCESS holds this claim: pid and host. */
  claimant: Schema.optionalKey(
    Schema.Struct({ pid: Schema.Int, host: Schema.String }),
  ),
  /** Every root this request intends to act on. */
  roots: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The receipt's payload once completed — the addressed answer the caller
   *  gets, replayed verbatim on a repeat. */
  result: Schema.NullOr(Schema.Unknown),
});
export type ReceiptRecord = typeof ReceiptSchema.Type;

export type ReceiptKind = ReceiptRecord["kind"];

export interface ReceiptRule {
  readonly preMintsRun: boolean;
  readonly reconciled: boolean;
}

export const RECEIPT_RULES: Readonly<Record<ReceiptKind, ReceiptRule>> = {
  retry: { preMintsRun: true, reconciled: false },
  start: { preMintsRun: true, reconciled: true },
  cancel: { preMintsRun: false, reconciled: false },
  catalog: { preMintsRun: false, reconciled: false },
  "venue.hold": { preMintsRun: false, reconciled: false },
  "venue.release": { preMintsRun: false, reconciled: false },
  "protect.apply": { preMintsRun: false, reconciled: false },
};

const decodeReceipt = Schema.decodeUnknownResult(ReceiptSchema);

/** WHERE a set of receipts lives — a directory, and nothing else. */
export interface ReceiptStore {
  readonly dir: string;
}

function receiptPath(store: ReceiptStore, requestId: string): string {
  return join(store.dir, RUN_FILES.receipts, `${requestId}.json`);
}

export function readReceipt(
  store: ReceiptStore,
  requestId: string,
): ReceiptRecord | null {
  if (!isRequestId(requestId)) return null;
  let text: string;
  try {
    text = readFileSync(receiptPath(store, requestId), "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const decoded = decodeReceipt(parsed);
  return Result.isSuccess(decoded) ? decoded.success : null;
}

export type ClaimOutcome =
  /** This caller won the id and must now do the work. */
  | { kind: "claimed"; receipt: ReceiptRecord }
  /** Somebody already did it. Replay `receipt.result`. */
  | { kind: "replay"; receipt: ReceiptRecord }
  /** Somebody claimed it and has not finished. */
  | { kind: "in_flight"; receipt: ReceiptRecord }
  /** The id is taken, and its receipt did not decode. */
  | { kind: "held_unreadable" }
  /** The same id, different input. */
  | { kind: "conflict"; receipt: ReceiptRecord };

/** Claim a request id, or report what already holds it. It does not wait. */
export function claimReceipt(
  store: ReceiptStore,
  input: {
    requestId: string;
    kind: ReceiptKind;
    digest: string;
    mint?: () => string;
    /** Injected by tests; production stamps this process. */
    claimant?: { pid: number; host: string };
    now?: number;
  },
): ClaimOutcome | null {
  if (!isRequestId(input.requestId)) return null;
  const receipt: ReceiptRecord = {
    version: RUN_RECORD_FORMAT,
    requestId: input.requestId,
    kind: input.kind,
    digest: input.digest,
    state: "accepted",
    acceptedAt: input.now ?? Date.now(),
    completedAt: null,
    plannedRunId: RECEIPT_RULES[input.kind].preMintsRun
      ? (input.mint as () => string)()
      : "",
    claimant: input.claimant ?? { pid: process.pid, host: hostname() },
    result: null,
  };
  const path = receiptPath(store, input.requestId);
  if (createExclusive(path, `${JSON.stringify(receipt, null, 2)}\n`)) {
    return { kind: "claimed", receipt };
  }
  const existing = readReceipt(store, input.requestId);
  if (existing === null) return { kind: "held_unreadable" };
  if (existing.digest !== input.digest) {
    return { kind: "conflict", receipt: existing };
  }
  return existing.state === "completed"
    ? { kind: "replay", receipt: existing }
    : { kind: "in_flight", receipt: existing };
}

/** Note that this request is about to mutate something. Best-effort. */
export function markDispatched(
  store: ReceiptStore,
  requestId: string,
  /** The complete set of roots this request will act on. */
  roots: readonly string[],
  now: number = Date.now(),
): void {
  const existing = readReceipt(store, requestId);
  if (existing === null || existing.state === "completed") return;
  if (existing.dispatchedAt !== undefined) return;
  writeAtomic(
    receiptPath(store, requestId),
    `${JSON.stringify({ ...existing, dispatchedAt: now, roots: [...roots] }, null, 2)}\n`,
  );
}

/** Record what a claimed request actually did. Idempotent: completing an
 *  already-completed receipt leaves the first result in place. */
export function completeReceipt(
  store: ReceiptStore,
  requestId: string,
  result: unknown,
  now: number = Date.now(),
): ReceiptRecord | null {
  const existing = readReceipt(store, requestId);
  if (existing === null) return null;
  if (existing.state === "completed") return existing;
  const completed: ReceiptRecord = {
    ...existing,
    state: "completed",
    completedAt: now,
    result,
  };
  writeAtomic(
    receiptPath(store, requestId),
    `${JSON.stringify(completed, null, 2)}\n`,
  );
  return completed;
}

/** Every receipt on a run. Unreadable files are skipped. */
export function listReceipts(store: ReceiptStore): ReceiptRecord[] {
  let entries: string[];
  try {
    entries = readdirSync(join(store.dir, RUN_FILES.receipts));
  } catch {
    return [];
  }
  const out: ReceiptRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const receipt = readReceipt(store, entry.slice(0, -".json".length));
    if (receipt !== null) out.push(receipt);
  }
  return out.sort((a, b) => a.acceptedAt - b.acceptedAt);
}

/** The field separator inside a digest's canonical spelling. */
const DIGEST_SEP = String.fromCharCode(0);

/** A stable digest of a request's meaningful input: FNV-1a over a canonical
 *  spelling. Not collision-resistant against an adversary. */
export function digestOf(parts: readonly (string | number | boolean)[]): string {
  const canonical = parts.map((p) => String(p)).join(DIGEST_SEP);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

/** Encode an optional digest part: `absent` when the value is absent,
 *  `set:<value>` when it is present. */
export function optionalPart(value: string | undefined): string {
  return value === undefined ? "absent" : `set:${value}`;
}
