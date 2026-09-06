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
  debt: Map<string, { context: string; lastError: string; attempts: number }>;
  scope: RunScope | null;
} {
  let roster: string[] = [];
  let scope: RunScope | null = null;
  let finalized: RunVerdict["outcome"] | null = null;
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
        break;
      default:
        break;
    }
  }
  return { roster, latest, finalized, debt, scope };
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
  const verdictOutcome = sources.verdict?.outcome ?? fold.finalized;
  const settled = state === "settled";
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

  let included = pending.slice(0, limit);
  const base: Attention = {
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
    actionable,
    cursor: formatCursor({ runId: sources.runId, seq: afterSeq }),
    events: [],
    has_more: false,
    remaining: 0,
    unreadable_events: sources.unreadableEvents,
    unresolved_failures: failures,
    reporting_debt: [...fold.debt.values()].map((d) => ({
      context: d.context,
      last_error: d.lastError,
      attempts: d.attempts,
    })),
    endpoint: sources.endpoint,
  };

  // Fit the payload. Events go first because they are REPLAYABLE — the cursor
  // stays where the trim stopped, so a caller that asks again gets exactly
  // what was dropped. Excerpts shrink only after there are no events left to
  // shed, because an excerpt is the reason the caller was woken up and a
  // second call does not make it appear.
  for (;;) {
    const candidate = withPage(base, included, pending.length, sources.runId, afterSeq);
    if (encodedBytes(candidate) <= budget || included.length === 0) {
      if (encodedBytes(candidate) <= budget) return candidate;
      break;
    }
    included = included.slice(0, Math.max(0, Math.floor(included.length / 2)));
  }

  // No events left and still over budget: the failures themselves are too big.
  // Halve every excerpt until they fit, then give up gracefully — a payload
  // that reports the failure with no excerpt is still an answer, and a truncated
  // excerpt says so.
  let shrunk = base.unresolved_failures;
  for (let i = 0; i < 12; i += 1) {
    const candidate = withPage(
      { ...base, unresolved_failures: shrunk },
      [],
      pending.length,
      sources.runId,
      afterSeq,
    );
    if (encodedBytes(candidate) <= budget) return candidate;
    shrunk = shrunk.map((f) => {
      const half = clampTailBytes(
        f.excerpt,
        Math.floor(new TextEncoder().encode(f.excerpt).length / 2),
      );
      return {
        ...f,
        excerpt: half.text,
        excerpt_truncated: f.excerpt_truncated || half.truncated,
      };
    });
  }
  return withPage(
    { ...base, unresolved_failures: shrunk },
    [],
    pending.length,
    sources.runId,
    afterSeq,
  );
}

function withPage(
  base: Attention,
  included: readonly JournalEntry[],
  pendingCount: number,
  runId: string,
  afterSeq: number,
): Attention {
  const last = included.at(-1);
  return {
    ...base,
    events: included.map((e) => ({ seq: e.seq, at: e.at, event: e.event })),
    // Through INCLUDED events only. A cursor past what was delivered is a
    // silent drop, and this is the one line that decides it.
    cursor: formatCursor({ runId, seq: last?.seq ?? afterSeq }),
    has_more: included.length < pendingCount,
    remaining: pendingCount - included.length,
  };
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function classify(
  sources: AttentionSources,
  fold: ReturnType<typeof foldJournal>,
): AttentionState {
  if (sources.expiry !== null) return "expired";
  if (sources.manifest === null && sources.journal.length === 0) {
    return "unknown_run";
  }
  if (sources.verdict !== null || fold.finalized !== null) return "settled";
  if (sources.ownerAlive === false) return "owner_lost";
  return "still_running";
}
