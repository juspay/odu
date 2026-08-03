/**
 * The run record — odu's durable run identity, the manifest that outlives the
 * coordinator process.
 *
 * Today the coordinator owns a run's state as a live `PipelineState` cell on
 * `.ci/odu.sock`, and the only durable trail is the per-node log files
 * (`.ci/<sha7>/<platform>/<node>.log`) + the timing sidecar. So once the
 * coordinator exits, "what runs happened, and how did each end?" has no
 * answer — `odu status` with no live socket exits 1, and the agent face's
 * `nodes` reports `{ run: false }` (its own header says it: *"no durable
 * PipelineState manifest exists on disk"*).
 *
 * A `RunRecord` is that missing manifest. Each terminal run writes one,
 * stamped with a `(repo, sha, seq)` identity — `seq` because the same commit
 * runs more than once (a rerun after an infra flake is a *new run*, not a
 * mutation of the old one's history). The record carries the verdict, the
 * timing, the lane→host map, and a terminal snapshot of every node — enough
 * to repaint the matrix a face showed live. The ledger (src/coordinator/
 * ledger.ts) is the append-only collection of these; `odu runs` lists it, and
 * it is the row source a service face (odu-web) reads for run pages and the
 * `target_url` a commit status points at.
 *
 * This module is pure: the schema, the identity ref, and `buildRunRecord`
 * (PipelineState + run env → record). The filesystem layout lives in the
 * ledger.
 */

import { Schema } from "effect";
import { shortSha } from "./git";
import {
  type NodeStatus,
  NodeStatusSchema,
  type PipelineState,
  STATUS_META,
  UnpostedEntrySchema,
  type UnpostedEntry,
} from "./surface";

export type { UnpostedEntry };

/** The current record format. Bumped only when a field changes shape; the
 *  ledger reader tolerates records it can't parse (skips them) so a newer
 *  writer never crashes an older reader. */
export const RUN_RECORD_VERSION = 1;

/** One node's terminal result — the matrix-cell projection a face repaints
 *  from. The volatile live-only fields (`command`, `needs`) are deliberately
 *  omitted: a record answers "what was the outcome", not "what was the graph".
 *  `id` is the fan-in `<namepath>@<platform>`, so a reader splits it for the
 *  (recipe × platform) matrix exactly as every live face does. */
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
   *  no recognized remote (the zero-config newcomer run). The repo axis a
   *  multi-repo service face fans in on. */
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
 *  short sha and a seq (`null` when the run carried none, rendered `?`). The one
 *  place `<sha7>#<seq>` is concatenated — `formatRunRef` and the wait-tool's
 *  refusal messages route through it so the spelling can't fork per consumer. */
export function formatRef(sha7: string, seq: number | null): string {
  return `${sha7}#${seq ?? "?"}`;
}

/** The stable display ref for a run: `<sha7>#<seq>` (e.g. `26d2c2d#2`). One
 *  spelling for `odu runs`, a service face's run-page URL, and a future
 *  `target_url` — so the id a status links to and the id the ledger keys on
 *  are the same string, derived here rather than re-concatenated per consumer. */
export function formatRunRef(record: Pick<RunRecord, "sha" | "seq">): string {
  return formatRef(shortSha(record.sha), record.seq);
}

function isTerminal(status: NodeStatus): boolean {
  return status !== "pending" && status !== "running";
}

/** The single per-node terminal projection of a finished run's `state.order` —
 *  the one place the on-disk node field set (status, exitCode, durationMs, …)
 *  is derived. Both durable consumers fan out from here: `buildRunRecord` uses
 *  it verbatim for `record.nodes`, and the coordinator's timing sidecar maps
 *  each `RunNode` (+ `splitFanId(id)` for recipe/platform + the node's
 *  `startedAt`) into its jsonl shape — so the two formats can't silently
 *  diverge on a node-level field. Skips ids with no live cell, exactly as the
 *  matrix repaint does. */
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

/** Build the durable record for a run from its final `PipelineState` plus the
 *  run environment the state cell doesn't carry (identity, lanes, timing).
 *
 *  Pure — the caller (the coordinator) supplies `finishedAt` and the allocated
 *  `seq`; `outcome` is *derived* from the state so it can't drift from what the
 *  matrix showed: `incomplete` unless every node is terminal, then `failed` if
 *  any is red (failed/errored), else `passed`. */
export function buildRunRecord(input: {
  repo: string | null;
  sha: string;
  seq: number;
  dirty: boolean;
  startedAt: number;
  finishedAt: number;
  lanes: ReadonlyArray<{ platform: string; host: string }>;
  state: PipelineState;
  /** Statuses still unconfirmed when the record is finalized (juspay/odu#61). */
  unposted?: ReadonlyArray<UnpostedEntry>;
}): RunRecord {
  const { state } = input;
  const nodes = projectNodes(state);
  const complete = nodes.every((n) => isTerminal(n.status));
  const red = nodes.some((n) => STATUS_META[n.status].isRed);
  // A gate the operator cancelled did not finish — never `passed` (juspay/odu#68).
  // Distinct from red: cancel is intentional, not a test/infra failure.
  const cancelled = nodes.some((n) => n.status === "cancelled");
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
    outcome: !complete || cancelled ? "incomplete" : red ? "failed" : "passed",
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    lanes: [...input.lanes],
    nodes,
    ...(unposted !== undefined ? { unposted } : {}),
  };
}
