import type { LaneCell, StatusHue as FaceHue } from "@odu/face/ui";
import type { StatusHue as WireHue } from "@odu/run-client/surface";
import {
  BOARD_STATE,
  duration,
  OUTCOME,
  scopeLabel,
  type StatusHue,
} from "@odu/service-client/board";
import { STATUS_META } from "@odu/service-client/surface";
import { bytes } from "@odu/cordis/format";
import type {
  LogPage,
  LogStream,
  LogTail,
  NodeStatus,
  RunNode,
} from "./types";

export type { StatusHue };

type Assignable<A extends B, B> = A;
export type StatusHuesAgree = [
  Assignable<FaceHue, WireHue>,
  Assignable<WireHue, FaceHue>,
];

export { BOARD_STATE, OUTCOME };

export const NODE_STATUS = STATUS_META;

export const NODE_WORD: Record<NodeStatus, string> = {
  pending: "pending",
  running: "running",
  ok: "passed",
  failed: "failed",
  skipped: "skipped",
  errored: "errored",
  cancelled: "cancelled",
};

export function runRef(sha: string, seq: number | null): string {
  const sha7 = sha.slice(0, 7);
  return seq === null ? sha7 : `${sha7}#${seq}`;
}

export function projectOf(repoRoot: string): string {
  const parts = repoRoot.split("/").filter((p) => p !== "");
  return parts[parts.length - 1] ?? repoRoot;
}

export function platformOf(nodeId: string): string {
  const at = nodeId.lastIndexOf("@");
  return at < 0 ? "" : nodeId.slice(at + 1);
}

export function platformShort(platform: string): string {
  if (platform === "") return "lane";
  const dash = platform.lastIndexOf("-");
  return dash < 0 ? platform : platform.slice(dash + 1);
}

export interface Lane {
  readonly platform: string;
  readonly nodes: RunNode[];
}

export function lanesOf(nodes: readonly RunNode[]): Lane[] {
  const byPlatform = new Map<string, RunNode[]>();
  for (const node of nodes) {
    const platform = platformOf(node.id);
    const lane = byPlatform.get(platform);
    if (lane === undefined) byPlatform.set(platform, [node]);
    else lane.push(node);
  }
  return [...byPlatform].map(([platform, lane]) => ({ platform, nodes: lane }));
}

export function laneCells(nodes: readonly RunNode[]): LaneCell[] {
  return nodes.map((node) => ({
    label: `${node.id}, ${NODE_WORD[node.status]}`,
    hue: node.status === "pending" ? null : NODE_STATUS[node.status].hue,
    ...(node.status === "skipped" ? { skipped: true } : {}),
  }));
}

export { duration };

export { scopeLabel };

export function requestId(what: string): string {
  return `web-${what}-${crypto.randomUUID()}`;
}

export function pushCounts(counts: {
  stored: number;
  present: number;
  bytes: number;
}): string {
  const present = counts.present === 0 ? "" : ` · ${counts.present} present`;
  return `${counts.stored} pushed${present} · ${bytes(counts.bytes)}`;
}

export type FollowedPage = Pick<LogPage, "size" | "complete">;

const INCOMPLETE = " · incomplete — the producer never closed this log";

export function logMetaText(view: {
  stream: LogStream;
  tail: LogTail | undefined;
  followedPage: FollowedPage | null;
}): string {
  if (view.stream === "push") {
    const page = view.followedPage;
    return page === null
      ? "push log"
      : `push log · ${bytes(page.size)}${page.complete ? "" : INCOMPLETE}`;
  }
  const tail = view.tail;
  return tail === undefined
    ? ""
    : `${bytes(tail.totalBytes)}${tail.complete ? "" : INCOMPLETE}`;
}
