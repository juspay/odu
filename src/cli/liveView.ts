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
  CliRenderer,
  type ParsedKey,
  TextRenderable,
} from "@opentui/core";
import {
  type NodeLogFrame,
  type NodeState,
  type PipelineState,
  postingOf,
  type RunHeader,
  STATUS_META,
} from "../common/surface";
import { postingWarning } from "../coordinator/statuses";
import { formatGoDuration } from "../common/duration";
import { splitFanId } from "../common/nodeId";
import {
  commitLabel,
  countsLine,
  defaultAttachId,
  matrixShape,
  OUTCOME_CELL,
  OUTCOME_MARK,
  outcomeOf,
  recipeLabel,
  STATUS_CELL,
  stepFocus,
  summarize,
} from "./render";
import { dim, link, stripAnsi } from "./ansi";
import { LogView } from "./logView";

/** Repaint cadence while something is animating (a spinner, a ticking elapsed
 *  time). The old renderer ran a 120ms interval forever, including long after
 *  the run settled; here the clock idles when nothing moves. */
const TICK_MS = 100;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const DIM = "#6b7a80";
const FG = "#c6d2d3";
const ACCENT = "#3ad3b8";

/** The injected dependencies that make the `live` face the shared interactive
 *  view — the source-agnostic seam between `run` (its in-memory tail, raw
 *  stderr to hook, its own shutdown) and `attach` (the surface stream, no
 *  stderr to hook). Push-fed for state (via `Display.update`), pull-fed for the
 *  focused log (via `openLog`).
 *
 *  Declared here, beside the view that consumes it, and re-exported from
 *  `coordinator/display.ts` for its hosts: transcribing the same five members
 *  into two interfaces meant a member added to one type-checked against the
 *  other by structural luck and never reached the view. */
export interface LiveOpts {
  /** Read keys + drive focus/rerun/quit; raw-mode the terminal. Off for a
   *  `run` whose stdin isn't a TTY (output-only live matrix). */
  interactive: boolean;
  /** Interpose `process.stderr.write` (drop `[host:…]`, re-print the rest
   *  above the matrix). `run`=true (library chatter shares its stderr);
   *  `attach`=false (an observer has no such chatter to tame). */
  hookStderr: boolean;
  /** Pull the focused node's log: a `snapshot` frame then `append`s, so a
   *  focus change backfills. `run` passes `tail.streamSource` (a synchronous
   *  generator), `attach` passes `client.surface.nodeLog.get` (a promised
   *  stream over the socket) — hence the `| Promise`, `await`ed at the call
   *  site, which is a no-op for the generator. */
  openLog: (
    id: string,
    signal: AbortSignal,
  ) => AsyncIterable<NodeLogFrame> | Promise<AsyncIterable<NodeLogFrame>>;
  /** The one mutation `r` triggers — re-run the focused node. */
  rerun: (id: string) => void;
  /** The interrupt path: `q`/Ctrl-C/Ctrl-D request a quit. The view doesn't
   *  own verdict-on-quit policy — each consumer decides its own exit code (`run`
   *  always 130 for an interrupt; `attach` the current verdict). */
  onQuit: () => void;
}

export interface LiveViewOpts extends LiveOpts {
  /** Test seam: supply the renderer instead of opening a real terminal. Only
   *  `liveView.test.ts` passes this (opentui's `createTestRenderer`), so the
   *  frame can be asserted as text without a pty. */
  createRenderer?: () => Promise<CliRenderer>;
}

interface Event {
  text: string;
  color: string;
}

/** One name for a key. Printable keys are identified by their sequence (so `g`
 *  and `G` stay distinct); named keys by `name`. Dispatch compares against this
 *  and nothing else — reading `name` for some bindings and `sequence` for
 *  others gave `G`/`g` a shift distinction while `R`, `Q` and `F` silently
 *  behaved as their lowercase selves. */
function keyId(key: ParsedKey): string {
  const seq = key.sequence ?? "";
  if (seq.length === 1 && seq >= " ") return seq;
  return key.name ?? "";
}

/** Arrow keys and vim keys are the same axis; `stepFocus` keeps its existing
 *  contract (and its existing tests) instead of learning key names. */
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
  /** The `keyId`s that trigger this. */
  keys: readonly string[];
  /** What the status bar calls it, `null` for a binding already covered by a
   *  sibling's slot. Both this and `website/src/content/docs.md`'s table are
   *  readings of this one list, not parallel prose. */
  hint: string | null;
  act: (v: LiveView, id: string) => void;
}

/** The keymap — the one statement of what each key does. It was three: a
 *  60-line `if` chain, the status-bar hint (which had already fallen four
 *  bindings behind the chain), and the docs table. */
const BINDINGS: readonly Binding[] = [
  {
    keys: Object.keys(MOVES),
    hint: "hjkl move",
    // The lookup cannot miss (the keys ARE `MOVES`'s); the guard only
    // satisfies noUncheckedIndexedAccess.
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
  { keys: ["g"], hint: "g/G top/tail", act: (v) => v.withLog((l) => l.toTop()) },
  { keys: ["G"], hint: null, act: (v) => v.withLog((l) => l.toBottom()) },
  { keys: ["pageup"], hint: "PgUp/PgDn scroll", act: (v) => v.page(-1) },
  { keys: ["pagedown"], hint: null, act: (v) => v.page(1) },
  { keys: ["q"], hint: "q quit", act: (v) => v.quit() },
];

const HINTS = BINDINGS.map((b) => b.hint).filter(
  (h): h is string => h !== null,
);

/** The quit hint is reserved rather than queued: it is the one binding whose
 *  absence strands the operator, and the bar is the only place it is written
 *  down. */
const QUIT_HINT = BINDINGS.find((b) => b.keys.includes("q"))?.hint ?? "q quit";

/** As many key hints as `room` columns allow, in `BINDINGS` order, always
 *  ending with quit. The bar cannot simply print them all: a `TextRenderable`
 *  that overflows *wraps*, which would push the frame past the last terminal
 *  row — and hand-trimming the list is how the hint came to omit four of the
 *  bindings it describes. */
function keyHint(room: number): string {
  const chosen: string[] = [];
  for (const hint of HINTS) {
    if (hint === QUIT_HINT) continue;
    if ([...chosen, hint, QUIT_HINT].join(" · ").length > room) break;
    chosen.push(hint);
  }
  return [...chosen, QUIT_HINT].join(" · ");
}

/** How many events stay on screen. The lane is a tail, not a log — the full
 *  history is in the run's log files, and the frame must not grow. */
const EVENT_ROWS = 2;

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

  private tick = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  /** `finishStop()` has run. Distinct from `stopped`, which only records that
   *  `stop()` was *called*. */
  private torndown = false;

  private readonly stderrWrite = process.stderr.write.bind(process.stderr);
  /** Diagnostics retained for replay on teardown. NOT `events`: that is a
   *  two-row display ring, so anything older than the last two lines has
   *  already been shifted out — which made the replay unable to surface the
   *  fatal message it exists for. */
  private retained: string[] = [];
  private hooked = false;

  private headLine: TextRenderable | undefined;
  private laneLine: TextRenderable | undefined;
  private noticeBox: BoxRenderable | undefined;
  private noticeRowsR: TextRenderable[] = [];
  private matrixBox: BoxRenderable | undefined;
  private eventsBox: BoxRenderable | undefined;
  private paneBox: BoxRenderable | undefined;
  private statusLine: TextRenderable | undefined;
  private matrixRows: TextRenderable[] = [];
  private eventRows: TextRenderable[] = [];
  private paneRows: TextRenderable[] = [];

  /** Whatever path the process dies by (a throw past orchestrate, a missed
   *  stop()), the terminal must come back. Guarded on `torndown`, NOT on
   *  `stopped`: a stop() that landed before the mount has not restored anything
   *  yet, and guarding on `stopped` would disarm this net exactly when it is
   *  the only thing left to fire. */
  private readonly onProcessExit = (): void => {
    if (this.torndown) return;
    this.unhook();
    // Restore first: on a crash during the pre-assign mount window there is no
    // renderer to destroy, and this hook is the only thing left to run.
    this.renderer?.destroy();
  };

  constructor(private readonly opts: LiveViewOpts) {}

  /** Synchronous by contract (`Display.start`). Records state, hooks the
   *  streams, and kicks the async mount off without awaiting it.
   *
   *  The mount promise is retained: `stop()` can land in the SAME synchronous
   *  turn as `start()` (an `attach` onto an already-settled run does exactly
   *  that), and by then `createCliRenderer` has already entered the alternate
   *  screen and raw mode even though `this.renderer` is not assigned yet. Only
   *  by settling that promise can the teardown reach the renderer at all. */
  start(state: PipelineState, header: RunHeader): void {
    this.state = state;
    this.header = header;
    // Armed here rather than in the constructor, and removed in `finishStop`:
    // a per-instance listener that was never removed leaked one per
    // `createDisplay("live")` and accumulated across the test suite.
    process.once("exit", this.onProcessExit);
    this.seedFocus(state);
    if (this.opts.hookStderr) this.hook();
    void this.mount().catch((err: unknown) => {
      // A renderer that cannot open must degrade to a silent non-live run, not
      // take the process with it: an unhandled rejection would pick odu's exit
      // code, and odu owns that. Report on the REAL stderr — the hook is torn
      // down first, or the diagnostic would come back through pushEvent onto
      // stdout, dimmed and line-shredded.
      this.unhook();
      this.stderrWrite(
        `odu: live view unavailable (${(err as Error).message}) — continuing without it\n`,
      );
    });
    this.timer = setInterval(() => this.onTick(), TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Open the terminal.
   *
   *  Deliberately NOT `createCliRenderer`: that helper is `new CliRenderer(…)`
   *  followed by `await setupTerminal()`, and only the second step touches the
   *  terminal (raw mode, alternate screen, mouse). Bundled, they leave a window
   *  where the screen has been switched but the renderer this class would need
   *  to switch it back has not been assigned — and a host that exits in the same
   *  turn (`attach`: `stop()` then `process.exit()`) never gets it.
   *
   *  Split, the reference exists before any escape reaches the wire, so
   *  `destroy()` is reachable on every teardown path and there is no need to
   *  hand-copy opentui's escape list to undo it — a copy that was already
   *  missing three modes it sets (modifyOtherKeys, grapheme clustering, theme
   *  reporting), which would have left a shell delivering `CSI 27;…u` for
   *  modified keys. */
  private async mount(): Promise<void> {
    if (this.stopped) return;
    const renderer =
      this.opts.createRenderer !== undefined
        ? await this.opts.createRenderer()
        : this.openTerminal();
    // Assigned before `setupTerminal()` — that is the whole point of the split.
    this.renderer = renderer;
    if (this.opts.createRenderer === undefined) {
      try {
        await renderer.setupTerminal();
      } catch (err) {
        // What `createCliRenderer` does on failure: some constructor side
        // effects do not roll back on their own.
        renderer.destroy();
        this.renderer = undefined;
        throw err;
      }
    }
    if (this.stopped) {
      // stop() ran while the terminal was being set up. It already called
      // finishStop(), which destroyed whatever was assigned — nothing to build.
      renderer.destroy();
      return;
    }
    this.build();
    if (this.opts.interactive) {
      renderer.keyInput.on("keypress", (key: ParsedKey) => this.onKey(key));
    }
    renderer.on("resize", () => this.relayout());
    // Focus (and therefore the log emulator) was seeded against the pre-mount
    // fallback, because the pane box had not been laid out yet. Push the real
    // geometry now — unconditionally: the emulator always exists by here, so a
    // `log === undefined` guard would never fire and the pane would keep the
    // fallback width for the whole run.
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
      },
    );
  }

  /** `run` `start`s on an all-pending snapshot and `update`s as lanes go live,
   *  so focus must be re-derived from the latest state — not snapshot-ed at
   *  `start()`. Without this the pane pinned to `_ci-setup` for the whole run
   *  (and `r` reran it) while the operator watched something else. `seedFocus`
   *  is a no-op once a keypress has locked focus. */
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
    // STATUS_META.isRed is the single source of redness — spelling the pair
    // out here means a new red status silently skips the events lane.
    if (!STATUS_META[node.status].isRed) return;
    const dur =
      node.durationMs !== null ? ` (${formatGoDuration(node.durationMs)})` : "";
    this.pushEvent(
      `${STATUS_META[node.status].glyph} ${node.id} ${node.status}${dur}  → ${logPath}`,
      STATUS_CELL[node.status],
    );
  }

  /** Operator-facing message. Called from the venue lease and the status
   *  poster long before `start()`, so pre-mount it must reach real stdout. */
  info(msg: string): void {
    this.pushEvent(msg, DIM);
  }

  /** Cap on retained diagnostics — enough to carry a fatal message and its
   *  context out of the alternate screen, bounded so a chatty run cannot grow
   *  it without limit. */
  private static readonly RETAIN_MAX = 32;

  private pushEvent(text: string, color: string): void {
    if (this.renderer === undefined) {
      // Pre-mount (or post-stop): no frame to hold this, so it belongs in the
      // scrollback the operator is actually looking at.
      process.stdout.write(`${dim(stripAnsi(text))}\n`);
      return;
    }
    this.events.push({ text, color });
    if (this.events.length > EVENT_ROWS) this.events.shift();
    this.retained.push(text);
    if (this.retained.length > LiveView.RETAIN_MAX) this.retained.shift();
    this.paint();
  }

  /** Restore the terminal, and leave the scrollback to the host.
   *
   *  The view deliberately prints nothing here. `run` already ends with its own
   *  `printVerdict`, so a recap from the view is the same information twice;
   *  `attach` prints `verdictLine(state)` itself. Verdict-on-exit is
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
    // Give the terminal back SYNCHRONOUSLY, before anything that might not run.
    // The mount enters the alternate screen and raw mode before its first
    // await, so between `start()` and the mount resolving there is a window in
    // which the screen is switched but `this.renderer` is unassigned. Deferring
    // the restore to the mount's continuation loses that race outright when the
    // host exits in the same turn — `attach`'s quit path is
    // `stop()` then `process.exit()`, and `process.exit` abandons pending
    // microtasks, so the continuation never runs and the operator is left on
    // the alternate screen in raw mode.
    this.finishStop();
  }

  /** The rest of the teardown. Idempotent — reachable from `stop()`, from the
   *  mount's continuation when `stop()` beat it, and from the exit hook. */
  private finishStop(): void {
    if (this.torndown) return;
    this.torndown = true;
    process.off("exit", this.onProcessExit);
    this.unhook();
    this.renderer?.destroy();
    this.renderer = undefined;
    // A diagnostic that arrived through the stderr hook dies with the alternate
    // screen, so replay what was retained. Only when the run did NOT end
    // cleanly: on a green run this is provisioning chatter the operator already
    // watched scroll past, and the host is about to print its own verdict.
    const clean = this.state !== undefined && summarize(this.state).clean;
    if (!clean) for (const line of this.retained) this.stderrWrite(`${line}\n`);
    this.retained = [];
    this.events = [];
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
      wrapMode: "none",
    });
    head.add(this.headLine);
    head.add(this.laneLine);
    frame.add(head);

    // Variable-height strip for state-derived warnings, so a new one is a line
    // in `notices()` rather than another hand-counted row.
    this.noticeBox = new BoxRenderable(r, {
      id: "notices",
      width: "100%",
      flexShrink: 0,
      flexDirection: "column",
    });
    frame.add(this.noticeBox);

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
      wrapMode: "none",
    });
    frame.add(this.statusLine);
  }

  /** SIGWINCH: repaint. Nothing depends on the previous frame's height, which
   *  is what made a resize fatal before. `paintPane` is the one site that sizes
   *  the emulator, so there is nothing else to do here — and yoga has not
   *  re-measured yet at this point, hence the deferred second pass. */
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

  /** The pane's geometry comes from yoga, not from re-counting the chrome:
   *  `paneBox` is the frame's only `flexGrow` child, so what it measures IS
   *  "whatever the fixed regions left". Re-deriving it by hand meant the
   *  emulator wrapped at a different width than opentui drew at — the ragged
   *  mid-word breaks in a live run — and any new chrome row silently shortened
   *  the log with nothing to catch it.
   *
   *  The `- 2` is the box's own border, the one inset that is this module's
   *  business. Arithmetic off the terminal size survives only as the
   *  before-first-layout fallback, replaced by `repaintAfterLayout`. */
  private paneCols(): number {
    const measured = this.paneBox?.width ?? 0;
    const outer = measured > 0 ? measured : (this.renderer?.terminalWidth ?? 80);
    return Math.max(20, outer - 2);
  }

  /** Rows the pane has.
   *
   *  `Math.max(0, …)`, not `max(3, …)`: on a terminal shorter than the chrome a
   *  three-row floor pushes the pane's own border and the status bar off the
   *  bottom, so the operator loses the key hints on exactly the small window
   *  where they are hardest to remember. Zero rows of log is the honest answer. */
  private paneRowCount(): number {
    const measured = this.paneBox?.height ?? 0;
    if (measured > 0) return Math.max(0, measured - 2);
    return Math.max(0, (this.renderer?.terminalHeight ?? 24) - 12);
  }

  /** State-derived warning strips above the matrix (currently just the GitHub
   *  posting debt, juspay/odu#61). Pure content — yoga sizes the strip, so a
   *  new notice kind is a line here and nothing else. */
  private notices(): string[] {
    const state = this.state;
    if (state === undefined) return [];
    const warn = postingWarning(postingOf(state));
    return warn === null ? [] : [warn];
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
    // The query rides across: `LiveView` owns the search string (it draws it),
    // and a fresh buffer that started empty left `n` doing nothing and the
    // match count reading 0 with no way to tell why.
    this.log = new LogView(this.paneCols(), this.paneRowCount(), this.query);
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
          // Which frame kind means "start over" is odu's stream protocol, so
          // the switch stays on this side of the boundary — `LogView` takes
          // bytes.
          if (frame.kind === "snapshot") this.log?.reset();
          await this.log?.write(frame.text);
          if (!live()) return;
          this.paint();
        }
      } catch (err) {
        if (!live()) return;
        // Surfaced in the pane itself, where the operator is already looking,
        // rather than thrown — a broken log stream must not kill the view.
        await this.log?.write(
          `\n[odu] log stream error: ${(err as Error).message}\n`,
        );
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

    // Ctrl-C/Ctrl-D are the one binding that isn't a plain key identity.
    if (key.ctrl === true && (name === "c" || name === "d")) {
      this.quit();
      return;
    }
    const id = keyId(key);
    const binding = BINDINGS.find((b) => b.keys.includes(id));
    if (binding === undefined) return;
    binding.act(this, id);
    this.paint();
  }

  // ── what the bindings do ─────────────────────────────────────────────────
  // Public because `BINDINGS` is module-level: one table beats a method that
  // re-states the keymap in a `switch`.

  quit(): void {
    this.opts.onQuit();
  }

  /** `r` deliberately does not lock focus — it acts on what you are looking at,
   *  and the run should keep pulling you along. */
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

  /** A hand-picked node stops auto-follow — until then focus tracks the run. */
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

  /** The search string has one owner (this view draws it); `LogView` is told,
   *  never asked. */
  private setQuery(q: string): void {
    this.query = q;
    this.log?.setQuery(q);
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
    // One outcome taxonomy for the mark AND its colour, so a settled
    // cancelled-only run cannot read as a neutral "still going" here while
    // `printVerdict` calls it INCOMPLETE (juspay/odu#68).
    const outcome = outcomeOf(s);
    const mark = outcome === "pending" ? spin : OUTCOME_MARK[outcome];
    const now = Date.now();
    const elapsed =
      header.startedAt > 0 ? formatGoDuration(now - header.startedAt) : "";
    // The sha stays an OSC 8 hyperlink where the forge gave us a commit URL —
    // the escape rides inside the cell content, so a terminal that supports it
    // makes the sha clickable and one that doesn't shows the bare label.
    const label = commitLabel(state);
    const commit =
      header.commitUrl !== null ? link(label, header.commitUrl) : label;
    if (this.headLine !== undefined) {
      this.headLine.content = `odu ${mark} ${state.name} @ ${commit}  ${elapsed}`;
      // Only the two outcomes that need the operator's attention take a hue;
      // a pass and a run still going stay in ordinary foreground.
      this.headLine.fg =
        outcome === "failed" || outcome === "incomplete"
          ? OUTCOME_CELL[outcome]
          : FG;
    }
    this.paintNotices();
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

  /** The posting-debt strip and any future state-derived warning. It was in the
   *  frame the old renderer painted (juspay/odu#61) and has to stay in this
   *  one: it is how an operator learns a status never made it to GitHub. */
  private paintNotices(): void {
    const box = this.noticeBox;
    if (box === undefined) return;
    const lines = this.notices();
    this.syncRows(box, this.noticeRowsR, lines.length, "nt", (row, i) => {
      row.content = lines[i] ?? "";
      row.fg = STATUS_CELL.running;
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
    box.title = `${id ?? ""}${meta === "" ? "" : ` — ${meta}`}  ${anchor}`;

    // Size the emulator to exactly the number of rows about to be drawn,
    // before reading them. The height changes whenever an event or a notice
    // appears, not only on SIGWINCH, and an emulator left at a stale height
    // hands back a short window whose missing rows paint as blanks.
    const height = this.paneRowCount();
    this.log?.resize(this.paneCols(), height);
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
      const n = this.log?.matches ?? 0;
      line.content = ` /${this.query}▏   ${n} match${n === 1 ? "" : "es"}   ⏎ next · esc cancel`;
      line.fg = ACCENT;
      return;
    }
    const counts = countsLine(s);
    if (!this.opts.interactive) {
      line.content = ` ${counts}`;
      line.fg = DIM;
      return;
    }
    const width = this.renderer?.terminalWidth ?? 80;
    line.content = ` ${counts}    ${keyHint(width - counts.length - 6)}`;
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
        row = new TextRenderable(r, {
          id: `${prefix}-${i}`,
          content: "",
          // Rows wrap by default, and a wrapped row makes its strip taller —
          // stealing height from the log pane. Event text is arbitrary
          // interposed stderr, so this is reachable in an ordinary run.
          wrapMode: "none",
        });
        rows.push(row);
        box.add(row);
      }
      fill(row, i);
    }
  }
}
