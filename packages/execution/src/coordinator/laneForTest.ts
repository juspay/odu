import { SETUP_NAMEPATH } from "@odu/run-client/nodeId";
import type { Lane, LaneOptions } from "./lane";

export interface RecordedLane {
  opts: LaneOptions;
  closed: boolean;
}

export function recordingLanes(
  each?: (opts: LaneOptions, lanes: readonly RecordedLane[]) => void,
): {
  lanes: RecordedLane[];
  startLane: (opts: LaneOptions) => Lane;
} {
  const lanes: RecordedLane[] = [];
  const startLane = (opts: LaneOptions): Lane => {
    each?.(opts, lanes);
    const entry: RecordedLane = { opts, closed: false };
    lanes.push(entry);
    for (const id of [SETUP_NAMEPATH, ...opts.tasks.map((t) => t.id)]) {
      opts.onLogFrame(id, { kind: "snapshot", text: "" }, "recipe");
      opts.onLogFrame(id, { kind: "snapshot", text: "" }, "push");
    }
    return {
      platform: opts.platform,
      extend: async () => true,
      rerun: async () => true,
      cancel: async () => true,
      drain: async () => ({ reason: "complete" as const }),
      close: () => {
        entry.closed = true;
      },
    };
  };
  return { lanes, startLane };
}
