import type { NodeStatus } from "@odu/run-client/surface";
import { pushTotals } from "@odu/run-client/surface";
import { signalFromExit } from "./exit";
import { formatCursor, type Cursor } from "./ids";
import { isResumptionEvent } from "./schema";
import type {
  Expiry,
  JournalEntry,
  NodePush,
  Placement,
  RunManifest,
  RunScope,
  RunVerdict,
} from "./schema";

/** Total encoded size of one attention payload. The transport's own envelope
 *  (an MCP frame, an HTTP body) is outside this. */
export const ATTENTION_BUDGET_BYTES = 16 * 1024;

/** Per-failure excerpt ceiling. */
export const EXCERPT_BUDGET_BYTES = 4 * 1024;

/** Default page size for `events`. The budget is the real bound. */
export const DEFAULT_EVENT_LIMIT = 200;

export { signalFromExit };

/**
 * Where a run stands, as four states that a caller must handle differently.
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
   *  triple. */
  log_key: string;
  /** Did this attempt's log get its producer's last word? A `false` here with
   *  a non-empty excerpt is the honest "there was more and it is gone". */
  log_complete: boolean;
  log_bytes: number;
  /** Why the log is short, when it is. */
  log_truncation_reason: string | null;
  excerpt: string;
  /** Where the excerpt came from. `none` means the log was unreadable, which is
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
    content_sha: string | null;
    dirty: boolean;
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
  /** The run's own terminal word, or null while it has none. */
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
  /** This payload is LARGER than the budget it was asked for. */
  over_budget: boolean;
  /** Commit statuses this run owes GitHub. Debt, kept apart from the verdict:
   *  a run whose statuses did not land still passed or failed on its own. */
  reporting_debt: { context: string; last_error: string; attempts: number }[];
  /** The live endpoint serving this run, or null when nothing is. */
  endpoint: string | null;

  /**
   * WHO STARTED THIS RUN (PLAN 4.4) — a login, or `@local` for a loopback
   * caller. Absent for a run recorded before the field, which is not the same
   * as a run nobody started.
   */
  actor?: string;

  /**
   * WHERE THIS RUN PUSHED WHAT IT BUILT (PLAN 4.1), and how much landed.
   *
   * Absent for a run recorded before the field, which is NOT the same as a
   * run that pushed nothing — that one has `target: null` and a `skipped`
   * reason. The counts are summed over the journal's `pushed` events, so a
   * run read a week later still answers without the bucket being asked.
   */
  push?: {
    target: { substituter: string; bucket: string } | null;
    /** WHY nothing was pushed; null when something was. */
    skipped: string | null;
    /** What is wrong while something WAS pushed — the bucket's key missing
     *  from `trusted-public-keys`. Null when there is nothing to say. */
    keyWarning: string | null;
    /** Store paths this run's nodes UPLOADED, summed over the pushes that
     *  LANDED. A node still pushing, or one whose push failed, adds nothing.
     */
    stored: number;
    /** Store paths those same pushes found the bucket ALREADY serving. */
    present: number;
    /** NAR bytes `stored` came to — what this run actually sent. */
    bytes: number;
    /** The nodes whose push failed, in roster order. Empty when none did. */
    failedOn: readonly string[];
  };
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

/** The last whole-character suffix of `text` that fits in `maxBytes`. */
export function clampTailBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) {
    return { text, truncated: false };
  }
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

/** One node's newest attempt, as the fold has it so far. */
export interface AttemptState {
  node: string;
  attempt: number;
  placement: Placement;
  status: NodeStatus | null;
  exitCode: number | null;
  durationMs: number | null;
  /** The journal's own clock for the `attempt_started` line — when this attempt
   *  BEGAN. Null for a node the fold only ever saw a status for. */
  startedAt: number | null;
  logComplete: boolean;
  logBytes: number;
  logReason: string | null;
}

/** Fold the journal into the run's current shape. */
export function foldJournal(journal: readonly JournalEntry[]): {
  roster: string[];
  /** The newest attempt recorded per node. */
  latest: Map<string, AttemptState>;
  finalized: RunVerdict["outcome"] | null;
  /** Work STARTED AGAIN after the run published a terminal outcome. */
  resumed: boolean;
  debt: Map<string, { context: string; lastError: string; attempts: number }>;
  scope: RunScope | null;
  /** WHERE the run's work is placed, folded out of the `lane` and `phase` lines. */
  phase: "provisioning" | "lanes" | "no_lanes" | null;
  /** Per platform, last write wins — the coordinator republishes a lane's whole
   *  state on every change, so the newest line is the lane. */
  lanes: Map<
    string,
    {
      state: "claiming" | "leased";
      host: string | null;
      pool: readonly string[];
    }
  >;
  /** The hosts file the lanes were declared in, from the newest lane line that
   *  carried one. Null for a run written before the field existed. */
  hostsSource: string | null;
  /** WHAT EACH NODE'S PUSH IS DOING (PLAN 4.1), last write wins. Per NODE
   *  rather than per attempt. */
  push: Map<string, NodePush>;
} {
  let roster: string[] = [];
  let scope: RunScope | null = null;
  let finalized: RunVerdict["outcome"] | null = null;
  let resumed = false;
  let phase: "provisioning" | "lanes" | "no_lanes" | null = null;
  let hostsSource: string | null = null;
  const lanes = new Map<
    string,
    { state: "claiming" | "leased"; host: string | null; pool: readonly string[] }
  >();
  const latest = new Map<string, AttemptState>();
  const debt = new Map<
    string,
    { context: string; lastError: string; attempts: number }
  >();
  const push = new Map<string, NodePush>();
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
      case "phase":
        phase = e.phase;
        break;
      case "lane":
        lanes.set(e.platform, {
          state: e.state,
          host: e.host,
          pool: e.pool === undefined ? [] : [...e.pool],
        });
        if (e.hostsSource !== undefined) hostsSource = e.hostsSource;
        break;
      case "attempt_started": {
        if (finalized !== null && isResumptionEvent(e)) resumed = true;
        const state: AttemptState = {
          node: e.node,
          attempt: e.attempt,
          placement: e.placement,
          status: null,
          exitCode: null,
          durationMs: null,
          startedAt: entry.at,
          logComplete: false,
          logBytes: 0,
          logReason: null,
        };
        byAttempt.set(key(e.node, e.attempt), state);
        latest.set(e.node, state);
        push.delete(e.node);
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
          startedAt: null,
          logComplete: false,
          logBytes: 0,
          logReason: null,
        };
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
      case "pushing": {
        push.set(e.node, { state: "pushing", bucket: e.bucket });
        if (e.durationMs !== undefined) {
          const state = latest.get(e.node);
          if (state !== undefined && state.durationMs === null) {
            state.durationMs = e.durationMs;
          }
        }
        break;
      }
      case "pushed": {
        const present = e.present ?? 0;
        push.set(e.node, {
          state: "pushed",
          bucket: e.bucket,
          stored: Math.max(0, e.paths - present),
          present,
          bytes: e.bytes,
          durationMs: e.durationMs ?? 0,
        });
        break;
      }
      case "push_failed":
        push.set(e.node, {
          state: "failed",
          bucket: e.bucket,
          message: e.message,
          durationMs: e.durationMs ?? 0,
        });
        break;
      case "finalized":
        finalized = e.outcome;
        resumed = false;
        break;
      default:
        break;
    }
  }
  return {
    roster,
    latest,
    finalized,
    resumed,
    debt,
    scope,
    phase,
    lanes,
    hostsSource,
    push,
  };
}

function inRosterOrder(
  nodes: readonly string[],
  roster: readonly string[],
): readonly string[] {
  if (nodes.length < 2 || roster.length === 0) return nodes;
  const rank = new Map(roster.map((node, i) => [node, i]));
  return [...nodes].sort(
    (a, b) =>
      (rank.get(a) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
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

  const actionable = failures.some((f) => f.log_complete) || settled;

  const afterSeq = (query.after ?? sources.after)?.seq ?? 0;
  const pending = sources.journal.filter((e) => e.seq > afterSeq);
  const debtRows = [...fold.debt.values()].map((d) => ({
    context: d.context,
    last_error: d.lastError,
    attempts: d.attempts,
  }));
  const pushTotal = pushTotals(fold.push);

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
      content_sha: manifest?.snapshot.contentSha ?? null,
      dirty: manifest?.snapshot.dirty ?? false,
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
    ...(manifest?.actor === undefined ? {} : { actor: manifest.actor }),
    ...(manifest?.push === undefined
      ? {}
      : {
          push: {
            target:
              manifest.push.target === null
                ? null
                : {
                    substituter: manifest.push.target.substituter,
                    bucket: manifest.push.target.bucket,
                  },
            skipped: manifest.push.skipped,
            keyWarning: manifest.push.keyWarning,
            stored: pushTotal.stored,
            present: pushTotal.present,
            bytes: pushTotal.bytes,
            failedOn: inRosterOrder(pushTotal.failedOn, fold.roster),
          },
        }),
  };

  const build = (
    events: readonly JournalEntry[],
    fails: readonly AttentionFailure[],
    debt: readonly Attention["reporting_debt"][number][],
    overBudget: boolean,
  ): Attention => ({
    ...identity,
    events: events.map((e) => ({ seq: e.seq, at: e.at, event: e.event })),
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
  const fitted = build(events, fails, debt, false);
  return fits(fitted) ? fitted : build(events, fails, debt, true);
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
  const hasTerminal = sources.verdict !== null || fold.finalized !== null;
  if (hasTerminal && !fold.resumed) return "settled";
  if (sources.ownerAlive === false) return "owner_lost";
  return "still_running";
}
