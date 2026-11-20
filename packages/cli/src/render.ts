import {
  claimingLanes,
  leasedLanes,
  type NodeState,
  type NodeStatus,
  type PipelineState,
  type PostingHealth,
  type RunHeader,
  STATUS_META,
  type StatusHue,
} from "@odu/run-client/surface";
import { fanId, logPathFor, splitFanId } from "@odu/run-client/nodeId";
import {
  countsLine,
  outcomeOf,
  type Outcome,
  summarize,
  unpostedNote,
} from "@odu/execution/common/verdict";
import { formatGoDuration } from "@odu/execution/common/duration";
import type { VerdictInput } from "@odu/execution/common/presentation";
import {
  bold,
  dim,
  green,
  link,
  magenta,
  red,
  stripAnsi,
  yellow,
} from "./ansi";

const ANSI_BY_HUE: Record<StatusHue, (s: string) => string> = {
  grey: dim,
  amber: yellow,
  green,
  red,
  violet: magenta,
};

const CELL_BY_HUE: Record<StatusHue, string> = {
  grey: "#6b7a80",
  amber: "#e6b24d",
  green: "#6fcf8e",
  red: "#e8695b",
  violet: "#bb8ce2",
};

function byStatus<T>(pick: (hue: StatusHue) => T): Record<NodeStatus, T> {
  const out = {} as Record<NodeStatus, T>;
  for (const status of Object.keys(STATUS_META) as NodeStatus[]) {
    out[status] = pick(STATUS_META[status].hue);
  }
  return out;
}

const STATUS_COLOR: Record<NodeState["status"], (s: string) => string> =
  byStatus((hue) => ANSI_BY_HUE[hue]);

export const STATUS_CELL: Record<NodeState["status"], string> = byStatus(
  (hue) => CELL_BY_HUE[hue],
);

export function statusGlyph(status: NodeState["status"]): string {
  return STATUS_COLOR[status](STATUS_META[status].glyph);
}

export const OUTCOME_MARK: Record<Outcome, string> = {
  pending: "◼",
  ok: "✔",
  incomplete: "◼",
  failed: "✗",
};

export const OUTCOME_LABEL: Record<Outcome, string> = {
  pending: "RUNNING",
  ok: "OK",
  incomplete: "INCOMPLETE",
  failed: "FAILED",
};

const OUTCOME_HUE: Record<Outcome, StatusHue> = {
  pending: "grey",
  ok: "green",
  incomplete: "amber",
  failed: "red",
};

export const OUTCOME_COLOR: Record<Outcome, (s: string) => string> = {
  pending: ANSI_BY_HUE[OUTCOME_HUE.pending],
  ok: ANSI_BY_HUE[OUTCOME_HUE.ok],
  incomplete: ANSI_BY_HUE[OUTCOME_HUE.incomplete],
  failed: ANSI_BY_HUE[OUTCOME_HUE.failed],
};

export const OUTCOME_CELL: Record<Outcome, string> = {
  pending: CELL_BY_HUE[OUTCOME_HUE.pending],
  ok: CELL_BY_HUE[OUTCOME_HUE.ok],
  incomplete: CELL_BY_HUE[OUTCOME_HUE.incomplete],
  failed: CELL_BY_HUE[OUTCOME_HUE.failed],
};

export function defaultAttachId(state: PipelineState): string | undefined {
  const running = state.order.find(
    (id) => state.nodes[id]?.status === "running",
  );
  if (running !== undefined) return running;
  const pending = state.order.find(
    (id) => state.nodes[id]?.status === "pending",
  );
  if (pending !== undefined) return pending;
  return state.order.at(-1);
}

export function recipeLabel(namepath: string): string {
  return namepath.startsWith("ci::") ? namepath.slice(4) : namepath;
}

export function matrixShape(order: readonly string[]): {
  recipes: string[];
  platforms: string[];
} {
  const recipes: string[] = [];
  const platforms: string[] = [];
  for (const id of order) {
    const { namepath, platform } = splitFanId(id);
    if (!recipes.includes(namepath)) recipes.push(namepath);
    if (!platforms.includes(platform)) platforms.push(platform);
  }
  return { recipes, platforms };
}

export function cellAt(
  state: PipelineState,
  recipe: string,
  platform: string,
): NodeState | undefined {
  return state.nodes[fanId(recipe, platform)];
}

export function stepFocus(
  order: readonly string[],
  focusedId: string | undefined,
  key: "h" | "j" | "k" | "l",
): string | undefined {
  if (focusedId === undefined) return order[0];
  const { recipes, platforms } = matrixShape(order);
  const cells = new Map(
    order.map((id) => {
      const { namepath, platform } = splitFanId(id);
      return [fanId(namepath, platform), id] as const;
    }),
  );
  const { namepath, platform } = splitFanId(focusedId);
  const horizontal = key === "h" || key === "l";
  const axis = horizontal ? platforms : recipes;
  const delta = key === "l" || key === "j" ? 1 : -1;
  const start = axis.indexOf(horizontal ? platform : namepath);
  if (start === -1) return undefined;
  for (let stepCount = 1; stepCount < axis.length; stepCount++) {
    const pos =
      (((start + delta * stepCount) % axis.length) + axis.length) % axis.length;
    const at = axis[pos];
    if (at === undefined) continue;
    const candidate = horizontal
      ? cells.get(fanId(namepath, at))
      : cells.get(fanId(at, platform));
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

export function operatorLine(text: string): string {
  return dim(stripAnsi(text));
}

export function laneText(header: Pick<RunHeader, "lanes">): string {
  return leasedLanes(header)
    .map((l) => `${l.platform}=${l.host}`)
    .join(" · ");
}

export function claimingText(header: Pick<RunHeader, "lanes">): string {
  return claimingLanes(header)
    .map((c) => `${c.platform} from ${c.pool.join(", ")}`)
    .join(" · ");
}

export function commitLabel(
  state: Pick<PipelineState, "sha7" | "dirty">,
): string {
  return state.dirty ? `${state.sha7}+dirty` : state.sha7;
}

export function verdictLine(state: PipelineState): string {
  const s = summarize(state);
  const reds = state.order
    .map((id) => state.nodes[id])
    .filter(
      (n): n is NodeState => n !== undefined && STATUS_META[n.status].isRed,
    );
  const lines = [
    `${OUTCOME_MARK[outcomeOf(s)]} ${state.name} @ ${commitLabel(state)}  ${countsLine(s)}`,
  ];
  for (const n of reds.slice(0, 3)) {
    lines.push(`  ${STATUS_META[n.status].glyph} ${n.id}`);
  }
  if (reds.length > 3) lines.push(`  … +${reds.length - 3} more`);
  return `${lines.join("\n")}\n`;
}

export function postingWarning(health: PostingHealth): string | null {
  if (health.owed.length === 0) return null;
  const n = health.owed.length;
  const last = health.owed.find((o) => o.lastError)?.lastError ?? null;
  const noun = n === 1 ? "status" : "statuses";
  const err = last !== null ? `, last error: ${last}` : "";
  const phase = health.owed.some((o) => o.attempts > 0) ? "retrying" : "sending";
  return `⚠ github: ${n} ${noun} unconfirmed (${phase}${err})`;
}

const VERDICT_BUCKETS = [
  "ok",
  "failed",
  "errored",
  "skipped",
  "cancelled",
] as const;

export function printVerdict(input: VerdictInput): void {
  const { state } = input;
  const counts = summarize(state);
  const shaLabel = commitLabel({ sha7: input.sha7, dirty: input.dirty });
  const lines: string[] = [
    dim(
      `── ci run summary @ ${
        input.commitUrl !== null ? link(shaLabel, input.commitUrl) : shaLabel
      } ──`,
    ),
  ];
  for (const id of state.order) {
    const node = state.nodes[id];
    if (node === undefined) continue;
    const glyph = statusGlyph(node.status);
    const dur =
      node.durationMs !== null
        ? ` ${dim(formatGoDuration(node.durationMs))}`
        : "";
    const logRef =
      node.status === "failed" || node.status === "errored"
        ? dim(`  ${logPathFor(input.sha7, id)}`)
        : "";
    lines.push(`  ${glyph} ${id.padEnd(44)} ${node.status}${dur}${logRef}`);
  }
  const debt = unpostedNote(input.unpostedCount);
  const outcome = outcomeOf(counts);
  const label = bold(OUTCOME_COLOR[outcome](OUTCOME_LABEL[outcome]));
  lines.push(
    `${countsLine(counts, VERDICT_BUCKETS, true)} — ${label}${debt !== "" ? dim(debt) : ""}`,
  );
  process.stderr.write(`${lines.join("\n")}\n`);
}
