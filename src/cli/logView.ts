/**
 * The focused node's log, backed by a real terminal emulator instead of a
 * string buffer.
 *
 * A node's output is not text: `nix build`, `bun test` and friends redraw with
 * carriage returns and cursor motion, so concatenating the bytes and splitting
 * on `\n` turns one progress bar into several hundred junk lines and pushes the
 * useful output out of view. Feeding the same bytes to a headless VT gives the
 * semantics the producer actually intended — `\r` overwrites in place, and a
 * wide glyph occupies two cells because the emulator measured it rather than
 * because we counted code points.
 *
 * Colour is *consumed* here, not carried: `rows()` is plain text, which is why
 * escape junk never reaches the pane — and also why a node's log renders
 * monochrome. Carrying it would mean per-cell attribute runs on `LogRow` and a
 * styled-text row in the consumer; until that exists, this module does not
 * claim it.
 *
 * The viewport is a window onto that VT's buffer: `follow` pins it to the tail
 * (the default — a running node should stream), and any scroll input unpins it
 * so a failure can be read without quitting. Search is a filter over the same
 * buffer, so `/` never has to re-parse anything.
 *
 * Nothing here knows what odu is: it takes bytes and a query, which is the
 * whole of its contract with a producer.
 */

import { Terminal } from "@xterm/headless";

/** One visible row of the pane. `match` marks a search hit so the frame can
 *  highlight it without knowing what the query was. */
/** A run of same-coloured cells. `fg` is undefined for the terminal's default
 *  foreground, which the pane paints in its own. */
export interface LogSpan {
  text: string;
  fg: string | undefined;
}

export interface LogRow {
  text: string;
  match: boolean;
  /** The same text, split into colour runs — a node's own red failures and
   *  green ticks, carried out of the emulator rather than flattened. */
  spans: LogSpan[];
}

/** The emulator is sized generously in rows: its scrollback is the pane's
 *  history, and a node that logs for half an hour should still be readable
 *  from the top of its failure. */
const SCROLLBACK = 5000;

/** The 16 ANSI colours, in this view's palette rather than the terminal's, so a
 *  node's output sits in the same family as the frame around it. */
const ANSI16 = [
  "#3b4650", "#e8695b", "#6fcf8e", "#e6b24d",
  "#6a9fdc", "#bb8ce2", "#5ec8c4", "#c6d2d3",
  "#5d6d70", "#ef8578", "#8ddba6", "#f0c46e",
  "#8bb8e8", "#cda6ec", "#7fd8d4", "#e8f0f0",
] as const;

/** An xterm palette index as a hex colour: 0-15 from the table above, 16-231
 *  the 6x6x6 cube, 232-255 the greyscale ramp. */
function paletteHex(i: number): string {
  const named = ANSI16[i];
  if (named !== undefined) return named;
  if (i >= 232) {
    const v = 8 + (i - 232) * 10;
    return `#${v.toString(16).padStart(2, "0").repeat(3)}`;
  }
  const n = i - 16;
  const step = (x: number): string =>
    (x === 0 ? 0 : 55 + x * 40).toString(16).padStart(2, "0");
  return `#${step(Math.floor(n / 36))}${step(Math.floor(n / 6) % 6)}${step(n % 6)}`;
}

const hex6 = (n: number): string => `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;

export class LogView {
  private term: Terminal;
  private follow = true;
  /** Absolute buffer line index of the top visible row while unpinned. */
  private top = 0;
  /** Where `next()` last landed. Kept apart from `top` because `top` is clamped
   *  to the last full window — a hit inside the final `height` lines would
   *  otherwise clamp to the same row every time and `n` would never advance. */
  private cursor = -1;
  private query = "";
  private height: number;
  /** High-water mark of the written extent.
   *
   *  The cursor is not monotonic: a producer that redraws with cursor-up (or
   *  clears the screen) moves it backwards, and reading the extent straight off
   *  the cursor would make already-written lines vanish from the pane and from
   *  search. Only a `snapshot` frame — a deliberate "start over" — resets it. */
  private highWater = 0;
  /** Bumped on anything that can change the buffer's *contents*. The match memo
   *  keys on this rather than on `total`, because an emulator's whole point is
   *  that a `\r` redraw rewrites text without changing the line count — keying
   *  on the line count left the status bar reporting a stale match count for
   *  the rest of the search. */
  private writes = 0;
  /** Memoized match count, keyed on what it was computed from: it is read on
   *  every repaint and a full-buffer scan per frame is not free. */
  /** `Terminal.write` defers its callback, and a focus change disposes this
   *  view synchronously — so the continuation can land after disposal and
   *  touch a disposed buffer, which xterm reports by printing a stack trace to
   *  stderr. Exactly the raw-library-chatter-on-the-terminal failure this view
   *  exists to prevent. */
  private disposed = false;
  private counted:
    | { query: string; writes: number; matches: number }
    | undefined;

  /** `query` arrives from the consumer rather than being re-derived here: the
   *  live view owns the search string (it draws it), and a focus change builds
   *  a fresh `LogView` — one that started empty would silently drop the query
   *  the operator had just typed. */
  constructor(cols: number, height: number, query = "") {
    this.height = Math.max(1, height);
    this.query = query.toLowerCase();
    this.term = new Terminal({
      cols: Math.max(1, cols),
      // The VT's own rows are irrelevant to what we display — we read lines out
      // of its buffer — but they must not be smaller than the window we intend
      // to show, or the emulator wraps content we would then read back short.
      rows: Math.max(this.height, 24),
      scrollback: SCROLLBACK,
      // The bytes come from a PIPE, not a pty, so the termios `\n` -> `\r\n`
      // translation never happened. Without this xterm faithfully does what a
      // raw terminal does — move down a row and KEEP the column — so every
      // line after a progress bar started wherever the previous one ended,
      // giving the pane a staircase of indented, wrapped text.
      convertEol: true,
      allowProposedApi: true,
    });
  }

  /** Append bytes. The promise resolves once the emulator has parsed them —
   *  awaiting it is how a caller reads the *result* of this write, not a
   *  correctness requirement: `rows()` always returns whatever the buffer holds
   *  right now, which is the right answer for a live tail. */
  async write(text: string): Promise<void> {
    await new Promise<void>((resolve) => this.term.write(text, resolve));
    // The focus change that disposed this view happened while the write was in
    // flight; touching the buffer now throws out of xterm and onto the
    // terminal. Nothing downstream wants the result either.
    if (this.disposed) return;
    this.writes += 1;
    this.clampAnchor();
  }

  /** Start over — the producer said "here is the whole thing again". Which
   *  frames mean that is the producer's protocol, so the decision stays on the
   *  odu side of this boundary. */
  reset(): void {
    this.term.reset();
    this.follow = true;
    this.top = 0;
    this.cursor = -1;
    this.highWater = 0;
    this.writes += 1;
  }

  /** Re-agree the anchor with the buffer after it changed: pinned to the tail,
   *  or clamped to the last legal offset. */
  private clampAnchor(): void {
    if (this.follow) this.toBottom();
    else this.top = Math.min(this.top, this.maxTop());
  }

  /** Re-size the emulator to the pane's geometry. Rows track the pane height so
   *  a wrapped line stays wrapped the way the operator sees it, and `top` is
   *  re-clamped because a taller pane shrinks the last legal scroll offset. */
  resize(cols: number, height: number): void {
    const next = Math.max(1, height);
    const cols_ = Math.max(1, cols);
    if (next === this.height && cols_ === this.term.cols) return;
    this.height = next;
    this.term.resize(cols_, Math.max(this.height, 24));
    // A reflow re-derives the extent: wrapped lines rejoin when the pane widens,
    // so the previous mark is an overcount and would blank the pane.
    this.highWater = 0;
    // A reflow rewrites the buffer, so the memo is stale for the same reason a
    // write makes it stale.
    this.writes += 1;
    this.clampAnchor();
  }

  /** Lines actually written, scrollback included.
   *
   *  NOT `buffer.active.length`: that is scrollback plus the emulator's full
   *  row count, so a two-line log in a 24-row emulator reports 24 and the tail
   *  window lands on twenty-two blanks.
   *
   *  A high-water mark, because the cursor is not monotonic — a producer that
   *  redraws with cursor-up moves it backwards, and reading the extent straight
   *  off the cursor would make written lines vanish. It is NOT monotonic across
   *  a reflow: widening rejoins wrapped lines, so the real extent SHRINKS, and
   *  keeping the pre-reflow figure pointed the window past the end of the
   *  content and blanked the pane. `resize()` clears the mark for that reason. */
  get total(): number {
    this.highWater = Math.max(this.highWater, this.writtenExtent());
    return this.highWater;
  }

  private writtenExtent(): number {
    const b = this.term.buffer.active;
    const at = b.baseY + b.cursorY;
    const current = b.getLine(at)?.translateToString(true) ?? "";
    return at + (current === "" ? 0 : 1);
  }

  private lineAt(i: number): string {
    return this.term.buffer.active.getLine(i)?.translateToString(true) ?? "";
  }

  /** One buffer line as colour runs.
   *
   *  `translateToString` flattens the attributes away, which is why the pane
   *  used to render every node's output in one foreground. Walking the cells
   *  keeps the producer's own colours — a failing test's red, a nix path's
   *  cyan — and costs one pass over a line that is about to be drawn anyway. */
  private spansAt(i: number): LogSpan[] {
    const line = this.term.buffer.active.getLine(i);
    if (line === undefined) return [];
    const spans: LogSpan[] = [];
    let text = "";
    let colour: string | undefined;
    let started = false;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (cell === undefined) continue;
      // A wide glyph occupies two cells; the second reports width 0 and no
      // chars, and emitting it would double the column count.
      if (cell.getWidth() === 0) continue;
      const chars = cell.getChars();
      const next = cell.isFgDefault()
        ? undefined
        : cell.isFgRGB()
          ? hex6(cell.getFgColor())
          : paletteHex(cell.getFgColor());
      if (started && next !== colour) {
        spans.push({ text, fg: colour });
        text = "";
      }
      colour = next;
      started = true;
      text += chars === "" ? " " : chars;
    }
    if (started) spans.push({ text, fg: colour });
    // Trailing blanks are padding, not content — the pane sizes its own rows.
    while (spans.length > 0) {
      const last = spans[spans.length - 1];
      if (last === undefined) break;
      last.text = last.text.replace(/\s+$/, "");
      if (last.text !== "") break;
      spans.pop();
    }
    return spans;
  }

  /** Absolute buffer line the window starts at — the one expression for "where
   *  is the pane looking", so the tail rule cannot be restated per reader. */
  private get start(): number {
    return this.follow ? this.maxTop() : this.top;
  }

  /** The visible window, exactly `height` rows (short buffers pad with blanks
   *  so the pane's geometry never depends on how much has been logged yet). */
  rows(): LogRow[] {
    const start = this.start;
    const total = this.total;
    const out: LogRow[] = [];
    for (let i = 0; i < this.height; i++) {
      const at = start + i;
      const inRange = at < total;
      const text = inRange ? this.lineAt(at) : "";
      out.push({
        text,
        match: this.query !== "" && this.hits(text),
        spans: inRange ? this.spansAt(at) : [],
      });
    }
    return out;
  }

  /** Search hits across the whole buffer, not just the visible window — what
   *  the status bar reports while `/` is open, and the only anchoring readout
   *  any consumer asks for. */
  get matches(): number {
    return this.matchCount();
  }

  private hits(text: string): boolean {
    return text.toLowerCase().includes(this.query);
  }

  private matchCount(): number {
    if (this.query === "") return 0;
    const memo = this.counted;
    if (memo?.query === this.query && memo.writes === this.writes) {
      return memo.matches;
    }
    const total = this.total;
    let n = 0;
    for (let i = 0; i < total; i++) if (this.hits(this.lineAt(i))) n++;
    this.counted = { query: this.query, writes: this.writes, matches: n };
    return n;
  }

  // ── anchoring ────────────────────────────────────────────────────────────

  /** `f` — pin to the tail, or release it where it stands. */
  toggleFollow(): void {
    if (this.follow) this.unpin();
    else this.toBottom();
  }

  /** Stop following, leaving the window exactly where the operator sees it. */
  private unpin(): void {
    this.top = this.maxTop();
    this.follow = false;
  }

  get following(): boolean {
    return this.follow;
  }

  /** Scroll by `delta` rows; any scroll unpins the tail, since an operator who
   *  scrolls is reading, not watching. */
  scrollBy(delta: number): void {
    if (this.follow) this.unpin();
    this.top = Math.max(0, Math.min(this.maxTop(), this.top + delta));
  }

  private maxTop(): number {
    return Math.max(0, this.total - this.height);
  }

  /** `g` — first line. */
  toTop(): void {
    this.follow = false;
    this.top = 0;
  }

  /** `G` — back to the live tail. */
  toBottom(): void {
    this.follow = true;
    this.top = this.maxTop();
  }

  // ── search ───────────────────────────────────────────────────────────────

  /** Case-insensitive; empty clears. Setting a query does not move the
   *  viewport — `next()` does, so typing stays cheap on a long buffer. */
  setQuery(q: string): void {
    const next = q.toLowerCase();
    if (next === this.query) return;
    this.query = next;
    this.cursor = -1;
    this.counted = undefined;
  }

  /** Jump to the next match after the last one (wrapping). Unpins the tail so
   *  the hit stays put instead of being scrolled away by new output.
   *
   *  Scanning resumes from `cursor`, not from `top`: `top` is clamped to the
   *  last full window, so for any hit inside the final `height` lines the two
   *  differ and resuming from `top` would re-find the same line forever. */
  next(): void {
    const total = this.total;
    if (this.query === "" || total === 0) return;
    const from = this.cursor < 0 ? 0 : this.cursor + 1;
    for (let n = 0; n < total; n++) {
      const i = (((from + n) % total) + total) % total;
      if (this.hits(this.lineAt(i))) {
        this.follow = false;
        this.cursor = i;
        this.top = Math.min(this.maxTop(), i);
        return;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.term.dispose();
  }
}
