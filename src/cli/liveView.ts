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
 * spinner rather than a frame, and the frame clock stops outright once the run
 * settles — it is re-armed by the next state or log frame that needs one.
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
import {
  type NodeLogFrame,
  type NodeState,
  type PipelineState,
  postingOf,
  type RunHeader,
  STATUS_META,
} from "../common/surface";
import type { Stream } from "effect";
import { subscribe } from "../common/effectEdge";
import { postingWarning } from "../coordinator/statuses";
import { formatGoDuration } from "../common/duration";
import { splitFanId } from "../common/nodeId";
import {
  commitLabel,
  cellAt,
  countsLine,
  countsParts,
  operatorLine,
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
import { stripAnsi } from "./ansi";
import { LogView } from "./logView";

/** Repaint cadence while something is animating (a spinner, a ticking elapsed
 *  time). The old renderer ran a 120ms interval forever, including long after
 *  the run settled; here the clock idles when nothing moves. */
const TICK_MS = 100;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const DIM = "#6b7a80";
const FG = "#c6d2d3";
const ACCENT = "#3ad3b8";
/** The frame's own ground, for text that sits on an accent fill. */
const INK = "#0b1013";
/** The scrollbar's unfilled track — present enough to read as a bar, quiet
 *  enough not to compete with the log beside it. */
const TRACK = "#2a343a";

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
   *  focus change backfills. `run` passes `tail.streamSource` (its in-memory
   *  tail), `attach` passes a call to `client.surface.nodeLog.get` (over the
   *  socket) — and under Effect both are the SAME shape, a lazy `Stream`
   *  returned synchronously. The old `| Promise` half of this union existed
   *  only to reconcile a generator with a promised async-iterable; there is
   *  nothing left to reconcile, and no `AbortSignal` to thread: the view
   *  cancels by closing its subscription (see `subscribe`). */
  openLog: (id: string) => Stream.Stream<NodeLogFrame, unknown>;
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
  /** The node this event is about, when it is about one. Carried rather than
   *  parsed back out of `text`: the lane is the place an operator looks when
   *  something goes red, so clicking an entry jumps to that node's log. */
  nodeId?: string;
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
   *  sibling's slot. The status bar reads this list. `docs.md`'s key table is
   *  hand-maintained prose and can drift — nothing generates or checks it. */
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
  // Home/End are what the hint names, because they are what someone reaches
  // for when the wheel is not getting them to the end of a long log; `g`/`G`
  // keep working for the hands that already know them.
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

/** The quit hint is reserved rather than queued: it is the one binding whose
 *  absence strands the operator, and the bar is the only place it is written
 *  down. */
const QUIT_HINT = BINDINGS.find((b) => b.keys.includes("q"))?.hint ?? "q quit";

/** As many key hints as `room` columns allow, in `BINDINGS` order, always
 *  ending with quit. The bar cannot simply print them all: a `TextRenderable`
 *  that overflows *wraps*, which would push the frame past the last terminal
 *  row — and hand-trimming the list is how the hint came to omit four of the
 *  bindings it describes. */
function keyHints(room: number): string[] {
  const chosen: string[] = [];
  for (const hint of HINTS) {
    if (hint === QUIT_HINT) continue;
    if ([...chosen, hint, QUIT_HINT].join(" · ").length > room) break;
    chosen.push(hint);
  }
  return [...chosen, QUIT_HINT];
}

/** How many events stay on screen. The lane is a tail, not a log — the full
 *  history is in the run's log files, and the frame must not grow. */
const EVENT_ROWS = 2;

/** Rows of log the stacked layout will not go below. The matrix is sized to its
 *  content and the pane took whatever survived, which on a 25-recipe run left
 *  the pane exactly one row — a log pane that cannot show a log. The matrix
 *  yields first now, and says how many recipes it is holding back. */
const LOG_FLOOR = 8;

/** Columns the log needs before the matrix may sit beside it rather than above
 *  it. Paired with the matrix's own measured width, so the rule reads "side by
 *  side only when BOTH regions get a workable size" — a fixed terminal-width
 *  threshold would put the matrix next to a 20-column pane on a wide terminal
 *  whose recipe names happen to be long. */
const MIN_PANE_COLS = 44;

/** opentui runs its own mouse text-selection: a drag paints a highlight across
 *  every cell it crosses, and that highlight is what stayed behind on the
 *  gutter after dragging the scrollbar. This view owns every drag it receives
 *  — the scrollbar thumb, the matrix — and never reads `getSelectedText`, so
 *  the highlight is residue with nothing behind it. Nothing here selects. */
function inert<T extends { selectable: boolean }>(r: T): T {
  r.selectable = false;
  return r;
}

/** The pane's title, composed to fit the width the pane actually got.
 *
 *  opentui draws a border title only when it fits ENTIRELY — an over-long one
 *  is dropped, not truncated. Beside the matrix the pane is narrower than the
 *  terminal, which silently cost the frame the one place the focused node is
 *  named. So the parts are shed in order of what an operator can do without:
 *  the timing first, then the head of the id — never the id's tail, which is
 *  what tells two cells of the same recipe apart, and never the anchor, which
 *  is the only sign that new output has stopped arriving. */
function paneTitle(
  id: string,
  meta: string,
  anchor: string,
  width: number,
): string {
  // Two corners, the dash each side of the title, and a space each side.
  const room = Math.max(0, width - 6);
  const full = `${id}${meta === "" ? "" : ` — ${meta}`}  ${anchor}`;
  if (full.length <= room) return full;
  const bare = `${id}  ${anchor}`;
  if (bare.length <= room) return bare;
  const forId = room - anchor.length - 2;
  if (forId >= 4) return `…${id.slice(id.length - forId + 1)}  ${anchor}`;
  return id.slice(Math.max(0, id.length - room));
}

/** A row's cells, as coloured spans. `row.fg` paints a whole renderable one
 *  colour, which is why the matrix used to render monochrome — the status
 *  glyphs live inside a string, so their hue has to travel with them. */
type Row = readonly TextChunk[];

/** Set a row's spans only when they actually changed.
 *
 *  `TextRenderable`'s own guard compares the incoming `StyledText` by
 *  REFERENCE, and building one allocates a fresh object every time — so the
 *  guard never fires and each assignment re-parses and re-measures the row.
 *  Measured at 23.5us per no-op assignment against 0.01us guarded; across ~38
 *  rows that is a 14x difference on a steady-state frame. The cache key is the
 *  spans' text plus colour, which is what a reader sees change. */
const LAST_TEXT = new WeakMap<TextRenderable, string>();
function setRow(row: TextRenderable, chunks: Row): void {
  const key = chunks.map((c) => `${c.fg ?? ""}\u0000${c.text}`).join("\u0001");
  if (LAST_TEXT.get(row) === key) return;
  LAST_TEXT.set(row, key);
  row.content = new StyledText([...chunks]);
}

/** A plain span in the frame's ordinary foreground. */
const plain = (text: string): TextChunk => fg(FG)(text);
/** A span the eye should skip — labels, separators, elapsed times. */
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

  /** Run the hint under a click at column `x` on the status bar.
   *
   *  A hint that reads `r rerun` should rerun when clicked — the bar already
   *  states what each key does, so requiring the keyboard to act on it is an
   *  arbitrary restriction. Dispatch goes through the same `BINDINGS` entry the
   *  key does, so the two can never mean different things. */
  private pressHintAt(x: number): void {
    const hit = this.hintHits.find((h) => x >= h.from && x < h.to);
    if (hit === undefined) return;
    // The binding's own key id — the multi-key entries (hjkl, digits) act on
    // their first, which is the one the hint names.
    const key = hit.binding.keys[0];
    if (key !== undefined) hit.binding.act(this, key);
  }

  /** Focus the cell under a click.
   *
   *  Both axes matter: the row picks the recipe, the column picks the platform.
   *  Resolving only the row (and keeping whatever platform was already focused)
   *  meant a click anywhere on a row landed on the first lane — clicking the
   *  second host's cell silently focused the first host's node.
   *
   *  A click left of the columns keeps the current platform, which is what the
   *  recipe-name area should do. A click on a gap cell (`°`) is ignored rather
   *  than snapped to a neighbour — guessing which node was meant is worse than
   *  doing nothing. */
  private focusAtCell(x: number, y: number): void {
    const state = this.state;
    const box = this.matrixBox;
    const geom = this.matrixGeom;
    if (state === undefined || box === undefined || geom === undefined) return;
    const row = y - box.y - 1; // -1 for the platform header row
    // A click below the last drawn recipe is on the "N more" line, which names
    // no recipe: resolving it against the unwindowed list would focus whatever
    // happened to be scrolled out of view directly beneath it.
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
    // A gap: this recipe does not run on the platform that was clicked.
    if (target === undefined) return;
    this.focusLocked = true; // a hand-picked node stops auto-follow, as with hjkl
    this.focus(target.id);
  }

  /** One-slot memo: `state.order` is fixed for the life of a run, and
   *  `matrixShape` is O(N·(R+P)) with an `includes` in its inner loop. */
  private shapeMemo:
    | { order: readonly string[]; shape: ReturnType<typeof matrixShape> }
    | undefined;
  private tick = 0;
  /** A repaint is owed. Set instead of painting inline: log frames arrive once
   *  per child-process stdout chunk, so a chatty node drove a full-frame
   *  reprojection per chunk (~1000 paints where ~24 would reach the screen —
   *  opentui renders at 30fps and everything above that is JS the terminal
   *  never sees). The tick flushes it. */
  private dirty = false;
  /** A resize landed since the last frame — the next one relayouts first. */
  private resized = false;
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
  /** Matrix and pane's container; its `flexDirection` IS the layout. */
  private bodyBox: BoxRenderable | undefined;
  /** Matrix + events lane, the region that sits beside the pane when wide. */
  private sideBox: BoxRenderable | undefined;
  /** Last applied orientation and side width, so a paint that changes neither
   *  does not invalidate yoga's layout. `undefined` until the first paint. */
  private wide: boolean | undefined;
  private sideWidth: number | "auto" | undefined;
  /** First recipe row the matrix is showing. Non-zero only when the matrix is
   *  taller than the room it has. */
  private matrixTop = 0;
  private matrixBox: BoxRenderable | undefined;
  private eventsBox: BoxRenderable | undefined;
  private paneBox: BoxRenderable | undefined;
  private paneRowsBox: BoxRenderable | undefined;
  private paneScrollBox: BoxRenderable | undefined;
  private scrollRows: TextRenderable[] = [];
  /** The scrollbar's drawn geometry, recorded by the paint that lays it out —
   *  the inverse of the thumb math, so a grab maps back to a buffer line
   *  without a second copy of the rule. `undefined` while everything fits. */
  private scrollGeom: { height: number; thumb: number; at: number } | undefined;
  /** Where in the thumb the drag was grabbed, so it moves WITH the pointer
   *  rather than snapping its top to the cursor on every event. */
  private grabOffset = 0;
  private statusLine: TextRenderable | undefined;
  /** Where each hint was drawn on the status bar, so a click can run it. Built
   *  during the paint that draws them — the bar is width-dependent, so the
   *  spans are only knowable at the moment they are laid out. */
  private hintHits: { from: number; to: number; binding: Binding }[] = [];
  /** Where the matrix drew its columns, so a click can resolve which CELL was
   *  hit — not just which row. Recorded during the paint that lays them out. */
  private matrixGeom:
    | {
        gutter: number;
        cellW: number;
        platforms: string[];
        /** First recipe drawn, so a click resolves to the recipe under it and
         *  not to the one that would have been there unwindowed. */
        from: number;
        /** How many recipe rows were drawn, so a click on the "N more" line
         *  below them resolves to nothing instead of to a hidden recipe. */
        shown: number;
      }
    | undefined;
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
    this.wake();
  }

  /** A revised run environment for a run already started — the resolved
   *  lane→host map replacing the one published while the venue claim was still
   *  in flight (juspay/odu#84). The lane line repaints from `this.header` on
   *  every frame, so this is a field write plus a wake. */
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
    // Coalesced, not painted per event: a window drag fires resize many times
    // a second and each relayout reflows the VT buffer. Same treatment the log
    // path gets, for the same reason.
    renderer.on("resize", () => {
      this.resized = true;
      this.dirty = true;
      this.wake();
    });
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
    this.wake();
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
      true,
      false,
      node.id,
    );
  }

  /** Operator-facing message. Called from the venue lease and the status
   *  poster; pre-mount it must reach real stdout.
   *
   *  COALESCED (`now: false`). Since juspay/odu#84 the renderer is mounted
   *  before the claim, so provisioning narration — one call per `copying path`
   *  line, thousands of them — arrives here with a frame to repaint. Painting
   *  each is the per-source-event repaint {@link pushEvent} documents; the
   *  dirty flag plus `wake()`'s tick shows every line, batched at TICK_MS. */
  info(msg: string): void {
    this.pushEvent(msg, DIM, false);
  }

  /** Cap on retained diagnostics — enough to carry a fatal message and its
   *  context out of the alternate screen, bounded so a chatty run cannot grow
   *  it without limit. */
  private static readonly RETAIN_MAX = 32;

  /** @param now paint immediately. True for the rare, discrete events a host
   *  raises (a transition, an operator message); false for interposed stderr,
   *  where a provisioning burst is one call per line and painting each would
   *  reintroduce the per-source-event repaint the log path just stopped doing.
   *  @param retain replay this on teardown. Only for text no other face will
   *  reprint: library stderr and operator messages. A transition is already in
   *  the host's own summary, so retaining it printed every failure twice. */
  private pushEvent(
    text: string,
    color: string,
    now = true,
    retain = true,
    nodeId?: string,
  ): void {
    if (this.renderer === undefined) {
      // Pre-mount (or post-stop): no frame to hold this, so it belongs in the
      // scrollback the operator is actually looking at.
      process.stdout.write(`${operatorLine(text)}\n`);
      return;
    }
    this.events.push({ text, color, nodeId });
    if (this.events.length > EVENT_ROWS) this.events.shift();
    // Drop from the TAIL, not the head: a burst is almost always a stack
    // trace, whose first line carries the message and whose remainder is
    // frames. Shifting oldest-first kept the frames and discarded the reason.
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
    this.sleep();
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

  // ── layout ───────────────────────────────────────────────────────────────

  /** Build the region tree once. Heights are constraints — the log pane's
   *  `flexGrow: 1` is the whole of what used to be a hardcoded twelve rows. */
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

    // Variable-height strip for state-derived warnings, so a new one is a line
    // in `notices()` rather than another hand-counted row.
    this.noticeBox = inert(
      new BoxRenderable(r, {
        id: "notices",
        width: "100%",
        flexShrink: 0,
        flexDirection: "column",
      }),
    );
    frame.add(this.noticeBox);

    // The matrix and the log are siblings whose container's DIRECTION is the
    // layout. Stacked, the log is the remainder of a column and the matrix has
    // to be capped so the remainder is worth having. Side by side, the log is
    // a full-height region in its own right and the matrix costs it nothing
    // but width. One tree, two orientations — `applyOrientation` is the whole
    // of the difference.
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
        // Clicking a matrix row focuses that node — the mouse equivalent of
        // hjkl, and the only way to reach a node without counting rows. The
        // handler sits on the box, not on each row, so it survives `syncRows`
        // rebuilding the rows underneath it.
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
        // The wheel scrolls the log, which is what a reader reaches for first.
        // Scrolling unpins the tail (see `LogView.scrollBy`) so new output
        // stops yanking the view away mid-read; `f`, `G` or End re-pins it.
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

    // Rows and scrollbar are siblings in a row-direction split rather than the
    // bar being padded onto the end of each line: padding would have to measure
    // the visible width of text that can contain wide glyphs, and would be
    // clipped by the same `wrapMode: "none"` that keeps rows one row tall.
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
        // Press inside the thumb to grab it; press on the track to jump there.
        onMouseDown: (e) => this.grabScrollbar(e.y),
        onMouseDrag: (e) => this.dragScrollbar(e.y),
      }),
    );
    split.add(this.paneScrollBox);

    // Full width, below the body: an event names a node AND the log file it
    // wrote, which does not survive being squeezed into the matrix's column.
    // Sitting just above the status bar also groups it with the other
    // run-level chrome instead of interrupting the matrix.
    this.eventsBox = inert(
      new BoxRenderable(r, {
        id: "events",
        width: "100%",
        flexShrink: 0,
        flexDirection: "column",
        // The lane is where you look when a node goes red; clicking the entry
        // is the obvious way to read that node's log.
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
        // The hints name the actions, so they should BE the actions.
        onMouseDown: (e) => this.pressHintAt(e.x),
      }),
    );
    frame.add(this.statusLine);
  }

  /** Which way the frame runs, and how wide the matrix column is when it runs
   *  across. The test is about BOTH regions: the matrix's own measured width
   *  plus a log column worth reading. Called from the paint, because the
   *  matrix's width depends on the recipe names in the run and is not knowable
   *  when the tree is built. */
  private applyOrientation(sideW: number): boolean {
    const body = this.bodyBox;
    const side = this.sideBox;
    const r = this.renderer;
    if (body === undefined || side === undefined || r === undefined)
      return false;
    const wide = r.terminalWidth >= sideW + MIN_PANE_COLS;
    // Assigning either property invalidates yoga's layout, so both are guarded
    // — this runs on every frame and most frames change neither.
    if (wide !== this.wide) {
      body.flexDirection = wide ? "row" : "column";
      this.wide = wide;
    }
    // "auto" stretches to the body's width when stacked; a number pins the
    // column when side by side.
    const want: number | "auto" = wide ? sideW : "auto";
    if (want !== this.sideWidth) {
      side.width = want;
      this.sideWidth = want;
    }
    return wide;
  }

  /** Recipe rows the matrix may paint, excluding its platform header.
   *
   *  Derived from the terminal rather than from measured boxes: this decides
   *  how many rows to paint, and the measurement that would answer it does not
   *  exist until after they are painted. Everything it counts is either fixed
   *  (the two header lines, the status bar, the pane's border) or already
   *  computed for this frame. */
  private matrixCap(wide: boolean): number {
    const r = this.renderer;
    if (r === undefined) return Number.MAX_SAFE_INTEGER;
    const body = r.terminalHeight - 2 - this.notices().length - 1;
    // Stacked, the pane's floor plus its border comes out of the matrix's
    // share. Side by side the pane costs the matrix no height at all.
    const forPane = wide ? 0 : LOG_FLOOR + 2;
    return Math.max(1, body - forPane - this.events.length - 1);
  }

  /** Keep the focused recipe inside the window, moving it only when focus
   *  leaves it. A window that re-centred on every repaint would slide the
   *  matrix under a pointer that had not moved. */
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
  /** The emulator's column count: the width of the ROWS column, which is the
   *  bordered pane minus its border and minus the scrollbar gutter. Measuring
   *  the laid-out box rather than deriving it from the terminal width is what
   *  keeps the emulator's wrap point and the drawn width the same number. */
  private paneCols(): number {
    const measured = this.paneRowsBox?.width ?? 0;
    if (measured > 0) return Math.max(20, measured);
    const outer = this.paneBox?.width ?? (this.renderer?.terminalWidth ?? 80);
    return Math.max(20, outer - 3); // 2 border + 1 gutter
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
        for await (const frame of subscribe(
          this.opts.openLog(id),
          controller.signal,
        )) {
          if (!live()) return;
          // Which frame kind means "start over" is odu's stream protocol, so
          // the switch stays on this side of the boundary — `LogView` takes
          // bytes.
          if (frame.kind === "snapshot") this.log?.reset();
          await this.log?.write(frame.text);
          if (!live()) return;
          this.dirty = true;
          this.wake();
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

    // Checked before the search prompt consumes the key: raw mode means no
    // SIGINT and the renderer is configured not to exit on its own, so an
    // operator who opens `/` and hits Ctrl-C would otherwise be stuck on the
    // alternate screen with no way out but guessing `esc`.
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

  /** Advance the spinner and flush any owed repaint. When neither is needed
   *  the clock is STOPPED, not merely idled: a bare 10Hz wakeup that walks
   *  `state.order` to decide it has nothing to do is worse than the 120ms
   *  interval this view replaced. `wake()` re-arms it. */
  /** Arm the frame clock if it is not already running. */
  private wake(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.timer = setInterval(() => this.onTick(), TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Stop it. Nothing is animating and nothing is owed, so a wakeup would only
   *  re-derive that fact. */
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
    // Cleared only once the frame is actually buildable: clearing above the
    // guards let an early return swallow a log repaint that then never landed.
    this.dirty = false;

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
    // The sha carries the commit URL as a chunk `link`, not as an embedded
    // OSC 8 escape: opentui's cell buffer has no escape parser, so the escape
    // was painted as literal text — the URL's 40-char sha appeared in the
    // header and pushed it onto a second row.
    const label = commitLabel(state);
    if (this.headLine !== undefined) {
      const markHue =
        outcome === "pending" ? STATUS_CELL.running : OUTCOME_CELL[outcome];
      // opentui carries the URL as a chunk property, so a terminal that
      // supports hyperlinks makes the sha clickable and one that does not shows
      // the bare label — no escape ever reaches the cell buffer as text.
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
      // ONE loop over the roster, so the styled face lists a partly-claimed
      // run's platforms in the run's own order — two loops grouped them by
      // internal representation instead, which is an ordering no other face
      // used. A lane still being claimed has no host to name, so it shows the
      // pool it is claiming from rather than going blank for the whole
      // provisioning window.
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
    // Floors, not guesses: 9 keeps the recipe column readable when every name
    // is short, and 14 is the widest a cell needs for glyph + `1h02m03s`.
    const nameW = Math.max(
      9,
      ...recipes.map((x: string) => recipeLabel(x).length),
    );
    const cellW = Math.max(14, ...platforms.map((x: string) => x.length + 2));

    // The matrix's width is knowable only here, and it decides the layout: it
    // is what the pane has to fit beside.
    const wide = this.applyOrientation(nameW + 3 + cellW * platforms.length);

    const focused =
      this.focusedId !== undefined ? splitFanId(this.focusedId) : undefined;
    // Window the recipes when there are more than there is room for, keeping
    // the last row for a count of what is held back. An unwindowed matrix on a
    // 25-recipe run is what left the log pane one row tall.
    const cap = this.matrixCap(wide);
    const windowed = recipes.length > cap;
    const shown = windowed ? Math.max(1, cap - 1) : recipes.length;
    const focusIdx = recipes.findIndex(
      (x: string) => x === focused?.namepath,
    );
    const from = windowed ? this.matrixWindowTop(recipes.length, shown, focusIdx) : 0;

    // A body row is: marker(1) + " "(1) + name(nameW) + " "(1), then cellW per
    // platform. That prefix is where the columns start.
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
          // `°` marks a cell with no node — a recipe that does not run on this
          // platform. Insets keep the gap and a live cell the same width.
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
        // A running clock is the one number that keeps changing, so it stays
        // legible; a settled duration recedes.
        cells.push(
          node.status === "running"
            ? fg(STATUS_CELL.running)(time.padEnd(Math.max(0, cellW - 3)))
            : faint(time.padEnd(Math.max(0, cellW - 3))),
        );
      }
      rows.push(cells);
    }

    // Say what is being held back, rather than simply ending early — a matrix
    // that silently stops at the terminal's edge reads as a shorter pipeline.
    if (windowed) {
      const hidden = recipes.length - shown;
      rows.push([
        faint(`  ⋯ ${hidden} more`),
        faint(from > 0 ? "  ↑ hjkl scrolls the matrix" : "  ↓ hjkl scrolls the matrix"),
      ]);
    }

    // Renderables are reused across repaints; only the shape change costs.
    this.syncRows(box, this.matrixRows, rows.length, "mx", (row, i) => {
      setRow(row, rows[i] ?? []);
    });
  }

  /** One-slot memo: `state.order` is fixed for the life of a run, and
   *  `matrixShape` is O(N·(R+P)) with an `includes` in its inner loop. */
  private shapeOf(order: readonly string[]): ReturnType<typeof matrixShape> {
    const memo = this.shapeMemo;
    if (memo !== undefined && memo.order === order) return memo.shape;
    const shape = matrixShape(order);
    this.shapeMemo = { order, shape };
    return shape;
  }

  /** The posting-debt strip and any future state-derived warning. It was in
   *  the frame the old renderer painted (juspay/odu#61) and has to stay in this
   *  one: it is how an operator learns a status never made it to GitHub. */
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

    // Size the emulator to exactly the number of rows about to be drawn,
    // before reading them. The height changes whenever an event or a notice
    // appears, not only on SIGWINCH, and an emulator left at a stale height
    // hands back a short window whose missing rows paint as blanks.
    const height = this.paneRowCount();
    this.log?.resize(this.paneCols(), height);
    const rows = this.log?.rows() ?? [];
    const rowsBox = this.paneRowsBox ?? box;
    this.paintScrollbar(height);
    this.syncRows(rowsBox, this.paneRows, height, "pane", (row, i) => {
      const line = rows[i];
      // A search hit is inverted rather than recoloured: log text already
      // carries meaning in its own words, so a hue would compete with it.
      if (line === undefined) {
        setRow(row, []);
        return;
      }
      // A search hit is inverted rather than recoloured: the producer's own
      // colours are already carrying meaning in this row, and a hue would
      // compete with them.
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

  /** The log's scroll position, as a one-column thumb beside the rows.
   *
   *  A pane that scrolls with no indication of where you are in the buffer is
   *  the terminal equivalent of an unlabelled slider: `f`/`G` tell you the
   *  anchor but nothing tells you how much log there is or how far down you
   *  are. The gutter is blank when everything fits — a scrollbar that is always
   *  full is noise. */
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
    // At least one row, so the thumb never vanishes on a very long log.
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

  /** Focus the node an events-lane entry is about. Entries that name no node
   *  (an operator message, library chatter) are inert rather than focusing
   *  something arbitrary. */
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

  /** Gutter row -> the window start that would draw the thumb there. The exact
   *  inverse of `paintScrollbar`'s placement, so grabbing the thumb and reading
   *  it agree. */
  private scrollbarRowToLine(row: number): number | undefined {
    const geom = this.scrollGeom;
    const log = this.log;
    if (geom === undefined || log === undefined) return undefined;
    const travel = geom.height - geom.thumb;
    if (travel <= 0) return 0;
    const at = Math.max(0, Math.min(travel, row));
    return (at / travel) * log.maxWindowTop;
  }

  /** A press in the gutter. Inside the thumb it starts a drag from where it was
   *  grabbed; on the track it jumps so the thumb's top lands under the pointer,
   *  which is what a click on empty track is asking for. */
  private grabScrollbar(y: number): void {
    const box = this.paneScrollBox;
    const geom = this.scrollGeom;
    if (box === undefined || geom === undefined) return;
    const row = y - box.y;
    // Straight from the geometry the paint recorded — reading the thumb back
    // out of the drawn glyphs would be a second source of truth for where it is.
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
    // Each bucket in its own status hue — the counts row is the one place the
    // whole run's shape is visible at a glance, and colour is what makes it
    // readable without counting words.
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
    // Column of the first hint = everything already pushed.
    let column = chunks.reduce((n, c) => n + c.text.length, 0);
    this.hintHits = [];
    // The key itself in the accent, its verb faint: the operator is scanning
    // for the letter, not reading a sentence.
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
      // destroy() unparents itself. Calling remove() first left the child with
      // a stale parent pointer, so the renderer's own recursive teardown later
      // asked a box to remove a child it no longer had — which threw out of
      // every single stop(), swallowed into console.error by opentui.
      extra?.destroy();
    }
    for (let i = 0; i < count; i++) {
      let row = rows[i];
      if (row === undefined) {
        // `inert` matters most here: a mouse press hit-tests to the ROW under
        // the pointer, not to the box holding it, so these are the renderables
        // opentui would otherwise start a text selection on.
        row = inert(
          new TextRenderable(r, {
            id: `${prefix}-${i}`,
            content: "",
            // Rows wrap by default, and a wrapped row makes its strip taller —
            // stealing height from the log pane. Event text is arbitrary
            // interposed stderr, so this is reachable in an ordinary run.
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
