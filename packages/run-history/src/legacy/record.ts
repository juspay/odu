import { Schema } from "effect";
import {
  type NodeStatus,
  NodeStatusSchema,
  type OwedStatus,
  type PipelineState,
  STATUS_META,
} from "@odu/run-client/surface";
import { shortSha } from "@odu/run-client/nodeId";

/** Final unconfirmed posting debt, stamped into the durable record: a live
 *  `OwedStatus` (the fan-in surface's shape) with `lastError` REQUIRED at
 *  write. `attempts` is optional ONLY so records written before it existed
 *  still parse — a reader that finds it absent knows the count wasn't
 *  recorded, rather than being handed a fabricated `0` it can't tell apart
 *  from "no retries yet". */
export const UnpostedEntrySchema = Schema.Struct({
  context: Schema.String,
  lastError: Schema.String,
  attempts: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type UnpostedEntry = typeof UnpostedEntrySchema.Type;

/** Project live owed rows into durable unposted entries (juspay/odu#61). The
 *  only narrowing left is `lastError`: a row that never reported one is written
 *  as "not posted" so the durable shape can require it. */
export function projectUnposted(owed: readonly OwedStatus[]): UnpostedEntry[] {
  return owed.map((o) => ({
    context: o.context,
    lastError: o.lastError ?? "not posted",
    attempts: o.attempts,
  }));
}

/** Lift durable unposted entries back to live owed rows — the inverse of
 *  {@link projectUnposted}.
 *  A record written before `attempts` was persisted reports 0. */
export function liftUnposted(entries: readonly UnpostedEntry[]): OwedStatus[] {
  return entries.map((e) => ({
    context: e.context,
    lastError: e.lastError,
    attempts: e.attempts ?? 0,
  }));
}

export const RUN_RECORD_VERSION = 1;

/** One node's terminal result — the matrix-cell projection a face repaints
 *  from. `id` is the fan-in `<namepath>@<platform>`. */
export const RunNodeSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: NodeStatusSchema,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(Schema.Number),
});
export type RunNode = typeof RunNodeSchema.Type;

/** A run's outcome — one domain concept with exactly three reachable states:
 *  `passed` only when the run *completed* with no red node and no cancelled
 *  node; `failed` when it completed with a red node; `incomplete` when some
 *  node was still pending/running *or* was operator-cancelled (a gate that
 *  didn't finish didn't pass — juspay/odu#68). One field, so the illegal
 *  "passed but incomplete" combination is unrepresentable. */
export const RunOutcomeSchema = Schema.Literals([
  "passed",
  "failed",
  "incomplete",
]);
export type RunOutcome = typeof RunOutcomeSchema.Type;

export const RunRecordSchema = Schema.Struct({
  version: Schema.Literal(RUN_RECORD_VERSION),
  /** `owner/repo` for a GitHub origin; `null` for a local-only checkout with
   *  no recognized remote (the zero-config newcomer run). */
  repo: Schema.NullOr(Schema.String),
  /** The run's commit (full 40-hex). The short form is derived (`shortSha`) at
   *  read sites rather than stored, so a record can't carry a sha7 that
   *  disagrees with its sha. */
  sha: Schema.String,
  /** This run's ordinal among runs of the same `sha` in this checkout, 1-based
   *  — a rerun of one commit gets `seq` 2, 3, … so its record never overwrites
   *  the prior run's. */
  seq: Schema.Int.check(Schema.isGreaterThan(0)),
  /** The working tree had uncommitted changes — the verdict is about that tree,
   *  not the bare commit. */
  dirty: Schema.Boolean,
  pipeline: Schema.String,
  /** The run's tri-state outcome. `incomplete` covers a record finalized by
   *  cancel/interrupt/idle teardown mid-run (a node still pending/running);
   *  `failed` a completed run with a red node; `passed` a completed run with
   *  none. A consumer that wants the coarse pass/fail bit reads
   *  `outcome === "passed"`. */
  outcome: RunOutcomeSchema,
  /** Wall-clock (`Date.now()`) bounds of the run. */
  startedAt: Schema.Number,
  finishedAt: Schema.Number,
  lanes: Schema.Array(
    Schema.Struct({ platform: Schema.String, host: Schema.String }),
  ),
  nodes: Schema.Array(RunNodeSchema),
  /** Commit statuses that never reached GitHub by finalize time (juspay/odu#61).
   *  Absent / empty when every post confirmed — older records omit the field. */
  unposted: Schema.optionalKey(Schema.Array(UnpostedEntrySchema)),
});
export type RunRecord = typeof RunRecordSchema.Type;

/** The atomic run-ref spelling over the identity pair both consumers hold: a
 *  short sha and a seq (`null` when the run carried none, rendered `?`). */
export function formatRef(sha7: string, seq: number | null): string {
  return `${sha7}#${seq ?? "?"}`;
}

/** The stable display ref for a run: `<sha7>#<seq>` (e.g. `26d2c2d#2`). */
export function formatRunRef(record: Pick<RunRecord, "sha" | "seq">): string {
  return formatRef(shortSha(record.sha), record.seq);
}

function isTerminal(status: NodeStatus): boolean {
  return status !== "pending" && status !== "running";
}

/** The single per-node terminal projection of a finished run's `state.order`.
 *  Skips ids with no live cell. */
export function projectNodes(state: PipelineState): RunNode[] {
  const nodes: RunNode[] = [];
  for (const id of state.order) {
    const node = state.nodes[id];
    if (node === undefined) continue;
    nodes.push({
      id,
      name: node.name,
      status: node.status,
      exitCode: node.exitCode,
      durationMs: node.durationMs,
    });
  }
  return nodes;
}

/**
 * A run's tri-state outcome, from its terminal node projection.
 *
 * `incomplete` unless every node is terminal, then `incomplete` again if any
 * was operator-cancelled (a gate that did not finish did not pass —
 * juspay/odu#68), then `failed` if any is red, else `passed`.
 */
export function outcomeOfNodes(nodes: readonly RunNode[]): RunOutcome {
  const complete = nodes.every((n) => isTerminal(n.status));
  const red = nodes.some((n) => STATUS_META[n.status].isRed);
  const cancelled = nodes.some((n) => n.status === "cancelled");
  return !complete || cancelled ? "incomplete" : red ? "failed" : "passed";
}

/** Build the durable record for a run from its final `PipelineState` plus the
 *  run environment the state cell doesn't carry (identity, lanes, timing).
 *
 *  Pure — the caller (the coordinator) supplies `finishedAt` and the allocated
 *  `seq`; `outcome` is *derived* from the state. */
export function buildRunRecord(input: {
  repo: string | null;
  sha: string;
  seq: number;
  dirty: boolean;
  startedAt: number;
  finishedAt: number;
  /** The lane→host map, structurally typed so a caller may hand over a richer
   *  value (`leasedLanes()` yields `LeasedLane`, which also carries `state`). */
  lanes: ReadonlyArray<{ platform: string; host: string }>;
  state: PipelineState;
  /** Statuses still unconfirmed when the record is finalized (juspay/odu#61). */
  unposted?: ReadonlyArray<UnpostedEntry>;
}): RunRecord {
  const { state } = input;
  const nodes = projectNodes(state);
  const unposted =
    input.unposted !== undefined && input.unposted.length > 0
      ? [...input.unposted]
      : undefined;
  return {
    version: RUN_RECORD_VERSION,
    repo: input.repo,
    sha: input.sha,
    seq: input.seq,
    dirty: input.dirty,
    pipeline: state.name,
    outcome: outcomeOfNodes(nodes),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    lanes: input.lanes.map((l) => ({ platform: l.platform, host: l.host })),
    nodes,
    ...(unposted !== undefined ? { unposted } : {}),
  };
}
