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

import { z } from "zod";
import {
  type NodeStatus,
  NodeStatusSchema,
  type PipelineState,
  STATUS_META,
} from "./surface";

/** The current record format. Bumped only when a field changes shape; the
 *  ledger reader tolerates records it can't parse (skips them) so a newer
 *  writer never crashes an older reader. */
export const RUN_RECORD_VERSION = 1;

/** One node's terminal result — the matrix-cell projection a face repaints
 *  from. The volatile live-only fields (`command`, `needs`) are deliberately
 *  omitted: a record answers "what was the outcome", not "what was the graph".
 *  `id` is the fan-in `<namepath>@<platform>`, so a reader splits it for the
 *  (recipe × platform) matrix exactly as every live face does. */
export const RunNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: NodeStatusSchema,
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nullable(),
});
export type RunNode = z.infer<typeof RunNodeSchema>;

/** A run's verdict: `passed` only when the run *completed* with no red node.
 *  An interrupted/cancelled run (some node still pending/running when the
 *  record was finalized) is `failed` — a gate that didn't finish didn't pass. */
export const RunVerdictSchema = z.enum(["passed", "failed"]);
export type RunVerdict = z.infer<typeof RunVerdictSchema>;

export const RunRecordSchema = z.object({
  version: z.literal(RUN_RECORD_VERSION),
  /** `owner/repo` for a GitHub origin; `null` for a local-only checkout with
   *  no recognized remote (the zero-config newcomer run). The repo axis a
   *  multi-repo service face fans in on. */
  repo: z.string().nullable(),
  /** The run's commit (full 40-hex) and its 7-char short form. */
  sha: z.string(),
  sha7: z.string(),
  /** This run's ordinal among runs of the same `sha` in this checkout, 1-based
   *  — a rerun of one commit gets `seq` 2, 3, … so its record never overwrites
   *  the prior run's. */
  seq: z.number().int().positive(),
  /** The working tree had uncommitted changes — the verdict is about that tree,
   *  not the bare commit. */
  dirty: z.boolean(),
  pipeline: z.string(),
  verdict: RunVerdictSchema,
  /** Every node reached a terminal status before the record was written. False
   *  for a record finalized by cancel/interrupt/idle teardown mid-run. */
  complete: z.boolean(),
  /** Wall-clock (`Date.now()`) bounds of the run. */
  startedAt: z.number(),
  finishedAt: z.number(),
  lanes: z.array(z.object({ platform: z.string(), host: z.string() })),
  nodes: z.array(RunNodeSchema),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** The stable display ref for a run: `<sha7>#<seq>` (e.g. `26d2c2d#2`). One
 *  spelling for `odu runs`, a service face's run-page URL, and a future
 *  `target_url` — so the id a status links to and the id the ledger keys on
 *  are the same string, derived here rather than re-concatenated per consumer. */
export function formatRunRef(record: Pick<RunRecord, "sha7" | "seq">): string {
  return `${record.sha7}#${record.seq}`;
}

function isTerminal(status: NodeStatus): boolean {
  return status !== "pending" && status !== "running";
}

/** Build the durable record for a run from its final `PipelineState` plus the
 *  run environment the state cell doesn't carry (identity, lanes, timing).
 *
 *  Pure — the caller (the coordinator) supplies `finishedAt` and the allocated
 *  `seq`; verdict and `complete` are *derived* from the state so they can't
 *  drift from what the matrix showed: `complete` iff every node is terminal,
 *  `passed` iff complete with no red (failed/errored) node. */
export function buildRunRecord(input: {
  repo: string | null;
  sha: string;
  sha7: string;
  seq: number;
  dirty: boolean;
  startedAt: number;
  finishedAt: number;
  lanes: ReadonlyArray<{ platform: string; host: string }>;
  state: PipelineState;
}): RunRecord {
  const { state } = input;
  const nodes: RunNode[] = [];
  let complete = true;
  let red = false;
  for (const id of state.order) {
    const node = state.nodes[id];
    if (node === undefined) continue;
    if (!isTerminal(node.status)) complete = false;
    if (STATUS_META[node.status].isRed) red = true;
    nodes.push({
      id,
      name: node.name,
      status: node.status,
      exitCode: node.exitCode,
      durationMs: node.durationMs,
    });
  }
  return {
    version: RUN_RECORD_VERSION,
    repo: input.repo,
    sha: input.sha,
    sha7: input.sha7,
    seq: input.seq,
    dirty: input.dirty,
    pipeline: state.name,
    verdict: complete && !red ? "passed" : "failed",
    complete,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    lanes: input.lanes.map((l) => ({ platform: l.platform, host: l.host })),
    nodes,
  };
}
