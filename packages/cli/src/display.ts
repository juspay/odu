import type { LiveOpts, LiveView } from "./liveView";
import {
  claimingText,
  commitLabel,
  laneText,
  operatorLine,
} from "./render";
import { errorMessage } from "@odu/execution/common/effectEdge";
import { formatGoDuration } from "@odu/execution/common/duration";

export { commitLabel };
import type {
  Display,
  ProgressEvent,
} from "@odu/execution/common/presentation";
import { progressEvent } from "@odu/execution/common/presentation";
import {
  EMPTY_HEADER,
  type NodeState,
  type PipelineState,
  type RunHeader,
  runPhase,
  STATUS_META,
} from "@odu/run-client/surface";

export type { Display, ProgressEvent };
export { progressEvent };

export type { LiveOpts };

export type DisplayMode = "json" | "plain" | "live";

export function createDisplay(mode: DisplayMode, live?: LiveOpts): Display {
  if (mode === "json") return new JsonDisplay();
  if (mode === "plain") return new PlainDisplay();
  if (live === undefined) {
    throw new Error("odu: createDisplay('live') requires LiveOpts");
  }
  return new LiveDisplay(live);
}

class JsonDisplay implements Display {
  start(): void {}
  setHeader(): void {}
  update(): void {}
  transition(event: ProgressEvent): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
  info(msg: string): void {
    process.stderr.write(`${msg}\n`);
  }
  stop(): void {}
}

const HEARTBEAT_MS = 60_000;

class PlainDisplay implements Display {
  private state: PipelineState | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastWrite = Date.now();
  private header: RunHeader = EMPTY_HEADER;
  private started = false;

  start(state: PipelineState): void {
    this.started = true;
    const parts = [`odu · ${state.name} @ ${commitLabel(state)}`];
    const lanes = laneText(this.header);
    if (lanes !== "") parts.push(lanes);
    const claiming = claimingText(this.header);
    if (claiming !== "") parts.push(`claiming ${claiming}`);
    const banner = parts.join(" · ");
    this.say(
      this.header.hostsSource !== null
        ? `${banner} (hosts: ${this.header.hostsSource})`
        : banner,
    );
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.timer.unref?.();
  }

  setHeader(header: RunHeader): void {
    const before = this.header;
    this.header = header;
    if (!this.started) return;
    if (runPhase(before) === runPhase(header)) return;
    const lanes = laneText(header);
    if (lanes !== "") {
      this.say(`odu · lanes ${lanes}`);
      return;
    }
    const claiming = claimingText(header);
    this.say(
      claiming !== ""
        ? `odu · claiming ${claiming}`
        : "odu · no lanes — the run got no machine",
    );
  }

  update(state: PipelineState): void {
    this.state = state;
  }

  transition(event: ProgressEvent, node: NodeState): void {
    const glyph = STATUS_META[node.status].glyph;
    const dur =
      node.durationMs !== null ? ` ${formatGoDuration(node.durationMs)}` : "";
    const logRef =
      node.status === "failed" || node.status === "errored"
        ? `  → ${event.log}`
        : "";
    this.say(`${glyph} ${event.status.padEnd(7)} ${event.node}${dur}${logRef}`);
  }

  info(msg: string): void {
    process.stderr.write(`${msg}\n`);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  private heartbeat(): void {
    if (this.state === undefined) return;
    if (Date.now() - this.lastWrite < HEARTBEAT_MS) return;
    const now = Date.now();
    const running = this.state.order
      .map((id) => this.state?.nodes[id])
      .filter((n): n is NodeState => n !== undefined && n.status === "running")
      .map((n) => `${n.id} (${formatGoDuration(now - (n.startedAt ?? now))})`);
    if (running.length > 0) this.say(`… still running: ${running.join(", ")}`);
  }

  private say(line: string): void {
    this.lastWrite = Date.now();
    process.stdout.write(`${line}\n`);
  }
}

class LiveDisplay implements Display {
  private view: LiveView | undefined;
  private pending: PipelineState | undefined;
  private header: RunHeader = EMPTY_HEADER;

  constructor(private readonly opts: LiveOpts) {}

  start(state: PipelineState): void {
    this.pending = state;
    void this.load().catch((err: unknown) => {
      process.stderr.write(
        `odu: live view unavailable (${errorMessage(err)}) — continuing without it\n`,
      );
    });
  }

  private async load(): Promise<void> {
    const { LiveView: Ctor } = await import("./liveView");
    if (this.stopped) return;
    const view = new Ctor(this.opts);
    this.view = view;
    const pending = this.pending;
    if (pending !== undefined) view.start(pending, this.header);
  }

  private stopped = false;

  setHeader(header: RunHeader): void {
    this.header = header;
    this.view?.setHeader(header);
  }

  update(state: PipelineState): void {
    if (this.pending !== undefined) this.pending = state;
    this.view?.update(state);
  }

  transition(event: ProgressEvent, node: NodeState): void {
    if (this.view !== undefined) {
      this.view.transition(node, event.log);
      return;
    }
    if (!STATUS_META[node.status].isRed) return;
    const dur =
      node.durationMs !== null ? ` (${formatGoDuration(node.durationMs)})` : "";
    process.stdout.write(
      `${operatorLine(
        `${STATUS_META[node.status].glyph} ${node.id} ${node.status}${dur}  → ${event.log}`,
      )}\n`,
    );
  }

  info(msg: string): void {
    if (this.view !== undefined) {
      this.view.info(msg);
      return;
    }
    process.stdout.write(`${operatorLine(msg)}\n`);
  }

  stop(state?: PipelineState): void {
    this.stopped = true;
    this.view?.stop(state);
  }
}
