/**
 * Receipts — how a mutation that may be asked for twice is performed once.
 *
 * The problem is not concurrency, or not only. An agent asks odu to retry a
 * node; the reply is lost (the link dropped, the harness restarted, the tool
 * call timed out); the agent asks again. Without a receipt the second ask is
 * indistinguishable from a first, so it retries again — and for a FINALIZED
 * retry, which starts a whole new run, that is two runs where the caller meant
 * one, competing for the same venue lease.
 *
 * So a request carries an ID, and the ID is claimed on disk with
 * `O_CREAT|O_EXCL` before anything is done. Exactly one claimant wins; the
 * loser reads what the winner recorded. That is the same primitive the
 * ownership fence uses, for the same reason: it is the one filesystem
 * operation whose atomicity every POSIX filesystem promises.
 *
 * TWO PHASES, because a crash between "I accepted" and "I did it" is the case
 * this has to survive rather than the case it can ignore:
 *
 *   - `claimReceipt` writes `accepted` with the request's digest AND the run
 *     id a new run would publish under, PRE-MINTED before anything is started,
 *     which is what makes the next step possible;
 *   - `completeReceipt` records the result once it has happened.
 *
 * A repeat that finds an `accepted`-but-not-completed receipt does NOT redo
 * the work: it reconciles by looking for the effect (does that run id exist in
 * the catalog?) and either completes the receipt or re-issues. Reconciling by
 * identity rather than by repeating a mutation is the whole point — see
 * {@link ReceiptRecord.plannedRunId}.
 *
 * A repeat with the same ID and DIFFERENT input is refused. Two different
 * requests wearing one id is a caller bug, and answering it with either
 * outcome would be worse than saying so.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { createExclusive, writeAtomic } from "./atomic";
import { RUN_RECORD_FORMAT } from "./schema";
import { type RunHandle } from "./store";

/** Where a run's receipts live, beside its journal. */
const RECEIPTS_DIR = "receipts";

/** A request id is a caller's string and becomes a filename, so it is
 *  constrained rather than escaped: a caller that can name a file is a caller
 *  that can name any file. Generous enough for a uuid, a ULID, or a human
 *  label; anything else is refused at the door. */
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isRequestId(value: string): boolean {
  return REQUEST_ID_RE.test(value) && value !== "." && value !== "..";
}

export const ReceiptSchema = Schema.Struct({
  version: Schema.Literal(RUN_RECORD_FORMAT),
  requestId: Schema.String,
  /** What kind of mutation this receipt is for. */
  kind: Schema.Literals(["retry"]),
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
   * accept time and never after.
   *
   * "Planned", not "effective", and the distinction is the whole reconciliation
   * story. A retry does not know until it tries whether the run it names is
   * still live: if it is, the retry lands on that run and this id is never
   * used; if it is not, a new run is started and publishes under exactly this
   * id. So a repeat whose reply was lost has a question with an answer — does
   * a run with this id exist in the catalog? — instead of having to spawn again
   * to find out. The run actually acted on is in `result`, once there is one.
   */
  plannedRunId: Schema.String,
  /** The receipt's payload once completed — the addressed answer the caller
   *  gets, replayed verbatim on a repeat so two asks cannot get two different
   *  descriptions of one action. */
  result: Schema.NullOr(Schema.Unknown),
});
export type ReceiptRecord = typeof ReceiptSchema.Type;

const decodeReceipt = Schema.decodeUnknownResult(ReceiptSchema);

function receiptPath(handle: RunHandle, requestId: string): string {
  return join(handle.dir, RECEIPTS_DIR, `${requestId}.json`);
}

export function readReceipt(
  handle: RunHandle,
  requestId: string,
): ReceiptRecord | null {
  if (!isRequestId(requestId)) return null;
  let text: string;
  try {
    text = readFileSync(receiptPath(handle, requestId), "utf-8");
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
  /** Somebody claimed it and has not finished. Reconcile — see the header. */
  | { kind: "in_flight"; receipt: ReceiptRecord }
  /** The same id, different input. */
  | { kind: "conflict"; receipt: ReceiptRecord };

/**
 * Claim a request id, or report what already holds it.
 *
 * Note what this does NOT do: it does not wait, and it does not decide what a
 * caller should do about an in-flight claim. Waiting would be a lock, and a
 * lock held by a process that died is exactly the failure the ownership fence
 * next door exists to avoid repeating here. The caller reconciles from the
 * identity in the receipt, which is a question with an answer.
 */
export function claimReceipt(
  handle: RunHandle,
  input: {
    requestId: string;
    kind: ReceiptRecord["kind"];
    digest: string;
    plannedRunId: string;
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
    plannedRunId: input.plannedRunId,
    result: null,
  };
  const path = receiptPath(handle, input.requestId);
  if (createExclusive(path, `${JSON.stringify(receipt, null, 2)}\n`)) {
    return { kind: "claimed", receipt };
  }
  const existing = readReceipt(handle, input.requestId);
  if (existing === null) {
    // The file is there but unreadable — a torn write, or a format this build
    // does not know. Treating it as free would risk doing the work twice, so
    // it is reported as in-flight with nothing to reconcile against; the
    // caller's own refusal names the id.
    return {
      kind: "in_flight",
      receipt: { ...receipt, plannedRunId: "" },
    };
  }
  if (existing.digest !== input.digest) {
    return { kind: "conflict", receipt: existing };
  }
  return existing.state === "completed"
    ? { kind: "replay", receipt: existing }
    : { kind: "in_flight", receipt: existing };
}

/** Record what a claimed request actually did. Idempotent: completing an
 *  already-completed receipt leaves the first result in place, so a race
 *  between a reconciler and the original caller cannot rewrite history. */
export function completeReceipt(
  handle: RunHandle,
  requestId: string,
  result: unknown,
  now: number = Date.now(),
): ReceiptRecord | null {
  const existing = readReceipt(handle, requestId);
  if (existing === null) return null;
  if (existing.state === "completed") return existing;
  const completed: ReceiptRecord = {
    ...existing,
    state: "completed",
    completedAt: now,
    result,
  };
  writeAtomic(
    receiptPath(handle, requestId),
    `${JSON.stringify(completed, null, 2)}\n`,
  );
  return completed;
}

/** Every receipt on a run, for a face that wants to show what was asked of
 *  it. Unreadable files are skipped, as everywhere else in this package. */
export function listReceipts(handle: RunHandle): ReceiptRecord[] {
  let entries: string[];
  try {
    entries = readdirSync(join(handle.dir, RECEIPTS_DIR));
  } catch {
    return [];
  }
  const out: ReceiptRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const receipt = readReceipt(handle, entry.slice(0, -".json".length));
    if (receipt !== null) out.push(receipt);
  }
  return out.sort((a, b) => a.acceptedAt - b.acceptedAt);
}

/**
 * A stable digest of a request's meaningful input.
 *
 * FNV-1a over a canonical spelling: the point is to notice that two requests
 * wearing one id are different, not to resist an adversary — a caller that
 * wanted to forge a collision could simply use a different id. Canonical
 * because the digest must not depend on key order or on how a caller happened
 * to spell an empty list.
 */
export function digestOf(parts: readonly (string | number | boolean)[]): string {
  const canonical = parts.map((p) => String(p)).join(" ");
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}
