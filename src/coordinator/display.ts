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
 * Keys (digits / n / p / r / q) drive focus, rerun, and quit through injected
 * callbacks. When non-interactive (a piped `attach`, or a `run` whose stdin
 * isn't a TTY) the keys + raw mode are simply off.
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
  /** A chunk of some node's log arrived. A no-op for the live face now that
   *  its log pane is `openLog`-fed; kept on the interface for the json/plain
   *  faces (which ignore it) and the coordinator's append-site call. */
  logLine(id: string, text: string): void;
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
  /** The interrupt path: `q`/Ctrl-C/Ctrl-D quit with the current verdict's
   *  exit code. `run` routes this to its `shutdown`, `attach` to its `quit`. */
  onQuit: (code: number) => void;
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

// ── json ────────────────────────────────────────────────────────────────────

class JsonDisplay implements Display {
  start(): void {}
  update(): void {}
  transition(event: ProgressEvent): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
  logLine(): void {}
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

  logLine(): void {}

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

const KEY_HINT = "[digits] focus · [n/p] cycle · [r] rerun · [q] quit";

class LiveDisplay implements Display {
  private header: RunHeader | undefined;
  private state: PipelineState | undefined;
  private focusedId: string | undefined;
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
    if (this.opts.interactive && process.stdin.isTTY) {
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
        if (this.opts.interactive && process.stdin.isTTY) {
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

  /** The first state with nodes seeds the focus (the first running node, else
   *  the first pending, else the last) — the pane's `r` target. Run feeds an
   *  `update` right after `start`; attach may `start` on an already-settled
   *  snapshot and never `update`, so both call this. */
  private seedFocus(state: PipelineState): void {
    if (this.focusedId !== undefined) return;
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

  /** No-op: the focused log pane is `openLog`-fed (pull), not push-fed
   *  per-chunk. Kept to satisfy `Display` (the coordinator's append site still
   *  calls it). */
  logLine(): void {}

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
    if (this.opts.interactive && process.stdin.isTTY) {
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
    void (async () => {
      try {
        for await (const frame of await this.opts.openLog(
          id,
          controller.signal,
        )) {
          this.focusedLog = applyLogFrame(this.focusedLog, frame);
          this.paint();
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        this.focusedLog += `\n[odu] log stream error: ${
          (err as Error).message
        }\n`;
        this.paint();
      }
    })();
    this.paint();
  }

  /** The current verdict's exit code — 1 if the latest state has settled red,
   *  else 0. The interrupt path (`q`/Ctrl-C/Ctrl-D) quits with this. */
  private currentExitCode(): number {
    return this.state !== undefined && summarize(this.state).failedOverall
      ? 1
      : 0;
  }

  private onKey(key: string): void {
    if (key === "q" || key === "\x03" || key === "\x04") {
      this.opts.onQuit(this.currentExitCode());
      return;
    }
    if (key === "r" && this.focusedId !== undefined) {
      this.opts.rerun(this.focusedId);
      return;
    }
    const state = this.state;
    if (state === undefined) return;
    if (key === "n" || key === "p") {
      const idx =
        this.focusedId !== undefined ? state.order.indexOf(this.focusedId) : -1;
      const delta = key === "n" ? 1 : -1;
      const next =
        state.order[(idx + delta + state.order.length) % state.order.length];
      if (next !== undefined) this.focus(next);
      return;
    }
    if (key >= "1" && key <= "9") {
      const next = state.order[Number(key) - 1];
      if (next !== undefined) this.focus(next);
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
    const body =
      `${frame}\n${renderLogPane(focusedNode, this.focusedLog)}` +
      (this.opts.interactive ? `\n\n${dim(KEY_HINT)}` : "");
    let out = "";
    if (this.prevHeight > 0) out += `\x1b[${this.prevHeight}F\x1b[0J`;
    out += `${body}\n`;
    process.stdout.write(out);
    this.prevHeight = body.split("\n").length;
  }
}
