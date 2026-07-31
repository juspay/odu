/**
 * The live view — a viewport, not a printer.
 *
 * The renderer this replaces painted into the *primary* buffer: it moved the
 * cursor up `prevHeight` rows and erased to the end, which is only correct
 * while every painted line occupies exactly one terminal row and nothing else
 * writes to the tty. Any wrapped line, any resize (nothing listened for one),
 * and every `printAbove()` — which pushed failures and stderr into scrollback
 * *by design* — left the frame somewhere other than where the next repaint
 * expected it. That is the thing operators actually complained about: attach
 * scrolls.
 *
 * Here the session owns an alternate screen for its lifetime and hands it back
 * on exit, so scrollback is untouched while the run is live and carries exactly
 * one verdict afterwards. Layout is flexbox (opentui/yoga), so region heights
 * are constraints rather than arithmetic, and the log pane — pinned to twelve
 * rows before, on any size terminal — takes whatever height is left. Repaints
 * are damage-tracked by opentui's cell buffer, so a spinner tick rewrites a
 * spinner rather than a frame.
 *
 * Two orderings here are load-bearing and easy to undo by accident:
 *
 *   - `Display.start()` is SYNCHRONOUS but mounting opentui is async, so the
 *     mount is fire-and-forget and every entry point must tolerate running
 *     before it lands. State is held regardless; paints no-op until mounted.
 *   - `info()` is called long before `start()` (the venue lease can block for
 *     minutes), so a pre-mount message goes to real stdout. Only once the
 *     frame exists do messages become events inside it.
 */

import {
  BoxRenderable,
  type CliRenderer,
  createCliRenderer,
  type ParsedKey,
  TextRenderable,
} from "@opentui/core";
import {
  type NodeLogFrame,
  type NodeState,
  type PipelineState,
  type RunHeader,
  STATUS_META,
} from "../common/surface";
import { formatGoDuration } from "../common/duration";
import { splitFanId } from "../common/nodeId";
import {
  defaultAttachId,
  matrixShape,
  recipeLabel,
  stepFocus,
  summarize,
} from "./render";
import { dim, stripAnsi } from "./ansi";
import { LogView } from "./logView";

/** Repaint cadence while something is animating (a spinner, a ticking elapsed
 *  time). The old renderer ran a 120ms interval forever, including long after
 *  the run settled; here the clock idles when nothing moves. */
const TICK_MS = 100;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Terminal-cell colours. Deliberately not the `ansi.ts` helpers: those wrap
 *  text in escape codes for a stream, while here the renderer owns cell
 *  attributes. `ansi.ts` remains the source of truth for the json/plain faces
 *  and for `printVerdict`. */
const COLOR: Record<NodeState["status"], string> = {
  pending: "#6b7a80",
  running: "#e6b24d",
  ok: "#6fcf8e",
  failed: "#e8695b",
  skipped: "#6b7a80",
  errored: "#bb8ce2",
  cancelled: "#8a9a9e",
};
const DIM = "#6b7a80";
const FG = "#c6d2d3";
const ACCENT = "#3ad3b8";

/** What the view needs from its host — the same seam the previous renderer
 *  used, so `run` and `attach` keep their existing wiring verbatim. */
export interface LiveViewOpts {
  interactive: boolean;
  hookStderr: boolean;
  openLog: (
    id: string,
    signal: AbortSignal,
  ) => AsyncIterable<NodeLogFrame> | Promise<AsyncIterable<NodeLogFrame>>;
  rerun: (id: string) => void;
  onQuit: () => void;
  /** Test seam: supply the renderer instead of opening a real terminal. Only
   *  `liveView.test.ts` passes this (opentui's `createTestRenderer`), so the
   *  frame can be asserted as text without a pty. */
  createRenderer?: () => Promise<CliRenderer>;
}

interface Event {
  text: string;
  color: string;
}

/** How many events stay on screen. The lane is a tail, not a log — the full
 *  history is in the run's log files, and the frame must not grow. */
const EVENT_ROWS = 2;

export class LiveView {
  private renderer: CliRenderer | undefined;
  private mounting = false;
  private state: PipelineState | undefined;
  private header: RunHeader | undefined;

  private focusedId: string | undefined;
  private focusLocked = false;

  private log: LogView | undefined;
  private logSub: AbortController | undefined;
  private events: Event[] = [];

  private searching = false;
  private query = "";

  private tick = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  private readonly stderrWrite = process.stderr.write.bind(process.stderr);
  private hooked = false;

  private headLine: TextRenderable | undefined;
  private laneLine: TextRenderable | undefined;
  private matrixBox: BoxRenderable | undefined;
  private eventsBox: BoxRenderable | undefined;
  private paneBox: BoxRenderable | undefined;
  private statusLine: TextRenderable | undefined;
  private matrixRows: TextRenderable[] = [];
  private eventRows: TextRenderable[] = [];
  private paneRows: TextRenderable[] = [];

  constructor(private readonly opts: LiveViewOpts) {
    // Whatever path the process dies by (a throw past orchestrate, a missed
    // stop()), the terminal must come back: streams unhooked, alternate screen
    // released. Guarded so the normal stop() path doesn't double-restore.
    process.once("exit", () => {
      if (this.stopped) return;
      this.unhook();
      this.renderer?.destroy();
    });
  }

  /** Synchronous by contract (`Display.start`). Records state, hooks the
   *  streams, and kicks the async mount off without awaiting it. */
  start(state: PipelineState, header: RunHeader): void {
    this.state = state;
    this.header = header;
    this.seedFocus(state);
    if (this.opts.hookStderr) this.hook();
    void this.mount();
    this.timer = setInterval(() => this.onTick(), TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async mount(): Promise<void> {
    if (this.mounting || this.stopped) return;
    this.mounting = true;
    try {
      const renderer = await (this.opts.createRenderer ?? (() =>
        createCliRenderer({
          // The whole point: the session lives on the alternate screen, so the
          // operator's scrollback is never written to while the run is live.
          screenMode: "alternate-screen",
          // odu owns its shutdown and exit codes — the renderer must never call
          // process.exit out from under `run`'s poster finalization.
          exitOnCtrlC: false,
          exitSignals: [],
          // opentui's console overlay would otherwise swallow console.* for the
          // whole process.
          consoleMode: "disabled",
          useMouse: this.opts.interactive,
          targetFps: 30,
        })))();
      if (this.stopped) {
        renderer.destroy();
        return;
      }
      this.renderer = renderer;
      this.build();
      if (this.opts.interactive) {
        renderer.keyInput.on("keypress", (key: ParsedKey) => this.onKey(key));
      }
      renderer.on("resize", () => this.relayout());
      // Focus was seeded before the mount, so the log stream may not have been
      // opened yet — open it now that a pane exists to paint into.
      const id = this.focusedId;
      if (id !== undefined && this.log === undefined) this.openLog(id);
      this.paint();
    } finally {
      this.mounting = false;
    }
  }

  update(state: PipelineState): void {
    this.state = state;
    this.seedFocus(state);
    this.paint();
  }

  /** A node crossed a status boundary. Reds land in the events lane — the old
   *  renderer printed them into scrollback, which is exactly what moved the
   *  frame. Pre-mount they still go to stdout, so a failure during a long
   *  venue lease is never swallowed. */
  transition(node: NodeState, logPath: string): void {
    if (node.status !== "failed" && node.status !== "errored") return;
    const dur =
      node.durationMs !== null ? ` (${formatGoDuration(node.durationMs)})` : "";
    this.pushEvent(
      `${STATUS_META[node.status].glyph} ${node.id} ${node.status}${dur}  → ${logPath}`,
      COLOR[node.status],
    );
  }

  /** Operator-facing message. Called from the venue lease and the status
   *  poster long before `start()`, so pre-mount it must reach real stdout. */
  info(msg: string): void {
    this.pushEvent(msg, DIM);
  }

  private pushEvent(text: string, color: string): void {
    if (this.renderer === undefined) {
      // Pre-mount (or post-stop): no frame to hold this, so it belongs in the
      // scrollback the operator is actually looking at.
      process.stdout.write(`${dim(stripAnsi(text))}\n`);
      return;
    }
    this.events.push({ text, color });
    if (this.events.length > EVENT_ROWS) this.events.shift();
    this.paint();
  }

  /** Restore the terminal, and leave the scrollback to the host.
   *
   *  The view deliberately prints nothing here. `run` already ends with its own
   *  `printVerdict`, so a recap from the view is the same information twice;
   *  `attach` asks for `verdict()` and prints it itself. Verdict-on-exit is
   *  host policy, exactly like the exit code — the view owns neither.
   *
   *  Order matters: unhook the streams first so nothing races the teardown,
   *  then destroy the renderer, which restores the primary buffer. */
  stop(state?: PipelineState): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.logSub?.abort();
    this.log?.dispose();
    this.log = undefined;
    if (state !== undefined) this.state = state;
    this.unhook();
    this.renderer?.destroy();
    this.renderer = undefined;
  }

  /** The compact recap a host may print once the viewport is gone. `attach`
   *  uses it (nothing else would say how the run ended); `run` does not, having
   *  its own verdict. */
  verdict(): string | undefined {
    const state = this.state;
    if (state === undefined) return undefined;
    const s = summarize(state);
    const mark = !s.done ? "◼" : s.failedOverall ? "✗" : s.clean ? "✔" : "◼";
    const counts = [
      s.ok > 0 ? `${s.ok} ok` : null,
      s.running > 0 ? `${s.running} running` : null,
      s.failed > 0 ? `${s.failed} failed` : null,
      s.errored > 0 ? `${s.errored} errored` : null,
      s.cancelled > 0 ? `${s.cancelled} cancelled` : null,
      s.skipped > 0 ? `${s.skipped} skipped` : null,
    ]
      .filter((c): c is string => c !== null)
      .join(" · ");
    const reds = state.order
      .map((id) => state.nodes[id])
      .filter(
        (n): n is NodeState => n !== undefined && STATUS_META[n.status].isRed,
      );
    const lines = [
      `${mark} ${state.name} @ ${state.sha7}${state.dirty ? "+dirty" : ""}  ${counts}`,
    ];
    for (const n of reds.slice(0, 3)) {
      lines.push(`  ${STATUS_META[n.status].glyph} ${n.id}`);
    }
    return `${lines.join("\n")}\n`;
  }

  // ── stream interposition ─────────────────────────────────────────────────

  /** Library chatter must not reach the alternate screen raw. `[host:…]` lines
   *  (surface-remote provisioning, already mirrored into `_ci-setup`'s log) are
   *  dropped; anything else becomes an event inside the frame.
   *
   *  The fabricated `write` MUST invoke the caller's callback — a writer
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
        this.pushEvent(stripAnsi(line), DIM);
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

  // ── layout ───────────────────────────────────────────────────────────────

  /** Build the region tree once. Heights are constraints — the log pane's
   *  `flexGrow: 1` is the whole of what used to be a hardcoded twelve rows. */
  private build(): void {
    const r = this.renderer;
    if (r === undefined) return;
    const frame = new BoxRenderable(r, {
      id: "odu",
      width: "100%",
      height: "100%",
      flexDirection: "column",
    });
    r.root.add(frame);

    const head = new BoxRenderable(r, {
      id: "head",
      width: "100%",
      flexShrink: 0,
      flexDirection: "column",
    });
    this.headLine = new TextRenderable(r, { id: "head-1", content: "" });
    this.laneLine = new TextRenderable(r, {
      id: "head-2",
      content: "",
      fg: DIM,
    });
    head.add(this.headLine);
    head.add(this.laneLine);
    frame.add(head);

    this.matrixBox = new BoxRenderable(r, {
      id: "matrix",
      width: "100%",
      flexShrink: 0,
      flexDirection: "column",
    });
    frame.add(this.matrixBox);

    this.eventsBox = new BoxRenderable(r, {
      id: "events",
      width: "100%",
      flexShrink: 0,
      flexDirection: "column",
    });
    frame.add(this.eventsBox);

    this.paneBox = new BoxRenderable(r, {
      id: "pane",
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      border: true,
      title: "",
    });
    frame.add(this.paneBox);

    this.statusLine = new TextRenderable(r, {
      id: "status",
      content: "",
      fg: DIM,
    });
    frame.add(this.statusLine);
  }

  /** SIGWINCH: re-measure and repaint. Nothing depends on the previous frame's
   *  height, which is what made a resize fatal before. The emulator's columns
   *  must track the pane width or wide-char measurement drifts. */
  private relayout(): void {
    this.log?.resize(this.paneCols(), this.paneRowCount());
    this.paint();
  }

  private paneCols(): number {
    return Math.max(20, (this.renderer?.terminalWidth ?? 80) - 4);
  }

  /** Rows the pane has once the fixed regions take their share. */
  private paneRowCount(): number {
    const total = this.renderer?.terminalHeight ?? 24;
    const recipes = this.state
      ? matrixShape(this.state.order).recipes.length
      : 0;
    const chrome =
      2 + // header
      1 + // matrix column header
      recipes +
      Math.min(this.events.length, EVENT_ROWS) +
      2 + // pane border
      1; // status bar
    return Math.max(3, total - chrome);
  }

  // ── focus ────────────────────────────────────────────────────────────────

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

  /** Re-subscribe the log stream. A frame from a superseded subscription must
   *  never reach the pane — a fast focus switch can leave the previous stream
   *  yielding after focus moved on, and applying it would paint one node's
   *  bytes under another's header. */
  private openLog(id: string): void {
    this.logSub?.abort();
    this.log?.dispose();
    this.log = new LogView(this.paneCols(), this.paneRowCount());
    const controller = new AbortController();
    this.logSub = controller;
    const live = (): boolean =>
      !controller.signal.aborted && this.logSub === controller && !this.stopped;
    void (async () => {
      try {
        for await (const frame of await this.opts.openLog(
          id,
          controller.signal,
        )) {
          if (!live()) return;
          await this.log?.feed(frame);
          if (!live()) return;
          this.paint();
        }
      } catch (err) {
        if (!live()) return;
        // Surfaced in the pane itself, where the operator is already looking,
        // rather than thrown — a broken log stream must not kill the view.
        await this.log?.feed({
          kind: "append",
          text: `\n[odu] log stream error: ${(err as Error).message}\n`,
        });
        this.paint();
      }
    })();
  }

  // ── input ────────────────────────────────────────────────────────────────

  private onKey(key: ParsedKey): void {
    const name = key.name ?? "";
    const seq = key.sequence ?? "";

    if (this.searching) {
      if (name === "escape") {
        this.searching = false;
        this.query = "";
        this.log?.setQuery("");
      } else if (name === "return") {
        this.searching = false;
        this.log?.next();
      } else if (name === "backspace") {
        this.query = this.query.slice(0, -1);
        this.log?.setQuery(this.query);
      } else if (seq.length === 1 && seq >= " ") {
        this.query += seq;
        this.log?.setQuery(this.query);
      }
      this.paint();
      return;
    }

    if (name === "q" || (key.ctrl === true && (name === "c" || name === "d"))) {
      this.opts.onQuit();
      return;
    }
    if (name === "r" && this.focusedId !== undefined) {
      // `r` deliberately does not lock focus — it acts on what you are looking
      // at, and the run should keep pulling you along.
      this.opts.rerun(this.focusedId);
      this.info(`rerun requested: ${this.focusedId}`);
      return;
    }
    if (name === "f") {
      this.log?.toggleFollow();
      this.paint();
      return;
    }
    if (seq === "/") {
      this.searching = true;
      this.query = "";
      this.log?.setQuery("");
      this.paint();
      return;
    }
    if (name === "n") {
      this.log?.next();
      this.paint();
      return;
    }
    if (seq === "G") {
      this.log?.toBottom();
      this.paint();
      return;
    }
    if (seq === "g") {
      this.log?.toTop();
      this.paint();
      return;
    }
    if (name === "pageup" || name === "pagedown") {
      this.log?.scrollBy(
        (name === "pageup" ? -1 : 1) * Math.max(1, this.paneRowCount() - 1),
      );
      this.paint();
      return;
    }

    const state = this.state;
    if (state === undefined) return;
    const move = arrowToVim(name, seq);
    if (move !== undefined) {
      const next = stepFocus(state.order, this.focusedId, move);
      if (next !== undefined) {
        this.focusLocked = true; // a hand-picked node stops auto-follow
        this.focus(next);
      }
      return;
    }
    if (seq >= "1" && seq <= "9") {
      const next = state.order[Number(seq) - 1];
      if (next !== undefined) {
        this.focusLocked = true;
        this.focus(next);
      }
    }
  }

  // ── paint ────────────────────────────────────────────────────────────────

  /** The frame clock only advances while something is animating; a settled run
   *  stops ticking, so an idle `attach` costs nothing. */
  private onTick(): void {
    const s = this.state;
    if (s === undefined || this.renderer === undefined) return;
    if (summarize(s).running === 0) return;
    this.tick += 1;
    this.paint();
  }

  private paint(): void {
    if (this.stopped || this.renderer === undefined) return;
    const state = this.state;
    const header = this.header;
    if (state === undefined || header === undefined) return;

    const s = summarize(state);
    const spin = SPINNER[this.tick % SPINNER.length] ?? "⠋";
    const mark = s.done ? (s.failedOverall ? "✗" : s.clean ? "✔" : "◼") : spin;
    const now = Date.now();
    const elapsed =
      header.startedAt > 0 ? formatGoDuration(now - header.startedAt) : "";
    const commit = `${state.sha7}${state.dirty ? "+dirty" : ""}`;
    if (this.headLine !== undefined) {
      this.headLine.content = `odu ${mark} ${state.name} @ ${commit}  ${elapsed}`;
      this.headLine.fg = s.done && s.failedOverall ? COLOR.failed : FG;
    }
    if (this.laneLine !== undefined) {
      this.laneLine.content = header.lanes
        .map((l) => `${l.platform} ▸ ${l.host}`)
        .join("   ");
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
    const { recipes, platforms } = matrixShape(state.order);
    const nameW = Math.max(9, ...recipes.map((x) => recipeLabel(x).length));
    const cellW = Math.max(14, ...platforms.map((p) => p.length + 2));

    const lines: string[] = [
      `  ${"".padEnd(nameW)}  ${platforms.map((p) => p.padEnd(cellW)).join("")}`,
    ];
    const focused =
      this.focusedId !== undefined ? splitFanId(this.focusedId) : undefined;
    for (const recipe of recipes) {
      let row = `${focused?.namepath === recipe ? "›" : " "} ${recipeLabel(
        recipe,
      ).padEnd(nameW)} `;
      for (const platform of platforms) {
        const node = state.nodes[`${recipe}@${platform}`];
        const here =
          focused?.namepath === recipe && focused?.platform === platform;
        if (node === undefined) {
          row += ` °${"".padEnd(cellW - 2)}`;
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
        row += `${here ? "▸" : " "}${glyph} ${time.padEnd(Math.max(0, cellW - 3))}`;
      }
      lines.push(row);
    }

    // Renderables are reused across repaints; only the shape change costs.
    this.syncRows(box, this.matrixRows, lines.length, "mx", (row, i) => {
      row.content = lines[i] ?? "";
      row.fg = i === 0 ? DIM : FG;
    });
  }

  private paintEvents(): void {
    const box = this.eventsBox;
    if (box === undefined) return;
    this.syncRows(box, this.eventRows, this.events.length, "ev", (row, i) => {
      const ev = this.events[i];
      row.content = ev?.text ?? "";
      row.fg = ev?.color ?? DIM;
    });
  }

  private paintPane(state: PipelineState): void {
    const box = this.paneBox;
    if (box === undefined) return;
    const id = this.focusedId;
    const node = id !== undefined ? state.nodes[id] : undefined;
    const pos = this.log?.position();
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
    const anchor = pos?.follow === false ? "‹pinned›" : "‹follow›";
    box.title = `${id ?? ""}${meta === "" ? "" : ` — ${meta}`}  ${anchor}`;

    const height = this.paneRowCount();
    const rows = this.log?.rows() ?? [];
    this.syncRows(box, this.paneRows, height, "pane", (row, i) => {
      const line = rows[i];
      row.content = line?.text ?? "";
      row.fg = line?.match === true ? ACCENT : FG;
    });
  }

  private paintStatus(s: ReturnType<typeof summarize>): void {
    const line = this.statusLine;
    if (line === undefined) return;
    if (this.searching) {
      const n = this.log?.position().matches ?? 0;
      line.content = ` /${this.query}▏   ${n} match${n === 1 ? "" : "es"}   ⏎ next · esc cancel`;
      line.fg = ACCENT;
      return;
    }
    const counts = [
      s.ok > 0 ? `${s.ok} ok` : null,
      s.running > 0 ? `${s.running} running` : null,
      s.pending > 0 ? `${s.pending} pending` : null,
      s.failed > 0 ? `${s.failed} failed` : null,
      s.errored > 0 ? `${s.errored} errored` : null,
    ]
      .filter((c): c is string => c !== null)
      .join(" · ");
    line.content = this.opts.interactive
      ? ` ${counts}    hjkl move · r rerun · f follow · / search · q quit`
      : ` ${counts}`;
    line.fg = DIM;
  }

  /** Grow/shrink a region's rows to `count`, then fill them. Reusing the
   *  renderables is what keeps a spinner tick from rebuilding the frame. */
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
      if (extra !== undefined) {
        box.remove(extra);
        extra.destroy();
      }
    }
    for (let i = 0; i < count; i++) {
      let row = rows[i];
      if (row === undefined) {
        row = new TextRenderable(r, { id: `${prefix}-${i}`, content: "" });
        rows.push(row);
        box.add(row);
      }
      fill(row, i);
    }
  }
}

/** Arrow keys are new; normalizing them here means `stepFocus` keeps its exact
 *  existing contract (and its existing tests) instead of learning key names. */
function arrowToVim(
  name: string,
  seq: string,
): "h" | "j" | "k" | "l" | undefined {
  if (seq === "h" || seq === "j" || seq === "k" || seq === "l") return seq;
  if (name === "left") return "h";
  if (name === "down") return "j";
  if (name === "up") return "k";
  if (name === "right") return "l";
  return undefined;
}
