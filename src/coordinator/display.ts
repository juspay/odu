/**
 * `odu run`'s face — three renderings of the same fan-in state, picked by
 * where stdout points:
 *
 *   - `json`  (`--progress json`): one NDJSON line per node transition — the
 *     machine contract `/do` consumes; byte-stable, never styled.
 *   - `plain` (stdout is a pipe/file): one line per transition with glyph +
 *     duration, plus a 60-second heartbeat naming the still-running nodes so
 *     a captured log never *looks* hung between transitions.
 *   - `live`  (stdout is a TTY): an in-place recipes × lanes matrix with
 *     spinners, ticking elapsed times, and the focused node's log pane below
 *     it. Terminal failures also print a persistent line above the matrix so
 *     they survive in scrollback.
 *
 * The `live` face is the ONE interactive view, shared by `odu run` and `odu
 * attach` through a source-agnostic seam: state is push-fed (`update(state)`
 * — `run`'s coordinator loop and `attach`'s read-loop both call it) and the
 * focused-node log is pull-fed via an injected `openLog(id, signal)` (`run`
 * passes its in-memory tail, `attach` passes the surface's `nodeLog` stream).
 * Keys (digits / h / j / k / l / r / q) drive focus, rerun, and quit through
 * injected callbacks. When non-interactive (a piped `attach`, or a `run` whose
 * stdin isn't a TTY) the keys + raw mode are simply off.
 *
 * The live renderer owns the terminal: it hides the cursor, repaints a
 * bounded region, and (when `hookStderr`, i.e. `run`) interposes
 * `process.stderr.write` so library chatter (surface-nix-host's `[host:…]`
 * provisioning lines — already duplicated into `_ci-setup`'s log) can't shred
 * the region; anything else written to stderr is re-printed intact above the
 * matrix.
 */

import {
  bold,
  dim,
  green,
  link,
  magenta,
  red,
  spinnerAt,
  stripAnsi,
  yellow,
} from "../cli/ansi";
import {
  applyLogFrame,
  defaultAttachId,
  renderLogPane,
  STATUS_COLOR,
  summarize,
} from "../cli/render";
import { formatGoDuration } from "../common/duration";
import { splitFanId } from "../common/nodeId";
import {
  type NodeLogFrame,
  type NodeState,
  type PipelineState,
  type ProgressStatus,
  type RunHeader,
  STATUS_META,
} from "../common/surface";
import { logPathFor } from "./statuses";

export type DisplayMode = "json" | "plain" | "live";

export interface ProgressEvent {
  node: string;
  recipe: string;
  platform: string;
  status: ProgressStatus;
  exit_code?: number;
  log: string;
}

/** `3cbac86` for a clean run, `3cbac86+dirty` when the working tree has
 *  uncommitted changes — every face shows which code the verdict is about.
 *  Commit identity lives on `PipelineState`, so the label is fed from state. */
export function commitLabel(
  state: Pick<PipelineState, "sha7" | "dirty">,
): string {
  return state.dirty ? `${state.sha7}+dirty` : state.sha7;
}

export interface Display {
  /** Commit identity comes from `state`; the run-env (lanes, hosts source,
   *  commit link, start clock) from `header`. */
  start(state: PipelineState, header: RunHeader): void;
  /** Latest fan-in state — live repaints from it, plain heartbeats off it. */
  update(state: PipelineState): void;
  /** A node crossed a status boundary (the diff-driven event feed). */
  transition(event: ProgressEvent, node: NodeState): void;
  /** Operator-facing message (post failures, signals, …). */
  info(msg: string): void;
  /** Stop timers, restore the terminal, paint the final frame. */
  stop(state?: PipelineState): void;
}

/** The injected dependencies that make the `live` face the shared interactive
 *  view — the source-agnostic seam between `run` (its in-memory tail, raw
 *  stderr to hook, its own shutdown) and `attach` (the surface stream, no
 *  stderr to hook). Push-fed for state (via `Display.update`), pull-fed for the
 *  focused log (via `openLog`). */
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

export function createDisplay(mode: DisplayMode, live?: LiveOpts): Display {
  if (mode === "json") return new JsonDisplay();
  if (mode === "plain") return new PlainDisplay();
  if (live === undefined) {
    throw new Error("odu: createDisplay('live') requires LiveOpts");
  }
  return new LiveDisplay(live);
}

/** Project a node's state into the `ProgressEvent` the json/plain faces emit.
 *  `run` (its own run `sha7`) and `attach` (the surface's `sha7`) both build
 *  events through this one function, so the two faces emit a single
 *  byte-identical `--progress json` / plain contract instead of each
 *  hand-rolling the projection and drifting (the bug in juspay/odu#4).
 *  `null` for a status that emits nothing (`pending`, whose `progress` mapping
 *  is `null`) — the caller skips it. */
export function progressEvent(
  sha7: string,
  id: string,
  node: NodeState,
): ProgressEvent | null {
  const status = STATUS_META[node.status].progress;
  if (status === null) return null;
  const { namepath, platform } = splitFanId(id);
  return {
    node: id,
    recipe: namepath,
    platform,
    status,
    ...(node.exitCode !== null ? { exit_code: node.exitCode } : {}),
    log: logPathFor(sha7, id),
  };
}

/** Short display name for a fan-in node id: `ci::e2e@x86_64-linux` → `e2e`
 *  (the matrix's columns carry the platform; `ci::` is the one module prefix
 *  every kolu pipeline shares, so it's noise in a narrow cell). */
function recipeLabel(namepath: string): string {
  return namepath.startsWith("ci::") ? namepath.slice(4) : namepath;
}

function glyphFor(status: NodeState["status"], tick: number): string {
  const raw =
    status === "running" ? spinnerAt(tick) : STATUS_META[status].glyph;
  return STATUS_COLOR[status](raw);
}

/** Move the interactive focus one cell across the recipe × platform matrix:
 *  `h`/`l` step between platform columns on the current recipe row, `j`/`k`
 *  between recipe rows in the current platform column. `order` is the live node
 *  list, which doubles as the existence check — each axis wraps, and missing
 *  cells (a recipe that doesn't run on a platform — the `°` gaps) are skipped,
 *  so focus only ever lands on a real node. With no focus yet, lands on the
 *  first node. Returns undefined when no other cell exists along that axis.
 *
 *  The matrix's rows/columns are derived from `order` exactly as the renderer
 *  derives them, so a step tracks precisely what's on screen. */
export function stepFocus(
  order: readonly string[],
  focusedId: string | undefined,
  key: "h" | "j" | "k" | "l",
): string | undefined {
  if (focusedId === undefined) return order[0];
  // Index every node by its (recipe, platform) cell — the same `recipe@platform`
  // key the renderer uses — mapping back to the *original* id, so a step returns
  // the real id rather than re-synthesizing one (a lane-local id without `@`
  // would rebuild into a different string and never match). Rows and columns
  // fall out of the same pass, in first-seen order, exactly as the renderer
  // derives them.
  const cells = new Map<string, string>();
  const platforms: string[] = [];
  const recipes: string[] = [];
  for (const id of order) {
    const { namepath, platform } = splitFanId(id);
    cells.set(`${namepath}@${platform}`, id);
    if (!platforms.includes(platform)) platforms.push(platform);
    if (!recipes.includes(namepath)) recipes.push(namepath);
  }
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
      ? cells.get(`${namepath}@${at}`)
      : cells.get(`${at}@${platform}`);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

// ── json ────────────────────────────────────────────────────────────────────

class JsonDisplay implements Display {
  start(): void {}
  update(): void {}
  transition(event: ProgressEvent): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
  info(msg: string): void {
    process.stderr.write(`${msg}\n`);
  }
  stop(): void {}
}

// ── plain ───────────────────────────────────────────────────────────────────

const HEARTBEAT_MS = 60_000;

class PlainDisplay implements Display {
  private state: PipelineState | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastWrite = Date.now();

  start(state: PipelineState, header: RunHeader): void {
    // Commit identity (pipeline name + sha) comes from state; `run` carries
    // lanes + a hosts source on the header, so the banner shows both; an
    // observer (`attach`) has neither, so those clauses drop out and the
    // banner is just `odu · <pipeline> @ <sha>`.
    const parts = [`odu · ${state.name} @ ${commitLabel(state)}`];
    if (header.lanes.length > 0) {
      parts.push(
        header.lanes.map((l) => `${l.platform}=${l.host}`).join(" · "),
      );
    }
    const banner = parts.join(" · ");
    this.say(
      header.hostsSource !== null
        ? `${banner} (hosts: ${header.hostsSource})`
        : banner,
    );
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.timer.unref?.();
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

  /** Between transitions a captured log goes silent for however long the
   *  slowest node takes (darwin e2e: ~30 min) — name the laggards once a
   *  minute so the log reads as alive. */
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

// ── live ────────────────────────────────────────────────────────────────────

const TICK_MS = 120;

/** Pure frame renderer — exported for tests (ANSI auto-disables off-TTY). */
export function renderRunFrame(opts: {
  state: PipelineState;
  header: RunHeader;
  tick: number;
  startedAt: number;
  now: number;
  columns: number;
  /** The interactive focus — marks the specific matrix cell (recipe ×
   *  platform) whose log the pane below is showing and which `r` reruns, so the
   *  same recipe on two platforms stays distinguishable. Undefined before the
   *  first focus lands. */
  focusedId?: string;
}): string {
  const { state, header, tick, now } = opts;
  const focused =
    opts.focusedId !== undefined ? splitFanId(opts.focusedId) : undefined;
  const platforms = [
    ...new Set(state.order.map((id) => splitFanId(id).platform)),
  ];
  const recipes: string[] = [];
  for (const id of state.order) {
    const { namepath } = splitFanId(id);
    if (!recipes.includes(namepath)) recipes.push(namepath);
  }

  const summary = summarize(state);
  const headGlyph = summary.done
    ? summary.failedOverall
      ? red("✗")
      : green("✔")
    : yellow(spinnerAt(tick));
  const shaText =
    header.commitUrl !== null
      ? link(commitLabel(state), header.commitUrl)
      : commitLabel(state);
  const sha = state.dirty ? yellow(`@ ${shaText}`) : dim(`@ ${shaText}`);
  const lines: string[] = [
    `${bold("odu")} ${headGlyph} ${state.name} ${sha} ${dim(
      formatGoDuration(now - opts.startedAt),
    )}`,
    dim(
      `  ${header.lanes.map((l) => `${l.platform} = ${l.host}`).join(" · ")}`,
    ),
    "",
  ];

  const nameWidth = Math.max(9, ...recipes.map((r) => recipeLabel(r).length));
  const cellWidth = Math.max(14, ...platforms.map((p) => p.length + 2));
  lines.push(
    dim(
      `  ${"".padEnd(nameWidth)}  ${platforms
        .map((p) => p.padEnd(cellWidth))
        .join("")}`,
    ),
  );
  for (const recipe of recipes) {
    const cells = platforms.map((platform) => {
      const node = state.nodes[`${recipe}@${platform}`];
      // Focus lands on one specific cell (recipe × platform), not a whole row —
      // a `›` on the cell so the same recipe on two platforms is
      // distinguishable and `r`'s target is unambiguous.
      const cellMark =
        focused?.namepath === recipe && focused?.platform === platform
          ? "›"
          : " ";
      if (node === undefined) return `${cellMark}${"".padEnd(cellWidth)}`;
      const glyph = glyphFor(node.status, tick);
      const time =
        node.status === "running"
          ? formatGoDuration(now - (node.startedAt ?? now))
          : node.durationMs !== null
            ? formatGoDuration(node.durationMs)
            : "";
      const plain = `${STATUS_META[node.status].glyph} ${time}`;
      return `${cellMark}${glyph} ${dim(time)}${"".padEnd(Math.max(0, cellWidth - plain.length))}`;
    });
    const marker = focused?.namepath === recipe ? "›" : " ";
    lines.push(
      `${marker} ${recipeLabel(recipe).padEnd(nameWidth)} ${cells.join("")}`,
    );
  }

  lines.push("");
  const counts = [
    summary.ok > 0 ? green(`${summary.ok} ok`) : null,
    summary.running > 0 ? yellow(`${summary.running} running`) : null,
    summary.pending > 0 ? dim(`${summary.pending} pending`) : null,
    summary.failed > 0 ? red(`${summary.failed} failed`) : null,
    summary.errored > 0 ? magenta(`${summary.errored} errored`) : null,
    summary.skipped > 0 ? dim(`${summary.skipped} skipped`) : null,
  ].filter((s): s is string => s !== null);
  lines.push(`  ${counts.join(dim(" · "))}`);

  return lines.join("\n");
}

const KEY_HINT = "[digits] focus · [hjkl] move · [r] rerun · [q] quit";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point.
const CSI_TOKEN = /^\x1b\[[0-9;]*[A-Za-z]/;
// An OSC token: `\x1b]…(ST|BEL)`. The OSC 8 hyperlink is `\x1b]8;;<uri>\x1b\\`
// (or BEL-terminated); a `<uri>`-less one (`\x1b]8;;\x1b\\`) *closes* the link.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching OSC escapes is the point.
const OSC_TOKEN = /^\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)/;
const OSC8_CLOSE = "\x1b]8;;\x1b\\";

/** The *visible* width of a styled line: glyph columns only, with CSI and OSC
 *  escapes (incl. an OSC 8 hyperlink's long URL) uncounted. `stripAnsi` only
 *  drops CSI, so it would wrongly count a hyperlink's URL bytes against the
 *  budget — a header whose visible text fits but whose commit URL is long would
 *  read as over-budget and get truncated. */
function visibleWidth(line: string): number {
  let visible = 0;
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const esc = CSI_TOKEN.exec(rest) ?? OSC_TOKEN.exec(rest);
    if (esc !== null) {
      i += esc[0].length;
      continue;
    }
    visible += 1;
    i += 1;
  }
  return visible;
}

/** Truncate a styled line to `width` *visible* columns, leaving CSI/OSC escapes
 *  uncounted, so the embedded log pane's wide command/log lines can't wrap. A
 *  line already within budget passes through byte-for-byte (so the OSC 8 commit
 *  link in the header survives intact); a truncated one gets a trailing reset so
 *  cut-off styling can't bleed into the next row, and — since an SGR reset does
 *  NOT close an OSC 8 hyperlink — an OSC 8 close first if truncation lands while
 *  a link is still open, so the link can't stay active across following rows.
 *  The repaint counts one terminal row per clamped line, exact once nothing
 *  wraps. */
export function clampLine(line: string, width: number): string {
  if (width <= 0 || visibleWidth(line) <= width) return line;
  let out = "";
  let visible = 0;
  let i = 0;
  let linkOpen = false;
  while (i < line.length && visible < width) {
    const rest = line.slice(i);
    const csi = CSI_TOKEN.exec(rest);
    if (csi !== null) {
      out += csi[0];
      i += csi[0].length;
      continue;
    }
    const osc = OSC_TOKEN.exec(rest);
    if (osc !== null) {
      out += osc[0];
      i += osc[0].length;
      // `]8;;<uri>` opens a hyperlink; the `<uri>`-less `]8;;` closes it.
      const body = osc[1] ?? "";
      if (body.startsWith("8;;")) linkOpen = body !== "8;;";
      continue;
    }
    out += line[i];
    visible += 1;
    i += 1;
  }
  return `${out}${linkOpen ? OSC8_CLOSE : ""}\x1b[0m`;
}

class LiveDisplay implements Display {
  private header: RunHeader | undefined;
  private state: PipelineState | undefined;
  private focusedId: string | undefined;
  /** Until the operator picks a node by hand (hjkl/digits), focus auto-follows
   *  the run: it re-tracks the best default node (first running, else first
   *  pending, else last) on every state update, so a `run` that `start`s with
   *  everything pending advances off `_ci-setup` onto the active node instead of
   *  staying pinned to the startup snapshot. A keypress locks it. */
  private focusLocked = false;
  private focusedLog = "";
  private logSub: AbortController | undefined;
  private tick = 0;
  private prevHeight = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly stderrWrite = process.stderr.write.bind(process.stderr);
  private stopped = false;
  private readonly keyHandler = (key: string): void => this.onKey(key);

  constructor(private readonly opts: LiveOpts) {}

  start(state: PipelineState, header: RunHeader): void {
    this.state = state;
    this.header = header;
    process.stdout.write("\x1b[?25l");
    if (this.opts.hookStderr) this.hookStderr();
    if (this.opts.interactive) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", this.keyHandler);
    }
    // Whatever path the process dies by (a throw past orchestrate, a missed
    // stop()), the terminal must come back: cursor shown, raw mode off, stderr
    // unhooked.
    process.once("exit", () => {
      if (!this.stopped) {
        if (this.opts.hookStderr) process.stderr.write = this.stderrWrite;
        if (this.opts.interactive) {
          process.stdin.setRawMode(false);
        }
        process.stdout.write("\x1b[?25h");
      }
    });
    this.seedFocus(state);
    this.timer = setInterval(() => {
      this.tick += 1;
      this.paint();
    }, TICK_MS);
    this.timer.unref?.();
  }

  update(state: PipelineState): void {
    this.state = state;
    this.seedFocus(state);
  }

  /** Auto-follow the best default node (first running, else first pending, else
   *  last) until the operator pins focus with a key. `run` `start`s on an
   *  all-pending snapshot then `update`s as lanes go live, so re-tracking here
   *  walks focus off `_ci-setup` onto the running node; `attach` may `start` on
   *  an already-settled snapshot and never `update`, so both call this. Once
   *  `focusLocked`, the operator's choice stands. */
  private seedFocus(state: PipelineState): void {
    if (this.focusLocked) return;
    const id = defaultAttachId(state);
    if (id !== undefined) this.focus(id);
  }

  transition(event: ProgressEvent, node: NodeState): void {
    // Reds persist in scrollback; greens live in the matrix.
    if (node.status !== "failed" && node.status !== "errored") return;
    const color = node.status === "failed" ? red : magenta;
    const dur =
      node.durationMs !== null ? ` (${formatGoDuration(node.durationMs)})` : "";
    this.printAbove(
      color(
        `${STATUS_META[node.status].glyph} ${event.node} ${node.status}${dur}`,
      ) + dim(`  → ${event.log}`),
    );
  }

  info(msg: string): void {
    this.printAbove(msg);
  }

  stop(state?: PipelineState): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.logSub?.abort();
    if (state !== undefined) this.state = state;
    this.paint();
    if (this.opts.hookStderr) process.stderr.write = this.stderrWrite;
    if (this.opts.interactive) {
      process.stdin.off("data", this.keyHandler);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    process.stdout.write("\x1b[?25h");
    this.prevHeight = 0;
  }

  /** Move focus to `id`, abort the previous log subscription, and pull the new
   *  node's log via the injected `openLog` (a `snapshot` frame then `append`s,
   *  so a focus change backfills the buffer). */
  private focus(id: string): void {
    if (id === this.focusedId) return;
    this.focusedId = id;
    this.focusedLog = "";
    this.logSub?.abort();
    const controller = new AbortController();
    this.logSub = controller;
    // A frame from this subscription is only the focused log's if this is still
    // the live subscription: a fast focus switch (or `stop()`) can leave the
    // previous `openLog` resolving or yielding a queued frame after focus has
    // moved on (notably `attach`'s socket stream, which can lag the abort), and
    // applying it would paint A's bytes under B's header. Drop anything from a
    // superseded/stopped subscription before it touches `focusedLog` or paints.
    const live = (): boolean =>
      !controller.signal.aborted && this.logSub === controller && !this.stopped;
    void (async () => {
      try {
        for await (const frame of await this.opts.openLog(
          id,
          controller.signal,
        )) {
          if (!live()) return;
          this.focusedLog = applyLogFrame(this.focusedLog, frame);
          this.paint();
        }
      } catch (err) {
        if (!live()) return;
        this.focusedLog += `\n[odu] log stream error: ${
          (err as Error).message
        }\n`;
        this.paint();
      }
    })();
    this.paint();
  }

  private onKey(key: string): void {
    if (key === "q" || key === "\x03" || key === "\x04") {
      this.opts.onQuit();
      return;
    }
    if (key === "r" && this.focusedId !== undefined) {
      this.opts.rerun(this.focusedId);
      return;
    }
    const state = this.state;
    if (state === undefined) return;
    if (key === "h" || key === "j" || key === "k" || key === "l") {
      const next = stepFocus(state.order, this.focusedId, key);
      if (next !== undefined) {
        this.focusLocked = true; // a hand-picked node stops auto-follow
        this.focus(next);
      }
      return;
    }
    if (key >= "1" && key <= "9") {
      const next = state.order[Number(key) - 1];
      if (next !== undefined) {
        this.focusLocked = true; // a hand-picked node stops auto-follow
        this.focus(next);
      }
    }
  }

  /** Library chatter must not shred the repaint region: `[host:…]` lines
   *  (surface-nix-host provisioning — already mirrored into `_ci-setup`'s
   *  log file) are dropped; everything else re-prints above the matrix. */
  private hookStderr(): void {
    const handler: typeof process.stderr.write = (
      chunk: Uint8Array | string,
      encodingOrCb?: unknown,
      maybeCb?: unknown,
    ): boolean => {
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf-8");
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        if (line.startsWith("[host:")) continue;
        this.printAbove(dim(stripAnsi(line)));
      }
      const cb = [encodingOrCb, maybeCb].find(
        (a): a is () => void => typeof a === "function",
      );
      cb?.();
      return true;
    };
    process.stderr.write = handler;
  }

  /** Print a persistent line above the live region: erase the region, emit
   *  the line into normal scrollback, repaint below it. */
  private printAbove(line: string): void {
    let out = "";
    if (this.prevHeight > 0) out += `\x1b[${this.prevHeight}F\x1b[0J`;
    this.prevHeight = 0;
    out += `${line}\n`;
    process.stdout.write(out);
    this.paint();
  }

  private paint(): void {
    if (this.header === undefined || this.state === undefined) return;
    const frame = renderRunFrame({
      state: this.state,
      header: this.header,
      tick: this.tick,
      startedAt: this.header.startedAt,
      now: Date.now(),
      columns: process.stdout.columns ?? 100,
      focusedId: this.focusedId,
    });
    const focusedNode =
      this.focusedId !== undefined
        ? this.state.nodes[this.focusedId]
        : undefined;
    const raw =
      `${frame}\n${renderLogPane(focusedNode, this.focusedLog)}` +
      (this.opts.interactive ? `\n\n${dim(KEY_HINT)}` : "");
    // The bounded repaint moves up exactly `prevHeight` rows, so every painted
    // line must occupy exactly one terminal row: clamp each (the embedded log
    // pane carries arbitrarily wide command/log lines that would otherwise wrap
    // and leave the cursor-up undercounting, smearing stale output below).
    const columns = process.stdout.columns ?? 100;
    const lines = raw.split("\n").map((l) => clampLine(l, columns));
    let out = "";
    if (this.prevHeight > 0) out += `\x1b[${this.prevHeight}F\x1b[0J`;
    out += `${lines.join("\n")}\n`;
    process.stdout.write(out);
    this.prevHeight = lines.length;
  }
}
