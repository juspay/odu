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
import { hostname } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { createExclusive, writeAtomic } from "./atomic";
import { RUN_FILES } from "./paths";
import { RUN_RECORD_FORMAT } from "./schema";


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
  /** What kind of mutation this receipt is for.
   *
   *  `retry` is claimed against ONE RUN's evidence directory; `start` and
   *  `cancel` are claimed against the service's own, because a start has no run
   *  to belong to yet (that being exactly why it needs a receipt) and a cancel
   *  must stay answerable after the run it named has expired.
   *
   *  A build older than this one meeting a `start` or `cancel` receipt fails to
   *  decode it, and `readReceipt` answers `null` — which every caller here
   *  treats as "unreadable, do not assume free". Fail-closed, and only reachable
   *  for the run-scoped `retry` directory, since the service's own is a
   *  directory no previous build ever reads. */
  kind: Schema.Literals(["retry", "start", "cancel"]),
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
  /**
   * When this request actually put a mutation on the wire, if it got that far.
   *
   * The line between "I claimed an id" and "I asked somebody to change
   * something". Before it, a missing outcome means nothing happened and
   * re-issuing is safe; after it, a missing outcome means the answer was lost
   * and the mutation may well have landed — a distinction the claim alone
   * cannot make, because claiming happens whether or not the dispatch that
   * follows ever leaves the process.
   *
   * The coordinator's own `retry_accepted` line is the better evidence and is
   * consulted first; this is what remains when that evidence CANNOT exist —
   * a coordinator from a build that did not record request ids, or a journal
   * with lines this build cannot read. Fail-closed: unresolved stays
   * unresolved rather than becoming permission to mutate a second time.
   *
   * `optionalKey`, so receipts written before this field decode unchanged.
   * Their absence reads as "never dispatched", which is the same answer the
   * old code assumed for every receipt.
   */
  dispatchedAt: Schema.optionalKey(Schema.Number),
  /**
   * WHICH PROCESS holds this claim, so a repeat can ask whether it is still
   * capable of dispatching instead of guessing from a clock.
   *
   * The whole point. An undispatched claim used to be read as a no-op once it
   * was merely OLD, which fences nothing: elapsed time is not evidence, the
   * claimant may be paused in a dial and about to mutate, and a longer grace
   * only moves the race. A pid on a host is evidence — the same evidence the
   * ownership fence next door requires, applied the same way: a claim is
   * abandoned when its process is GONE on THIS host, never merely when it is
   * quiet, and never at all when it was claimed somewhere else.
   *
   * `optionalKey`, so receipts written before this field decode unchanged.
   * Their absence means the question cannot be asked, which reads as UNKNOWN —
   * the safe direction.
   */
  claimant: Schema.optionalKey(
    Schema.Struct({ pid: Schema.Int, host: Schema.String }),
  ),
  /**
   * Every root this request intends to act on, written BEFORE the first one is
   * dispatched.
   *
   * A retry can name several roots and they go out one at a time, so the
   * coordinator's per-root records are a growing set while the request is in
   * flight. Reading the intent from those records made a repeat that arrived
   * between two roots believe the first was the whole request — and complete
   * the receipt with a permanently short answer. The intended set is fixed
   * before any of it happens, so "is this request finished" is a question with
   * an answer instead of a race.
   */
  roots: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The receipt's payload once completed — the addressed answer the caller
   *  gets, replayed verbatim on a repeat so two asks cannot get two different
   *  descriptions of one action. */
  result: Schema.NullOr(Schema.Unknown),
});
export type ReceiptRecord = typeof ReceiptSchema.Type;

const decodeReceipt = Schema.decodeUnknownResult(ReceiptSchema);

/**
 * WHERE a set of receipts lives — a directory, and nothing else.
 *
 * Deliberately NOT a `RunHandle`. A receipt is "an idempotency claim in a
 * directory", and that is true of a retry claimed against one run's evidence
 * and of a `run.start` claimed against the service's own state, which has no
 * run to belong to yet — that being the whole reason `start` needs one. Typing
 * this as a run made the run part of the concept and would have forced a second
 * copy of every function below the moment a caller had no run to name.
 *
 * `RunHandle` satisfies it structurally, so every run-scoped call site is
 * unchanged.
 */
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
  store: ReceiptStore,
  input: {
    requestId: string;
    kind: ReceiptRecord["kind"];
    digest: string;
    plannedRunId: string;
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
    plannedRunId: input.plannedRunId,
    // Stamped at the claim, because that is the moment the claimant exists.
    claimant: input.claimant ?? { pid: process.pid, host: hostname() },
    result: null,
  };
  const path = receiptPath(store, input.requestId);
  if (createExclusive(path, `${JSON.stringify(receipt, null, 2)}\n`)) {
    return { kind: "claimed", receipt };
  }
  const existing = readReceipt(store, input.requestId);
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

/**
 * Note that this request is about to mutate something — see
 * {@link ReceiptSchema}'s `dispatchedAt`.
 *
 * Called BEFORE the dispatch it describes, which is the only ordering that
 * helps: a marker written afterwards is missing in exactly the case it exists
 * for. Best-effort — a receipt that cannot be re-read is left alone, and the
 * caller's reconciliation treats an absent marker conservatively anyway.
 */
export function markDispatched(
  store: ReceiptStore,
  requestId: string,
  /** The complete set of roots this request will act on — see
   *  {@link ReceiptSchema}'s `roots`. Recorded in the SAME write as the
   *  dispatch marker, because a request whose intent is known but whose
   *  dispatch is not, and one whose dispatch is known but whose intent is not,
   *  are both states a reconciler would have to guess about. */
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
 *  already-completed receipt leaves the first result in place, so a race
 *  between a reconciler and the original caller cannot rewrite history. */
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

/** Every receipt on a run, for a face that wants to show what was asked of
 *  it. Unreadable files are skipped, as everywhere else in this package. */
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

/**
 * The field separator inside a digest's canonical spelling.
 *
 * NUL, because it is the one byte that cannot appear in any of the parts —
 * they are node ids, selectors and numbers — so `["a b", "c"]` and
 * `["a", "b c"]` cannot canonicalise to the same string. A space would let
 * exactly that collision through, and the collision is silent: two different
 * requests would share a digest and the second would be replayed as the first.
 *
 * Named rather than written inline, and built with `fromCharCode` rather than
 * embedded: a literal NUL in the source is invisible in an editor and makes
 * every `grep` treat this file as binary and return nothing.
 */
const DIGEST_SEP = String.fromCharCode(0);

/**
 * A stable digest of a request's meaningful input.
 *
 * FNV-1a over a canonical spelling: the point is to notice that two requests
 * wearing one id are different, not to resist an adversary — a caller that
 * wanted to forge a collision could simply use a different id. Canonical
 * because the digest must not depend on how a caller happened to spell a
 * part.
 */
export function digestOf(parts: readonly (string | number | boolean)[]): string {
  const canonical = parts.map((p) => String(p)).join(DIGEST_SEP);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}
