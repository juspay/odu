/**
 * The attention query — ONE durable answer to "what do I need to know about
 * this run right now", consumed by the native CLI today and by a service face
 * later.
 *
 * It exists because the alternative is what the field review found: an agent
 * polling `status`, piping `logs` through a buffering shell, and waiting for
 * every lane to settle before it learns that the fast one went red four
 * minutes ago. Each of those is a different reader inventing its own idea of
 * "anything new?", and none of them survives a disconnect.
 *
 * The shape below is arranged around four rules, and they are the ones that
 * are easy to get subtly wrong:
 *
 *   - A CURSOR SUPPRESSES REPEATS, IT DOES NOT RESOLVE ANYTHING. `events` is
 *     what has happened since the caller's cursor; `unresolved_failures` is
 *     the state of the run and is computed from the WHOLE journal every time.
 *     An agent that acknowledged a failure and then asked again still sees the
 *     failure — because it is still failing. Conflating the two is how a red
 *     run gets reported green to whoever asked second.
 *   - THE CURSOR ADVANCES ONLY THROUGH INCLUDED EVENTS. If the budget trims
 *     the tail, the cursor stops where the trim did, and `has_more` says so.
 *     A cursor that ran ahead of what was delivered would silently drop
 *     exactly the events a reconnecting caller came back for.
 *   - A SETTLED RUN ALWAYS RETURNS ITS VERDICT. Not "if you subscribe in
 *     time" — the journal's `finalized` line is durable, so the answer is the
 *     same an hour later.
 *   - RUNNING, GONE, AND FINISHED ARE THREE STATES. A deadline says
 *     `still_running`. An owner that is provably dead with no terminal line
 *     says `owner_lost`. Neither is a pass and neither is a failure, and a
 *     caller that cannot tell them apart will retry the wrong one.
 *
 * Pure. Evidence arrives through {@link AttentionSources}, so this module is
 * testable against a hand-built journal and the store composes it with real
 * files in `./query`.
 */

import type { NodeStatus } from "@odu/run-client/surface";
import { signalFromExit } from "./exit";
import { formatCursor, type Cursor } from "./ids";
import { isResumptionEvent } from "./schema";
import type {
  Expiry,
  JournalEntry,
  Placement,
  RunManifest,
  RunScope,
  RunVerdict,
} from "./schema";

/** Total encoded size of one attention payload. The transport's own envelope
 *  (an MCP frame, an HTTP body) is outside this — the budget is about what the
 *  DOMAIN puts in front of a reader, so the same number applies whichever face
 *  is asking. */
export const ATTENTION_BUDGET_BYTES = 16 * 1024;

/** Per-failure excerpt ceiling. Four of them still fit inside the budget, and
 *  four simultaneous unrelated failures is already a run whose first problem
 *  is not the excerpt length. */
export const EXCERPT_BUDGET_BYTES = 4 * 1024;

/** Default page size for `events`. The budget is the real bound; this stops a
 *  caller that has been away for an hour from building a megabyte of objects
 *  only to have them trimmed. */
export const DEFAULT_EVENT_LIMIT = 200;

/** Re-exported so a reader of this payload can spell the same reading the
 *  `signal` field was built with — see `./exit` for why it lives there. */
export { signalFromExit };

/**
 * Where a run stands, as four states that a caller must handle differently.
 *
 * `owner_lost` is the one that earns its keep. Before it, a coordinator killed
 * mid-run was indistinguishable from a slow one: both had no terminal line and
 * a socket that answered nothing. An agent then either waited forever or read
 * the absence as a failure. Here it is a state with a name, and the recovery
 * for it (start a new run) is different from the recovery for `still_running`
 * (wait, or ask again with the cursor).
 */
export type AttentionState =
  | "still_running"
  | "settled"
  | "owner_lost"
  | "expired"
  | "unknown_run";

export interface AttentionFailure {
  node: string;
  attempt: number;
  status: "failed" | "errored";
  exit_code: number | null;
  /** The signal the shell's exit status implies (`128 + N`), when the status
   *  looks like one. A READING, not a report — see the attempt record. */
  signal: string | null;
  placement: Placement;
  /** How to ask for this evidence again: the exact `--run/--attempt/NODE`
   *  triple, so an agent echoes rather than reassembles. */
  log_key: string;
  /** Did this attempt's log get its producer's last word? A `false` here with
   *  a non-empty excerpt is the honest "there was more and it is gone". */
  log_complete: boolean;
  log_bytes: number;
  /** Why the log is short, when it is. */
  log_truncation_reason: string | null;
  excerpt: string;
  /** Where the excerpt came from. Today there is exactly one source — the
   *  attempt's own log — and the field exists so that stays VISIBLE: a
   *  structured test reporter would add a value here, and until one does, no
   *  face may imply it had one. `none` means the log was unreadable, which is
   *  reported as itself and never as a passing or flaky node. */
  excerpt_source: "attempt_log" | "none";
  /** The excerpt is the tail of a longer log. */
  excerpt_truncated: boolean;
}

export interface AttentionEvent {
  seq: number;
  at: number;
  event: JournalEntry["event"];
}

export interface Attention {
  run: {
    id: string;
    sha: string | null;
    sha7: string | null;
    seq: number | null;
    repo: string | null;
    pipeline: string | null;
    repo_root: string | null;
    parent_run_id: string | null;
  };
  scope: RunScope | null;
  state: AttentionState;
  /** Every node in the roster reached a terminal status AND the run published
   *  its outcome. */
  settled: boolean;
  /** Settled with no red and no cancelled node. Never true for a run that is
   *  not settled — there is no such thing as "passing so far". */
  passed: boolean;
  /** The run's own terminal word, or null while it has none.
   *
   *  Carried BESIDE `passed` rather than derived from it, because `passed:
   *  false` covers two genuinely different endings: a run with a red node, and
   *  one that was cancelled or torn down before every node finished. Reporting
   *  the second as "failed" tells an operator to go looking for a test that
   *  broke, which is a wrong instruction rather than a vague one. */
  outcome: "passed" | "failed" | "incomplete" | null;
  /** There is a red node whose evidence is ready to read. The bit a bounded
   *  wait returns on, before the slow lanes finish. */
  actionable: boolean;
  /** The caller's new cursor. Feed it back as `after`. */
  cursor: string;
  events: AttentionEvent[];
  has_more: boolean;
  /** Events after `cursor` that this page did not carry. */
  remaining: number;
  /** Journal lines this reader could not parse — a torn tail, or a record from
   *  a newer writer. Reported rather than swallowed, so "nothing happened" and
   *  "I could not read what happened" stay different answers. */
  unreadable_events: number;
  unresolved_failures: AttentionFailure[];
  /** How many unresolved failures the run HAS, whether or not they all fit.
   *  A caller reading `unresolved_failures.length` alone would under-count a
   *  run with sixty red nodes and think it had seen them all. */
  unresolved_failures_total: number;
  /** Failures the budget could not carry. Non-zero means `unresolved_failures`
   *  is a prefix, not the set. */
  failures_omitted: number;
  /** Reporting-debt rows the budget could not carry. */
  debt_omitted: number;
  /** This payload is LARGER than the budget it was asked for.
   *
   *  Reachable in exactly one way, and it is deliberate: a caller must always
   *  be able to drain a journal, so one event is carried even when nothing
   *  else fits. A single event can be arbitrarily large (a roster of a
   *  thousand nodes is one event), so the alternative to exceeding the budget
   *  is a cursor that can never advance — a caller stuck asking the same
   *  question forever. Reported rather than hidden. */
  over_budget: boolean;
  /** Commit statuses this run owes GitHub. Debt, kept apart from the verdict:
   *  a run whose statuses did not land still passed or failed on its own. */
  reporting_debt: { context: string; last_error: string; attempts: number }[];
  /** The live endpoint serving this run, or null when nothing is. */
  endpoint: string | null;
}

/** One attempt's log, as the excerpt builder sees it. */
export interface ExcerptSource {
  text: string;
  /** Bytes in the whole log, so the payload can say the excerpt is a tail. */
  totalBytes: number;
}

export interface AttentionSources {
  runId: string;
  /** Where the caller has been served up to. Rides here as well as on the
   *  query because a caller that resolved the run also resolved its cursor —
   *  the query's own `after` wins when both are given. */
  after?: Cursor | null;
  manifest: RunManifest | null;
  journal: readonly JournalEntry[];
  unreadableEvents: number;
  verdict: RunVerdict | null;
  expiry: Expiry | null;
  /** Whether the run's owner is still alive, as far as the ownership fence can
   *  tell. `null` means the question was not asked (a caller that only wants
   *  the journal). */
  ownerAlive: boolean | null;
  endpoint: string | null;
  /** The tail of one attempt's log, bounded to `maxBytes`. `null` when the log
   *  cannot be read — reported as `excerpt_source: "none"`, never as an empty
   *  log that happened to produce nothing. */
  readExcerpt: (
    node: string,
    attempt: number,
    maxBytes: number,
  ) => ExcerptSource | null;
}

export interface AttentionQuery {
  after?: Cursor | null;
  limit?: number;
  budgetBytes?: number;
  excerptBytes?: number;
}

/** The last whole-character suffix of `text` that fits in `maxBytes`.
 *
 *  A tail rather than a head because the end of a failing log is where the
 *  reason is. Trimming by BYTES with a character-safe boundary, because the
 *  budget is a byte budget and a log full of box-drawing characters would blow
 *  a character-counted one by a factor of three. */
export function clampTailBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) {
    return { text, truncated: false };
  }
  // Walk back from the end by code points until the encoding fits. Code points
  // rather than UTF-16 units so a surrogate pair is never split.
  const chars = [...text];
  let bytes = 0;
  let take = 0;
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const size = encoder.encode(chars[i]).length;
    if (bytes + size > maxBytes) break;
    bytes += size;
    take += 1;
  }
  return { text: chars.slice(chars.length - take).join(""), truncated: true };
}

interface AttemptState {
  node: string;
  attempt: number;
  placement: Placement;
  status: NodeStatus | null;
  exitCode: number | null;
  durationMs: number | null;
  logComplete: boolean;
  logBytes: number;
  logReason: string | null;
}

/** Fold the journal into the run's current shape. Exported for the tests that
 *  care about the fold itself rather than the payload around it. */
export function foldJournal(journal: readonly JournalEntry[]): {
  roster: string[];
  /** The newest attempt recorded per node. */
  latest: Map<string, AttemptState>;
  finalized: RunVerdict["outcome"] | null;
  /**
   * Work STARTED AGAIN after the run published a terminal outcome.
   *
   * A `--linger` coordinator keeps serving past settlement so a node can be
   * retried, and a retry is not a new run: the same journal gains a fresh
   * `attempt_started` after its own `finalized` line. Reading "has this run
   * ever finalized" as "is this run settled" then reports a run that is
   * actively executing as finished — and a wait keyed on settlement returns
   * immediately, in the middle of the retry it was asked to watch.
   *
   * So settlement is a fact about the CURRENT execution, and this is the bit
   * that distinguishes them.
   */
  resumed: boolean;
  debt: Map<string, { context: string; lastError: string; attempts: number }>;
  scope: RunScope | null;
} {
  let roster: string[] = [];
  let scope: RunScope | null = null;
  let finalized: RunVerdict["outcome"] | null = null;
  let resumed = false;
  const latest = new Map<string, AttemptState>();
  const debt = new Map<
    string,
    { context: string; lastError: string; attempts: number }
  >();
  const key = (node: string, attempt: number): string => `${node}#${attempt}`;
  const byAttempt = new Map<string, AttemptState>();

  for (const entry of journal) {
    const e = entry.event;
    switch (e.kind) {
      case "registered":
        scope = e.scope;
        break;
      case "roster":
        roster = [...e.order];
        break;
      case "attempt_started": {
        // A new attempt after a terminal line is work resuming — see
        // `isResumptionEvent`, which is the rule the WRITER reads too.
        if (finalized !== null && isResumptionEvent(e)) resumed = true;
        const state: AttemptState = {
          node: e.node,
          attempt: e.attempt,
          placement: e.placement,
          status: null,
          exitCode: null,
          durationMs: null,
          logComplete: false,
          logBytes: 0,
          logReason: null,
        };
        byAttempt.set(key(e.node, e.attempt), state);
        // A newly started attempt supersedes the previous one for this node —
        // which is what makes "unresolved" mean the LATEST attempt rather than
        // any attempt that ever went red.
        latest.set(e.node, state);
        break;
      }
      case "node_status": {
        const k = key(e.node, e.attempt);
        const state = byAttempt.get(k) ?? {
          node: e.node,
          attempt: e.attempt,
          placement: e.placement,
          status: null,
          exitCode: null,
          durationMs: null,
          logComplete: false,
          logBytes: 0,
          logReason: null,
        };
        // Same for a node going back to pending/running — the same shared rule.
        if (finalized !== null && isResumptionEvent(e)) resumed = true;
        state.status = e.status;
        state.exitCode = e.exitCode;
        state.durationMs = e.durationMs;
        state.placement = e.placement;
        byAttempt.set(k, state);
        const current = latest.get(e.node);
        if (current === undefined || current.attempt <= e.attempt) {
          latest.set(e.node, state);
        }
        break;
      }
      case "log_finalized": {
        const k = key(e.node, e.attempt);
        const state = byAttempt.get(k);
        if (state !== undefined) {
          state.logComplete = e.complete;
          state.logBytes = e.bytes;
          state.logReason = e.reason;
        }
        break;
      }
      case "posting_debt":
        debt.set(e.context, {
          context: e.context,
          lastError: e.lastError,
          attempts: e.attempts,
        });
        break;
      case "finalized":
        finalized = e.outcome;
        // A run that resumed and then finalized AGAIN is settled once more —
        // the flag describes the tail of the journal, not its history.
        resumed = false;
        break;
      default:
        break;
    }
  }
  return { roster, latest, finalized, resumed, debt, scope };
}

const RED = new Set(["failed", "errored"]);

/** Build the attention payload. */
export function attentionFor(
  sources: AttentionSources,
  query: AttentionQuery = {},
): Attention {
  const budget = query.budgetBytes ?? ATTENTION_BUDGET_BYTES;
  const excerptBudget = query.excerptBytes ?? EXCERPT_BUDGET_BYTES;
  const limit = Math.max(1, query.limit ?? DEFAULT_EVENT_LIMIT);
  const manifest = sources.manifest;
  const fold = foldJournal(sources.journal);

  const state = classify(sources, fold);
  const settled = state === "settled";
  // The terminal word of the CURRENT execution. A run that resumed after
  // finalizing has none — its previous outcome describes an execution that is
  // over, and reporting it beside `state: still_running` would invite a reader
  // to act on a verdict about work that is being redone right now.
  const verdictOutcome = fold.resumed
    ? null
    : (sources.verdict?.outcome ?? fold.finalized);
  const passed = settled && verdictOutcome === "passed";

  const failures: AttentionFailure[] = [];
  for (const node of fold.roster.length > 0 ? fold.roster : [...fold.latest.keys()]) {
    const attempt = fold.latest.get(node);
    if (attempt === undefined) continue;
    if (attempt.status === null || !RED.has(attempt.status)) continue;
    const source = sources.readExcerpt(node, attempt.attempt, excerptBudget);
    const clamped =
      source === null
        ? { text: "", truncated: false }
        : clampTailBytes(source.text, excerptBudget);
    failures.push({
      node,
      attempt: attempt.attempt,
      status: attempt.status === "errored" ? "errored" : "failed",
      exit_code: attempt.exitCode,
      signal: signalFromExit(attempt.exitCode),
      placement: attempt.placement,
      log_key: `--run ${sources.runId} --attempt ${attempt.attempt} ${node}`,
      log_complete: attempt.logComplete,
      log_bytes: attempt.logBytes || (source?.totalBytes ?? 0),
      log_truncation_reason: attempt.logReason,
      excerpt: clamped.text,
      excerpt_source: source === null ? "none" : "attempt_log",
      excerpt_truncated: clamped.truncated,
    });
  }

  // A failure is ACTIONABLE once its log has had its last word — that is the
  // barrier the whole "return red before the slow lane finishes" promise rests
  // on. Reporting a red node whose output is still arriving would hand an
  // agent a half-written reason and invite it to act on the wrong line.
  const actionable = failures.some((f) => f.log_complete) || settled;

  // The query's own `after` wins: a caller that names one on the call is
  // saying "from here", and a stale cursor carried on the sources must not
  // quietly override it.
  const afterSeq = (query.after ?? sources.after)?.seq ?? 0;
  const pending = sources.journal.filter((e) => e.seq > afterSeq);
  const debtRows = [...fold.debt.values()].map((d) => ({
    context: d.context,
    last_error: d.lastError,
    attempts: d.attempts,
  }));

  const identity: Omit<
    Attention,
    | "events"
    | "cursor"
    | "has_more"
    | "remaining"
    | "unresolved_failures"
    | "unresolved_failures_total"
    | "failures_omitted"
    | "debt_omitted"
    | "over_budget"
    | "reporting_debt"
  > = {
    run: {
      id: sources.runId,
      sha: manifest?.sha ?? null,
      sha7: manifest?.sha.slice(0, 7) ?? null,
      seq: manifest?.seq ?? null,
      repo: manifest?.repo ?? null,
      pipeline: manifest?.pipeline ?? null,
      repo_root: manifest?.repoRoot ?? null,
      parent_run_id: manifest?.parentRunId ?? null,
    },
    scope: fold.scope ?? manifest?.scope ?? null,
    state,
    settled,
    passed,
    outcome: verdictOutcome ?? null,
    actionable,
    unreadable_events: sources.unreadableEvents,
    endpoint: sources.endpoint,
  };

  const build = (
    events: readonly JournalEntry[],
    fails: readonly AttentionFailure[],
    debt: readonly Attention["reporting_debt"][number][],
    overBudget: boolean,
  ): Attention => ({
    ...identity,
    events: events.map((e) => ({ seq: e.seq, at: e.at, event: e.event })),
    // Through INCLUDED events only. A cursor past what was delivered is a
    // silent drop, and this is the one line that decides it.
    cursor: formatCursor({ runId: sources.runId, seq: events.at(-1)?.seq ?? afterSeq }),
    has_more: events.length < pending.length,
    remaining: pending.length - events.length,
    unresolved_failures: [...fails],
    unresolved_failures_total: failures.length,
    failures_omitted: failures.length - fails.length,
    reporting_debt: [...debt],
    debt_omitted: debtRows.length - debt.length,
    over_budget: overBudget,
  });

  /**
   * Shed until it fits, in the order that costs a caller least.
   *
   * PROGRESS IS RESERVED FIRST, and that is the ordering decision that matters.
   * Shedding events down to zero and then dropping failures leaves a payload
   * whose cursor did not move — so the next call returns the same oversized
   * answer, and a caller with sixty red nodes can never drain its backlog. One
   * event is held back from every reduction below, so the cursor always
   * advances and the loop always terminates.
   *
   * After that the order is by REPLAYABILITY: events beyond the first are
   * re-served on the next call with the returned cursor, so they go first;
   * excerpts shrink next (the reason survives, shorter); failure and debt rows
   * go last and are COUNTED when they do, because a caller that is shown three
   * of sixty failures must not read that as three.
   */
  const fits = (a: Attention): boolean => encodedBytes(a) <= budget;
  const keep = pending.length > 0 ? 1 : 0;
  let events = pending.slice(0, limit);
  let fails: AttentionFailure[] = [...failures];
  let debt = debtRows;

  while (events.length > keep && !fits(build(events, fails, debt, false))) {
    events = events.slice(0, Math.max(keep, Math.floor(events.length / 2)));
  }
  for (
    let cap = excerptBudget;
    cap > 0 && !fits(build(events, fails, debt, false));
    cap = Math.floor(cap / 2)
  ) {
    fails = fails.map((f) => {
      const cut = clampTailBytes(f.excerpt, cap);
      return {
        ...f,
        excerpt: cut.text,
        excerpt_truncated: f.excerpt_truncated || cut.truncated,
      };
    });
  }
  while (fails.length > 0 && !fits(build(events, fails, debt, false))) {
    fails = fails.slice(0, fails.length - 1);
  }
  while (debt.length > 0 && !fits(build(events, fails, debt, false))) {
    debt = debt.slice(0, debt.length - 1);
  }
  // Built ONCE and measured, rather than built twice more to decide a boolean
  // about itself: `over_budget` is a fact about the payload that is about to be
  // returned, so the payload is the thing to ask.
  const fitted = build(events, fails, debt, false);
  return fits(fitted) ? fitted : build(events, fails, debt, true);
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Where the run stands NOW.
 *
 * "Has it ever finalized" is not the question. A `--linger` run that settles,
 * takes a retry, and starts executing again has a `finalized` line in its
 * journal AND a node running right now; answering `settled` there ends a wait
 * in the middle of the very retry it was watching, and reports the previous
 * verdict as this execution's. `fold.resumed` is the journal's own answer to
 * "did work start again after that line", and it is what makes the state
 * describe the present tense.
 */
function classify(
  sources: AttentionSources,
  fold: ReturnType<typeof foldJournal>,
): AttentionState {
  if (sources.expiry !== null) return "expired";
  if (sources.manifest === null && sources.journal.length === 0) {
    return "unknown_run";
  }
  const hasTerminal = sources.verdict !== null || fold.finalized !== null;
  if (hasTerminal && !fold.resumed) return "settled";
  if (sources.ownerAlive === false) return "owner_lost";
  return "still_running";
}
