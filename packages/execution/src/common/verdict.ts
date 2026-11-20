import {
  type NodeState,
  type NodeStatus,
  type PipelineState,
  STATUS_META,
} from "@odu/run-client/surface";

/** The non-terminal statuses: a node in one of these is still in flight. */
export const NON_TERMINAL_STATUSES = new Set<NodeStatus>(["pending", "running"]);

export interface PipelineSummary {
  pending: number;
  running: number;
  ok: number;
  failed: number;
  skipped: number;
  errored: number;
  cancelled: number;
  done: boolean;
  failedOverall: boolean;
  clean: boolean;
}

export function summarize(state: PipelineState): PipelineSummary {
  const counts = {
    running: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    errored: 0,
    pending: 0,
    cancelled: 0,
  };
  for (const id of state.order) {
    const node = state.nodes[id];
    if (node === undefined) continue;
    counts[node.status] += 1;
  }
  const done = ![...NON_TERMINAL_STATUSES].some((s) => counts[s] > 0);
  const red = counts.failed + counts.errored > 0;
  return {
    ...counts,
    done,
    failedOverall: done && red,
    clean: done && !red && counts.cancelled === 0,
  };
}

/** 1 if the latest state has settled and is not a clean pass (red or
 *  cancelled), else 0; `undefined` is a clean 0. */
export function exitCode(state: PipelineState | undefined): number {
  if (state === undefined) return 0;
  const s = summarize(state);
  return s.done && !s.clean ? 1 : 0;
}

export const COUNT_KEYS = [
  "ok",
  "running",
  "pending",
  "failed",
  "errored",
  "cancelled",
  "skipped",
] as const satisfies readonly NodeStatus[];

/** `3 ok · 1 failed` — the counts line every face shows. Empty buckets are
 *  dropped; `which` narrows the set. */
export function countsParts(
  s: PipelineSummary,
  which: readonly NodeStatus[] = COUNT_KEYS,
  keepZeros = false,
): { status: NodeStatus; text: string }[] {
  return which
    .filter((k) => keepZeros || s[k] > 0)
    .map((k) => ({ status: k, text: `${s[k]} ${k}` }));
}

/** The counts row as one string.
 *
 *  @param keepZeros keep buckets that are zero. */
export function countsLine(
  s: PipelineSummary,
  which: readonly NodeStatus[] = COUNT_KEYS,
  keepZeros = false,
): string {
  return countsParts(s, which, keepZeros)
    .map((part) => part.text)
    .join(" · ");
}

/** How a settled run turned out; a run whose only non-ok nodes were cancelled
 *  is neither a pass nor a failure. */
export type Outcome = "pending" | "ok" | "incomplete" | "failed";

export function outcomeOf(s: PipelineSummary): Outcome {
  if (!s.done) return "pending";
  if (s.failedOverall) return "failed";
  return s.clean ? "ok" : "incomplete";
}

/** One node as an agent/JSON row. Snake_case because it crosses to MCP and to
 *  `status -o json`. */
export interface NodeRowJson {
  id: string;
  name: string;
  status: string;
  exit_code: number | null;
  duration_ms: number | null;
}

export function nodeRow(node: NodeState): NodeRowJson {
  return {
    id: node.id,
    name: node.name,
    status: node.status,
    exit_code: node.exitCode,
    duration_ms: node.durationMs === null ? null : Math.round(node.durationMs),
  };
}

export interface NodeRow extends NodeRowJson {
  red: boolean;
}

export function nodeRowRed(node: NodeState): NodeRow {
  return { ...nodeRow(node), red: STATUS_META[node.status].isRed };
}

export function rowsOf(state: PipelineState): NodeRow[] {
  return state.order
    .map((id) => state.nodes[id])
    .filter((n): n is NodeState => n !== undefined)
    .map(nodeRowRed);
}

/** The agent-face parallel of `summarize`, over flattened rows: `done` when no
 *  row holds a non-terminal status, red rows bucketed by each row's `red`. */
export function agentSummary(snap: {
  nodes: readonly { id: string; status: string; red: boolean }[];
}): {
  done: boolean;
  failed: string[];
  errored: string[];
  cancelled: string[];
} {
  const failed: string[] = [];
  const errored: string[] = [];
  const cancelled: string[] = [];
  let done = true;
  for (const node of snap.nodes) {
    if (NON_TERMINAL_STATUSES.has(node.status as NodeStatus)) done = false;
    if (node.status === "cancelled") cancelled.push(node.id);
    if (!node.red) continue;
    if (node.status === "failed") failed.push(node.id);
    else if (node.status === "errored") errored.push(node.id);
  }
  return { done, failed, errored, cancelled };
}

/** The debt clause a verdict line carries — ", 3 statuses never reached
 *  GitHub". */
export function unpostedNote(n: number): string {
  if (n <= 0) return "";
  return `, ${n} status${n === 1 ? "" : "es"} never reached GitHub`;
}
