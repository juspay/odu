import {
  bg,
  bold,
  BoxRenderable,
  CliRenderer,
  fg,
  link,
  type ParsedKey,
  StyledText,
  type TextChunk,
  TextRenderable,
} from "@opentui/core";
import type { Stream } from "effect";
import {
  type NodeLogFrame,
  type NodeState,
  type PipelineState,
  postingOf,
  type RunHeader,
  STATUS_META,
} from "@odu/run-client/surface";
import { splitFanId } from "@odu/run-client/nodeId";
import { errorMessage, subscribe } from "@odu/execution/common/effectEdge";
import { formatGoDuration } from "@odu/execution/common/duration";
import {
  commitLabel,
  cellAt,
  operatorLine,
  defaultAttachId,
  matrixShape,
  OUTCOME_CELL,
  OUTCOME_MARK,
  recipeLabel,
  STATUS_CELL,
  postingWarning,
  stepFocus,
} from "./render";
import {
  countsLine,
  countsParts,
  outcomeOf,
  summarize,
} from "@odu/execution/common/verdict";
import { stripAnsi } from "./ansi";
import { LogView } from "./logView";

const TICK_MS = 100;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const DIM = "#6b7a80";
const FG = "#c6d2d3";
const ACCENT = "#3ad3b8";
const INK = "#0b1013";
const TRACK = "#2a343a";

export interface LiveOpts {
  interactive: boolean;
  hookStderr: boolean;
  openLog: (id: string) => Stream.Stream<NodeLogFrame, unknown>;
  rerun: (id: string) => void;
  onQuit: () => void;
}

export interface LiveViewOpts extends LiveOpts {
  createRenderer?: () => Promise<CliRenderer>;
}

interface Event {
  text: string;
  color: string;
  nodeId?: string;
}

function keyId(key: ParsedKey): string {
  const seq = key.sequence ?? "";
  if (seq.length === 1 && seq >= " ") return seq;
  return key.name ?? "";
}

const MOVES: Record<string, "h" | "j" | "k" | "l"> = {
  h: "h",
  j: "j",
  k: "k",
  l: "l",
  left: "h",
  down: "j",
  up: "k",
  right: "l",
};

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

interface Binding {
  keys: readonly string[];
  hint: string | null;
  act: (v: LiveView, id: string) => void;
}

const BINDINGS: readonly Binding[] = [
  {
    keys: Object.keys(MOVES),
    hint: "hjkl move",
    act: (v, id) => {
      const move = MOVES[id];
      if (move !== undefined) v.moveFocus(move);
    },
  },
  { keys: DIGITS, hint: "1-9 jump", act: (v, id) => v.focusNth(Number(id)) },
  { keys: ["r"], hint: "r rerun", act: (v) => v.rerunFocused() },
  {
    keys: ["f"],
    hint: "f follow",
    act: (v) => v.withLog((l) => l.toggleFollow()),
  },
  { keys: ["/"], hint: "/ search", act: (v) => v.beginSearch() },
  { keys: ["n"], hint: "n next", act: (v) => v.withLog((l) => l.next()) },
  {
    keys: ["g", "home"],
    hint: "Home/End top/tail",
    act: (v) => v.withLog((l) => l.toTop()),
  },
  { keys: ["G", "end"], hint: null, act: (v) => v.withLog((l) => l.toBottom()) },
  { keys: ["pageup"], hint: "PgUp/PgDn scroll", act: (v) => v.page(-1) },
  { keys: ["pagedown"], hint: null, act: (v) => v.page(1) },
  { keys: ["q"], hint: "q quit", act: (v) => v.quit() },
];

const HINTS = BINDINGS.map((b) => b.hint).filter(
  (h): h is string => h !== null,
);

const QUIT_HINT = BINDINGS.find((b) => b.keys.includes("q"))?.hint ?? "q quit";

function keyHints(room: number): string[] {
  const chosen: string[] = [];
  for (const hint of HINTS) {
    if (hint === QUIT_HINT) continue;
    if ([...chosen, hint, QUIT_HINT].join(" · ").length > room) break;
    chosen.push(hint);
  }
  return [...chosen, QUIT_HINT];
}

const EVENT_ROWS = 2;

const LOG_FLOOR = 8;

const MIN_PANE_COLS = 44;

/** opentui runs its own mouse text-selection: a drag paints a highlight across
 *  every cell it crosses. Nothing here selects. */
function inert<T extends { selectable: boolean }>(r: T): T {
  r.selectable = false;
  return r;
}

/** opentui draws a border title only when it fits ENTIRELY — an over-long one
 *  is dropped, not truncated. */
function paneTitle(
  id: string,
  meta: string,
  anchor: string,
  width: number,
): string {
  const room = Math.max(0, width - 6);
  const full = `${id}${meta === "" ? "" : ` — ${meta}`}  ${anchor}`;
  if (full.length <= room) return full;
  const bare = `${id}  ${anchor}`;
  if (bare.length <= room) return bare;
  const forId = room - anchor.length - 2;
  if (forId >= 4) return `…${id.slice(id.length - forId + 1)}  ${anchor}`;
  return id.slice(Math.max(0, id.length - room));
}

type Row = readonly TextChunk[];

/** Set a row's spans only when they actually changed.
 *
 *  `TextRenderable`'s own guard compares the incoming `StyledText` by
 *  REFERENCE, and building one allocates a fresh object every time — so the
 *  guard never fires and each assignment re-parses and re-measures the row. */
const LAST_TEXT = new WeakMap<TextRenderable, string>();
function setRow(row: TextRenderable, chunks: Row): void {
  const key = chunks.map((c) => `${c.fg ?? ""}\u0000${c.text}`).join("\u0001");
  if (LAST_TEXT.get(row) === key) return;
  LAST_TEXT.set(row, key);
  row.content = new StyledText([...chunks]);
}

const plain = (text: string): TextChunk => fg(FG)(text);
const faint = (text: string): TextChunk => fg(DIM)(text);

export class LiveView {
  private renderer: CliRenderer | undefined;
  private state: PipelineState | undefined;
  private header: RunHeader | undefined;

  private focusedId: string | undefined;
  private focusLocked = false;

  private log: LogView | undefined;
  private logSub: AbortController | undefined;
  private events: Event[] = [];

  private searching = false;
  private query = "";

  private pressHintAt(x: number): void {
    const hit = this.hintHits.find((h) => x >= h.from && x < h.to);
    if (hit === undefined) return;
    const key = hit.binding.keys[0];
    if (key !== undefined) hit.binding.act(this, key);
  }

  private focusAtCell(x: number, y: number): void {
    const state = this.state;
    const box = this.matrixBox;
    const geom = this.matrixGeom;
    if (state === undefined || box === undefined || geom === undefined) return;
    const row = y - box.y - 1;
    if (row < 0 || row >= geom.shown) return;
    const { recipes } = this.shapeOf(state.order);
    const recipe = recipes[geom.from + row];
    if (recipe === undefined) return;

    const current =
      this.focusedId !== undefined
        ? splitFanId(this.focusedId).platform
        : undefined;
    const offset = x - box.x - geom.gutter;
    const platform =
      offset < 0
        ? current
        : geom.platforms[Math.floor(offset / geom.cellW)] ?? current;
    if (platform === undefined) return;

    const target = cellAt(state, recipe, platform);
    if (target === undefined) return;
    this.focusLocked = true;
    this.focus(target.id);
  }

  private shapeMemo:
    | { order: readonly string[]; shape: ReturnType<typeof matrixShape> }
    | undefined;
  private tick = 0;
  private dirty = false;
  private resized = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private torndown = false;

  private readonly stderrWrite = process.stderr.write.bind(process.stderr);
  private retained: string[] = [];
  private hooked = false;

  private headLine: TextRenderable | undefined;
  private laneLine: TextRenderable | undefined;
  private noticeBox: BoxRenderable | undefined;
  private noticeRowsR: TextRenderable[] = [];
  private bodyBox: BoxRenderable | undefined;
  private sideBox: BoxRenderable | undefined;
  private wide: boolean | undefined;
  private sideWidth: number | "auto" | undefined;
  private matrixTop = 0;
  private matrixBox: BoxRenderable | undefined;
  private eventsBox: BoxRenderable | undefined;
  private paneBox: BoxRenderable | undefined;
  private paneRowsBox: BoxRenderable | undefined;
  private paneScrollBox: BoxRenderable | undefined;
  private scrollRows: TextRenderable[] = [];
  private scrollGeom: { height: number; thumb: number; at: number } | undefined;
  private grabOffset = 0;
  private statusLine: TextRenderable | undefined;
  private hintHits: { from: number; to: number; binding: Binding }[] = [];
  private matrixGeom:
    | {
        gutter: number;
        cellW: number;
        platforms: string[];
        from: number;
        shown: number;
      }
    | undefined;
  private matrixRows: TextRenderable[] = [];
  private eventRows: TextRenderable[] = [];
  private paneRows: TextRenderable[] = [];

  private readonly onProcessExit = (): void => {
    if (this.torndown) return;
    this.unhook();
    this.renderer?.destroy();
  };

  constructor(private readonly opts: LiveViewOpts) {}

  start(state: PipelineState, header: RunHeader): void {
    this.state = state;
    this.header = header;
    process.once("exit", this.onProcessExit);
    this.seedFocus(state);
    if (this.opts.hookStderr) this.hook();
    void this.mount().catch((err: unknown) => {
      this.unhook();
      this.stderrWrite(
        `odu: live view unavailable (${errorMessage(err)}) — continuing without it\n`,
      );
    });
    this.wake();
  }

  setHeader(header: RunHeader): void {
    this.header = header;
    this.wake();
  }

  /** Open the terminal.
   *
   *  Deliberately NOT `createCliRenderer`: that helper is `new CliRenderer(…)`
   *  followed by `await setupTerminal()`, and only the second step touches the
   *  terminal (raw mode, alternate screen, mouse). Bundled, they leave a window
   *  where the screen has been switched but the renderer this class would need
   *  to switch it back has not been assigned. */
  private async mount(): Promise<void> {
    if (this.stopped) return;
    const renderer =
      this.opts.createRenderer !== undefined
        ? await this.opts.createRenderer()
        : this.openTerminal();
    this.renderer = renderer;
    if (this.opts.createRenderer === undefined) {
      try {
        await renderer.setupTerminal();
      } catch (err) {
        renderer.destroy();
        this.renderer = undefined;
        throw err;
      }
    }
    if (this.stopped) {
      renderer.destroy();
      return;
    }
    this.build();
    if (this.opts.interactive) {
      renderer.keyInput.on("keypress", (key: ParsedKey) => this.onKey(key));
    }
    renderer.on("resize", () => {
      this.resized = true;
      this.dirty = true;
      this.wake();
    });
    this.relayout();
  }

  private openTerminal(): CliRenderer {
    const positive = (n: number | undefined, fallback: number): number =>
      n !== undefined && n > 0 ? n : fallback;
    return new CliRenderer(
      process.stdin,
      process.stdout,
      // NOT `?? 80`: a stdout whose size is unknown reports 0, not undefined,
      // and a 0x0 renderer is rejected outright — the live view would silently
      // degrade to nothing on any terminal that has not reported its size yet.
      positive(process.stdout.columns, 80),
      positive(process.stdout.rows, 24),
      {
        screenMode: "alternate-screen",
        exitOnCtrlC: false,
        exitSignals: [],
        // opentui's console overlay would otherwise swallow console.* for the
        // whole process.
        consoleMode: "disabled",
        useMouse: this.opts.interactive,
        targetFps: 30,
      },
    );
  }

  update(state: PipelineState): void {
    this.state = state;
    this.wake();
    this.seedFocus(state);
    this.paint();
  }

  transition(node: NodeState, logPath: string): void {
    if (!STATUS_META[node.status].isRed) return;
    const dur =
      node.durationMs !== null ? ` (${formatGoDuration(node.durationMs)})` : "";
    this.pushEvent(
      `${STATUS_META[node.status].glyph} ${node.id} ${node.status}${dur}  → ${logPath}`,
      STATUS_CELL[node.status],
      true,
      false,
      node.id,
    );
  }

  info(msg: string): void {
    this.pushEvent(msg, DIM, false);
  }

  private static readonly RETAIN_MAX = 32;

  private pushEvent(
    text: string,
    color: string,
    now = true,
    retain = true,
    nodeId?: string,
  ): void {
    if (this.renderer === undefined) {
      process.stdout.write(`${operatorLine(text)}\n`);
      return;
    }
    this.events.push({ text, color, nodeId });
    if (this.events.length > EVENT_ROWS) this.events.shift();
    if (retain) {
      if (this.retained.length < LiveView.RETAIN_MAX) this.retained.push(text);
      else this.retained[LiveView.RETAIN_MAX - 1] = text;
    }
    if (now) this.paint();
    else {
      this.dirty = true;
      this.wake();
    }
  }

  stop(state?: PipelineState): void {
    if (this.stopped) return;
    this.stopped = true;
    this.sleep();
    this.logSub?.abort();
    this.log?.dispose();
    this.log = undefined;
    if (state !== undefined) this.state = state;
    this.finishStop();
  }

  private finishStop(): void {
    if (this.torndown) return;
    this.torndown = true;
    process.off("exit", this.onProcessExit);
    this.unhook();
    this.renderer?.destroy();
    this.renderer = undefined;
    const clean = this.state !== undefined && summarize(this.state).clean;
    if (!clean) for (const line of this.retained) this.stderrWrite(`${line}\n`);
    this.retained = [];
    this.events = [];
  }

  /** The fabricated `write` MUST invoke the caller's callback — a writer
   *  awaiting drain hangs forever otherwise. */
  private hook(): void {
    if (this.hooked) return;
    this.hooked = true;
    const handler: typeof process.stderr.write = (
      chunk: Uint8Array | string,
      encodingOrCb?: unknown,
      maybeCb?: unknown,
    ): boolean => {
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        if (line.startsWith("[host:")) continue;
        this.pushEvent(stripAnsi(line), DIM, false);
      }
      const cb = [encodingOrCb, maybeCb].find(
        (a): a is () => void => typeof a === "function",
      );
      cb?.();
      return true;
    };
    process.stderr.write = handler;
  }

  private unhook(): void {
    if (!this.hooked) return;
    this.hooked = false;
    process.stderr.write = this.stderrWrite;
  }

  private build(): void {
    const r = this.renderer;
    if (r === undefined) return;
    const frame = inert(
      new BoxRenderable(r, {
        id: "odu",
        width: "100%",
        height: "100%",
        flexDirection: "column",
      }),
    );
    r.root.add(frame);

    const head = inert(
      new BoxRenderable(r, {
        id: "head",
        width: "100%",
        flexShrink: 0,
        flexDirection: "column",
      }),
    );
    this.headLine = inert(
      new TextRenderable(r, { id: "head-1", content: "", wrapMode: "none" }),
    );
    this.laneLine = inert(
      new TextRenderable(r, {
        id: "head-2",
        content: "",
        fg: DIM,
        wrapMode: "none",
      }),
    );
    head.add(this.headLine);
    head.add(this.laneLine);
    frame.add(head);

    this.noticeBox = inert(
      new BoxRenderable(r, {
        id: "notices",
        width: "100%",
        flexShrink: 0,
        flexDirection: "column",
      }),
    );
    frame.add(this.noticeBox);

    this.bodyBox = inert(
      new BoxRenderable(r, {
        id: "body",
        width: "100%",
        flexGrow: 1,
        flexDirection: "column",
      }),
    );
    frame.add(this.bodyBox);

    this.sideBox = inert(
      new BoxRenderable(r, {
        id: "side",
        flexShrink: 0,
        flexDirection: "column",
      }),
    );
    this.bodyBox.add(this.sideBox);

    this.matrixBox = inert(
      new BoxRenderable(r, {
        id: "matrix",
        width: "100%",
        flexShrink: 0,
        flexDirection: "column",
        onMouseDown: (e) => this.focusAtCell(e.x, e.y),
      }),
    );
    this.sideBox.add(this.matrixBox);

    this.paneBox = inert(
      new BoxRenderable(r, {
        id: "pane",
        flexGrow: 1,
        flexDirection: "column",
        border: true,
        title: "",
        onMouseScroll: (e) => {
          const scroll = e.scroll;
          if (scroll === undefined) return;
          const rows = Math.max(1, scroll.delta);
          this.withLog((l) =>
            l.scrollBy(scroll.direction === "up" ? -rows : rows),
          );
          this.dirty = true;
          this.wake();
        },
      }),
    );
    this.bodyBox.add(this.paneBox);

    const split = inert(
      new BoxRenderable(r, {
        id: "pane-split",
        width: "100%",
        flexGrow: 1,
        flexDirection: "row",
      }),
    );
    this.paneBox.add(split);
    this.paneRowsBox = inert(
      new BoxRenderable(r, {
        id: "pane-rows",
        flexGrow: 1,
        flexDirection: "column",
      }),
    );
    split.add(this.paneRowsBox);
    this.paneScrollBox = inert(
      new BoxRenderable(r, {
        id: "pane-scroll",
        width: 1,
        flexShrink: 0,
        flexDirection: "column",
        onMouseDown: (e) => this.grabScrollbar(e.y),
        onMouseDrag: (e) => this.dragScrollbar(e.y),
      }),
    );
    split.add(this.paneScrollBox);

    this.eventsBox = inert(
      new BoxRenderable(r, {
        id: "events",
        width: "100%",
        flexShrink: 0,
        flexDirection: "column",
        onMouseDown: (e) => this.focusEventAt(e.y),
      }),
    );
    frame.add(this.eventsBox);

    this.statusLine = inert(
      new TextRenderable(r, {
        id: "status",
        content: "",
        fg: DIM,
        wrapMode: "none",
        onMouseDown: (e) => this.pressHintAt(e.x),
      }),
    );
    frame.add(this.statusLine);
  }

  private applyOrientation(sideW: number): boolean {
    const body = this.bodyBox;
    const side = this.sideBox;
    const r = this.renderer;
    if (body === undefined || side === undefined || r === undefined)
      return false;
    const wide = r.terminalWidth >= sideW + MIN_PANE_COLS;
    if (wide !== this.wide) {
      body.flexDirection = wide ? "row" : "column";
      this.wide = wide;
    }
    const want: number | "auto" = wide ? sideW : "auto";
    if (want !== this.sideWidth) {
      side.width = want;
      this.sideWidth = want;
    }
    return wide;
  }

  private matrixCap(wide: boolean): number {
    const r = this.renderer;
    if (r === undefined) return Number.MAX_SAFE_INTEGER;
    const body = r.terminalHeight - 2 - this.notices().length - 1;
    const forPane = wide ? 0 : LOG_FLOOR + 2;
    return Math.max(1, body - forPane - this.events.length - 1);
  }

  private matrixWindowTop(
    total: number,
    shown: number,
    focusIdx: number,
  ): number {
    const maxTop = Math.max(0, total - shown);
    let top = Math.min(this.matrixTop, maxTop);
    if (focusIdx >= 0) {
      if (focusIdx < top) top = focusIdx;
      else if (focusIdx >= top + shown) top = focusIdx - shown + 1;
    }
    this.matrixTop = Math.max(0, Math.min(top, maxTop));
    return this.matrixTop;
  }

  private relayout(): void {
    this.paint();
    this.repaintAfterLayout();
  }

  /** Yoga measures during a render, so a paint triggered by the event that
   *  *changed* the layout still reads the previous frame's geometry (zero,
   *  before the first one). Painting again on the next turn picks up the real
   *  measurement. */
  private repaintAfterLayout(): void {
    const t = setTimeout(() => this.paint(), 0);
    (t as { unref?: () => void }).unref?.();
  }

  private paneCols(): number {
    const measured = this.paneRowsBox?.width ?? 0;
    if (measured > 0) return Math.max(20, measured);
    const outer = this.paneBox?.width ?? (this.renderer?.terminalWidth ?? 80);
    return Math.max(20, outer - 3);
  }

  private paneRowCount(): number {
    const measured = this.paneBox?.height ?? 0;
    if (measured > 0) return Math.max(0, measured - 2);
    return Math.max(0, (this.renderer?.terminalHeight ?? 24) - 12);
  }

  private notices(): string[] {
    const state = this.state;
    if (state === undefined) return [];
    const warn = postingWarning(postingOf(state));
    return warn === null ? [] : [warn];
  }

  private seedFocus(state: PipelineState): void {
    if (this.focusLocked) return;
    const id = defaultAttachId(state);
    if (id !== undefined) this.focus(id);
  }

  private focus(id: string): void {
    if (id === this.focusedId) return;
    this.focusedId = id;
    this.openLog(id);
    this.paint();
  }

  private openLog(id: string): void {
    this.logSub?.abort();
    this.log?.dispose();
    this.log = new LogView(this.paneCols(), this.paneRowCount(), this.query);
    const controller = new AbortController();
    this.logSub = controller;
    const live = (): boolean =>
      !controller.signal.aborted && this.logSub === controller && !this.stopped;
    void (async () => {
      try {
        for await (const frame of subscribe(
          this.opts.openLog(id),
          controller.signal,
        )) {
          if (!live()) return;
          if (frame.kind === "end") continue;
          if (frame.kind === "snapshot") this.log?.reset();
          await this.log?.write(frame.text);
          if (!live()) return;
          this.dirty = true;
          this.wake();
        }
      } catch (err) {
        if (!live()) return;
        await this.log?.write(
          `\n[odu] log stream error: ${errorMessage(err)}\n`,
        );
        this.paint();
      }
    })();
  }

  private onKey(key: ParsedKey): void {
    const name = key.name ?? "";
    const seq = key.sequence ?? "";

    if (key.ctrl === true && (name === "c" || name === "d")) {
      this.quit();
      return;
    }
    if (this.searching) {
      if (name === "escape") {
        this.searching = false;
        this.setQuery("");
      } else if (name === "return") {
        this.searching = false;
        this.log?.next();
      } else if (name === "backspace") {
        this.setQuery(this.query.slice(0, -1));
      } else if (seq.length === 1 && seq >= " ") {
        this.setQuery(this.query + seq);
      }
      this.paint();
      return;
    }

    const id = keyId(key);
    const binding = BINDINGS.find((b) => b.keys.includes(id));
    if (binding === undefined) return;
    binding.act(this, id);
    this.paint();
  }

  quit(): void {
    this.opts.onQuit();
  }

  rerunFocused(): void {
    const id = this.focusedId;
    if (id === undefined) return;
    this.opts.rerun(id);
    this.info(`rerun requested: ${id}`);
  }

  withLog(act: (log: LogView) => void): void {
    if (this.log !== undefined) act(this.log);
  }

  beginSearch(): void {
    this.searching = true;
    this.setQuery("");
  }

  page(direction: -1 | 1): void {
    this.log?.scrollBy(direction * Math.max(1, this.paneRowCount() - 1));
  }

  moveFocus(key: "h" | "j" | "k" | "l"): void {
    const state = this.state;
    if (state === undefined) return;
    const next = stepFocus(state.order, this.focusedId, key);
    if (next === undefined) return;
    this.focusLocked = true;
    this.focus(next);
  }

  focusNth(n: number): void {
    const next = this.state?.order[n - 1];
    if (next === undefined) return;
    this.focusLocked = true;
    this.focus(next);
  }

  private setQuery(q: string): void {
    this.query = q;
    this.log?.setQuery(q);
  }

  private wake(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.timer = setInterval(() => this.onTick(), TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private sleep(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private onTick(): void {
    const s = this.state;
    if (s === undefined || this.renderer === undefined) return;
    const animating = summarize(s).running > 0;
    if (!animating && !this.dirty) {
      this.sleep();
      return;
    }
    if (animating) this.tick += 1;
    this.dirty = false;
    if (this.resized) {
      this.resized = false;
      this.relayout();
      return;
    }
    this.paint();
  }

  private paint(): void {
    if (this.stopped || this.renderer === undefined) return;
    const state = this.state;
    const header = this.header;
    if (state === undefined || header === undefined) return;
    this.dirty = false;

    const s = summarize(state);
    const spin = SPINNER[this.tick % SPINNER.length] ?? "⠋";
    const outcome = outcomeOf(s);
    const mark = outcome === "pending" ? spin : OUTCOME_MARK[outcome];
    const now = Date.now();
    const elapsed =
      header.startedAt > 0 ? formatGoDuration(now - header.startedAt) : "";
    // opentui's cell buffer has no escape parser, so an OSC 8 escape is
    // painted as literal text.
    const label = commitLabel(state);
    if (this.headLine !== undefined) {
      const markHue =
        outcome === "pending" ? STATUS_CELL.running : OUTCOME_CELL[outcome];
      const sha =
        header.commitUrl !== null
          ? link(header.commitUrl)(faint(label))
          : faint(label);
      setRow(this.headLine, [
        bold(plain("odu ")),
        fg(markHue)(`${mark} `),
        bold(plain(state.name)),
        faint(" @ "),
        sha,
        faint(elapsed === "" ? "" : `  ${elapsed}`),
      ]);
    }
    this.paintNotices();
    if (this.laneLine !== undefined) {
      const lanes: TextChunk[] = [];
      for (const l of header.lanes) {
        if (lanes.length > 0) lanes.push(faint("   "));
        lanes.push(
          plain(l.platform),
          faint(" ▸ "),
          faint(
            l.state === "leased" ? l.host : `claiming ${l.pool.join(", ")}`,
          ),
        );
      }
      setRow(this.laneLine, lanes);
    }

    this.paintMatrix(state, now, spin);
    this.paintEvents();
    this.paintPane(state);
    this.paintStatus(s);
  }

  private paintMatrix(state: PipelineState, now: number, spin: string): void {
    const box = this.matrixBox;
    const r = this.renderer;
    if (box === undefined || r === undefined) return;
    const { recipes, platforms } = this.shapeOf(state.order);
    const nameW = Math.max(
      9,
      ...recipes.map((x: string) => recipeLabel(x).length),
    );
    const cellW = Math.max(14, ...platforms.map((x: string) => x.length + 2));

    const wide = this.applyOrientation(nameW + 3 + cellW * platforms.length);

    const focused =
      this.focusedId !== undefined ? splitFanId(this.focusedId) : undefined;
    const cap = this.matrixCap(wide);
    const windowed = recipes.length > cap;
    const shown = windowed ? Math.max(1, cap - 1) : recipes.length;
    const focusIdx = recipes.findIndex(
      (x: string) => x === focused?.namepath,
    );
    const from = windowed ? this.matrixWindowTop(recipes.length, shown, focusIdx) : 0;

    this.matrixGeom = {
      gutter: nameW + 3,
      cellW,
      platforms: [...platforms],
      from,
      shown,
    };

    const header: Row = [
      faint(`  ${"".padEnd(nameW)}  `),
      ...platforms.map((pl: string) => faint(pl.padEnd(cellW))),
    ];
    const rows: Row[] = [header];
    for (const recipe of recipes.slice(from, from + shown)) {
      const onRow = focused?.namepath === recipe;
      const cells: TextChunk[] = [
        fg(ACCENT)(onRow ? "› " : "  "),
        onRow
          ? bold(plain(recipeLabel(recipe).padEnd(nameW)))
          : plain(recipeLabel(recipe).padEnd(nameW)),
        plain(" "),
      ];
      for (const platform of platforms) {
        const node = cellAt(state, recipe, platform);
        const here = onRow && focused?.platform === platform;
        if (node === undefined) {
          cells.push(faint(` °${"".padEnd(cellW - 2)}`));
          continue;
        }
        const glyph =
          node.status === "running" ? spin : STATUS_META[node.status].glyph;
        const time =
          node.status === "running"
            ? formatGoDuration(now - (node.startedAt ?? now))
            : node.durationMs !== null
              ? formatGoDuration(node.durationMs)
              : "";
        cells.push(fg(ACCENT)(here ? "▸" : " "));
        cells.push(fg(STATUS_CELL[node.status])(`${glyph} `));
        cells.push(
          node.status === "running"
            ? fg(STATUS_CELL.running)(time.padEnd(Math.max(0, cellW - 3)))
            : faint(time.padEnd(Math.max(0, cellW - 3))),
        );
      }
      rows.push(cells);
    }

    if (windowed) {
      const hidden = recipes.length - shown;
      rows.push([
        faint(`  ⋯ ${hidden} more`),
        faint(from > 0 ? "  ↑ hjkl scrolls the matrix" : "  ↓ hjkl scrolls the matrix"),
      ]);
    }

    this.syncRows(box, this.matrixRows, rows.length, "mx", (row, i) => {
      setRow(row, rows[i] ?? []);
    });
  }

  private shapeOf(order: readonly string[]): ReturnType<typeof matrixShape> {
    const memo = this.shapeMemo;
    if (memo !== undefined && memo.order === order) return memo.shape;
    const shape = matrixShape(order);
    this.shapeMemo = { order, shape };
    return shape;
  }

  private paintNotices(): void {
    const box = this.noticeBox;
    if (box === undefined) return;
    const lines = this.notices();
    this.syncRows(box, this.noticeRowsR, lines.length, "nt", (row, i) => {
      setRow(row, [fg(STATUS_CELL.running)(lines[i] ?? "")]);
    });
  }

  private paintEvents(): void {
    const box = this.eventsBox;
    if (box === undefined) return;
    this.syncRows(box, this.eventRows, this.events.length, "ev", (row, i) => {
      const ev = this.events[i];
      setRow(row, [fg(ev?.color ?? DIM)(ev?.text ?? "")]);
    });
  }

  private paintPane(state: PipelineState): void {
    const box = this.paneBox;
    if (box === undefined) return;
    const id = this.focusedId;
    const node = id !== undefined ? state.nodes[id] : undefined;
    const following = this.log?.following !== false;
    const meta =
      node === undefined
        ? ""
        : node.status === "running"
          ? `running ${formatGoDuration(Date.now() - (node.startedAt ?? Date.now()))}`
          : node.exitCode !== null
            ? `exit ${node.exitCode}${
                node.durationMs !== null
                  ? ` · ${formatGoDuration(node.durationMs)}`
                  : ""
              }`
            : node.status;
    const anchor = following ? "‹follow›" : "‹pinned›";
    box.title = paneTitle(
      id ?? "",
      meta,
      anchor,
      box.width > 0 ? box.width : (this.renderer?.terminalWidth ?? 80),
    );

    const height = this.paneRowCount();
    this.log?.resize(this.paneCols(), height);
    const rows = this.log?.rows() ?? [];
    const rowsBox = this.paneRowsBox ?? box;
    this.paintScrollbar(height);
    this.syncRows(rowsBox, this.paneRows, height, "pane", (row, i) => {
      const line = rows[i];
      if (line === undefined) {
        setRow(row, []);
        return;
      }
      if (line.match) {
        setRow(row, [bg(ACCENT)(fg(INK)(line.text))]);
        return;
      }
      setRow(
        row,
        line.spans.map((sp) => (sp.fg === undefined ? plain(sp.text) : fg(sp.fg)(sp.text))),
      );
    });
  }

  private paintScrollbar(height: number): void {
    const box = this.paneScrollBox;
    const log = this.log;
    if (box === undefined) return;
    const total = log?.total ?? 0;
    if (log === undefined || total <= height || height <= 0) {
      this.scrollGeom = undefined;
      this.syncRows(box, this.scrollRows, height, "sb", (row) => {
        setRow(row, [plain(" ")]);
      });
      return;
    }
    const start = log.windowTop;
    const maxStart = Math.max(1, total - height);
    const thumb = Math.max(1, Math.floor((height * height) / total));
    const at = Math.round((start / maxStart) * (height - thumb));
    this.scrollGeom = { height, thumb, at };
    this.syncRows(box, this.scrollRows, height, "sb", (row, i) => {
      const onThumb = i >= at && i < at + thumb;
      setRow(row, [
        onThumb ? fg(ACCENT)("█") : fg(TRACK)("│"),
      ]);
    });
  }

  private focusEventAt(y: number): void {
    const box = this.eventsBox;
    const state = this.state;
    if (box === undefined || state === undefined) return;
    const event = this.events[y - box.y];
    const id = event?.nodeId;
    if (id === undefined || state.nodes[id] === undefined) return;
    this.focusLocked = true;
    this.focus(id);
  }

  private scrollbarRowToLine(row: number): number | undefined {
    const geom = this.scrollGeom;
    const log = this.log;
    if (geom === undefined || log === undefined) return undefined;
    const travel = geom.height - geom.thumb;
    if (travel <= 0) return 0;
    const at = Math.max(0, Math.min(travel, row));
    return (at / travel) * log.maxWindowTop;
  }

  private grabScrollbar(y: number): void {
    const box = this.paneScrollBox;
    const geom = this.scrollGeom;
    if (box === undefined || geom === undefined) return;
    const row = y - box.y;
    this.grabOffset =
      row >= geom.at && row < geom.at + geom.thumb ? row - geom.at : 0;
    this.dragScrollbar(y);
  }

  private dragScrollbar(y: number): void {
    const box = this.paneScrollBox;
    if (box === undefined) return;
    const line = this.scrollbarRowToLine(y - box.y - this.grabOffset);
    if (line === undefined) return;
    this.withLog((l) => l.scrollTo(line));
    this.dirty = true;
    this.wake();
  }

  private paintStatus(s: ReturnType<typeof summarize>): void {
    const line = this.statusLine;
    if (line === undefined) return;
    if (this.searching) {
      const n = this.log?.matches ?? 0;
      setRow(line, [
        fg(ACCENT)(` /${this.query}`),
        fg(ACCENT)("▏"),
        faint(`   ${n} match${n === 1 ? "" : "es"}   `),
        fg(ACCENT)("⏎"),
        faint(" next · "),
        fg(ACCENT)("esc"),
        faint(" cancel"),
      ]);
      return;
    }
    const parts = countsParts(s);
    const chunks: TextChunk[] = [faint(" ")];
    parts.forEach((part, i) => {
      if (i > 0) chunks.push(faint(" · "));
      chunks.push(fg(STATUS_CELL[part.status])(part.text));
    });
    if (!this.opts.interactive) {
      setRow(line, chunks);
      return;
    }
    const width = this.renderer?.terminalWidth ?? 80;
    const plainCounts = countsLine(s);
    chunks.push(faint("    "));
    let column = chunks.reduce((n, c) => n + c.text.length, 0);
    this.hintHits = [];
    keyHints(width - plainCounts.length - 6).forEach((hint, i) => {
      if (i > 0) {
        chunks.push(faint(" · "));
        column += 3;
      }
      const binding = BINDINGS.find((b) => b.hint === hint);
      if (binding !== undefined) {
        this.hintHits.push({ from: column, to: column + hint.length, binding });
      }
      const gap = hint.indexOf(" ");
      if (gap < 0) chunks.push(fg(ACCENT)(hint));
      else {
        chunks.push(fg(ACCENT)(hint.slice(0, gap)));
        chunks.push(faint(hint.slice(gap)));
      }
      column += hint.length;
    });
    setRow(line, chunks);
  }

  private syncRows(
    box: BoxRenderable,
    rows: TextRenderable[],
    count: number,
    prefix: string,
    fill: (row: TextRenderable, i: number) => void,
  ): void {
    const r = this.renderer;
    if (r === undefined) return;
    while (rows.length > count) {
      const extra = rows.pop();
      // destroy() unparents itself; calling remove() first leaves the child
      // with a stale parent pointer.
      extra?.destroy();
    }
    for (let i = 0; i < count; i++) {
      let row = rows[i];
      if (row === undefined) {
        // `inert`: a mouse press hit-tests to the ROW under the pointer, not
        // to the box holding it.
        row = inert(
          new TextRenderable(r, {
            id: `${prefix}-${i}`,
            content: "",
            // Rows wrap by default, and a wrapped row makes its strip taller.
            wrapMode: "none",
          }),
        );
        rows.push(row);
        box.add(row);
      }
      fill(row, i);
    }
  }
}
