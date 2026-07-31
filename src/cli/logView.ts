/**
 * The focused node's log, backed by a real terminal emulator instead of a
 * string buffer.
 *
 * A node's output is not text: `nix build`, `bun test` and friends redraw with
 * carriage returns and cursor motion, so concatenating the bytes and splitting
 * on `\n` turns one progress bar into several hundred junk lines and pushes the
 * useful output out of view. Feeding the same bytes to a headless VT gives the
 * semantics the producer actually intended — `\r` overwrites in place, SGR
 * colour survives, and a wide glyph occupies two cells because the emulator
 * measured it rather than because we counted code points.
 *
 * The viewport is a window onto that VT's buffer: `follow` pins it to the tail
 * (the default — a running node should stream), and any scroll input unpins it
 * so a failure can be read without quitting. Search is a filter over the same
 * buffer, so `/` never has to re-parse anything.
 */

import { Terminal } from "@xterm/headless";
import type { NodeLogFrame } from "../common/surface";

/** One visible row of the pane. `match` marks a search hit so the frame can
 *  highlight it without knowing what the query was. */
export interface LogRow {
  text: string;
  match: boolean;
}

/** How the pane is currently anchored — surfaced in the status bar so the
 *  operator can tell a live tail from a pinned read. */
export interface LogPosition {
  follow: boolean;
  /** 1-based index of the top visible line, for the `line n/total` readout. */
  top: number;
  total: number;
  /** Search hits in the whole buffer, not just the visible window. */
  matches: number;
}

/** The emulator is sized generously in rows: its scrollback is the pane's
 *  history, and a node that logs for half an hour should still be readable
 *  from the top of its failure. */
const SCROLLBACK = 5000;

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
  /** Memoized match count, keyed on what it was computed from: `position()` is
   *  called on every repaint and a full-buffer scan per frame is not free. */
  private counted: { query: string; total: number; matches: number } | undefined;

  constructor(cols: number, height: number) {
    this.height = Math.max(1, height);
    this.term = new Terminal({
      cols: Math.max(1, cols),
      // The VT's own rows are irrelevant to what we display — we read lines out
      // of its buffer — but they must not be smaller than the window we intend
      // to show, or the emulator wraps content we would then read back short.
      rows: Math.max(this.height, 24),
      scrollback: SCROLLBACK,
      allowProposedApi: true,
    });
  }

  /** Feed one surface frame. A `snapshot` replaces the buffer (a focus change
   *  backfills from scratch), an `append` extends it. Async because the
   *  emulator parses off-thread: the buffer is NOT current until the write
   *  callback fires, so every caller must await this before reading rows. */
  async feed(frame: NodeLogFrame): Promise<void> {
    if (frame.kind === "snapshot") {
      this.term.reset();
      this.follow = true;
      this.top = 0;
      this.cursor = -1;
      this.highWater = 0;
    }
    await new Promise<void>((resolve) => this.term.write(frame.text, resolve));
    this.highWater = Math.max(this.highWater, this.writtenExtent());
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
    this.counted = undefined;
    if (this.follow) this.toBottom();
    else this.top = Math.min(this.top, this.maxTop());
  }

  /** Lines actually written, scrollback included.
   *
   *  NOT `buffer.active.length`: that is scrollback + the emulator's full row
   *  count, so a two-line log in a 24-row emulator reports 24 and the tail
   *  window lands on twenty-two blanks. The written extent is where the cursor
   *  has reached — plus the cursor's own line when it holds anything, since
   *  output without a trailing newline is still output. */
  get total(): number {
    return Math.max(this.highWater, this.writtenExtent());
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

  /** The visible window, exactly `height` rows (short buffers pad with blanks
   *  so the pane's geometry never depends on how much has been logged yet). */
  rows(): LogRow[] {
    const start = this.follow ? Math.max(0, this.total - this.height) : this.top;
    const out: LogRow[] = [];
    for (let i = 0; i < this.height; i++) {
      const text = start + i < this.total ? this.lineAt(start + i) : "";
      out.push({ text, match: this.query !== "" && this.hits(text) });
    }
    return out;
  }

  position(): LogPosition {
    const start = this.follow ? Math.max(0, this.total - this.height) : this.top;
    return {
      follow: this.follow,
      top: Math.min(this.total, start + 1),
      total: this.total,
      matches: this.matchCount(),
    };
  }

  private hits(text: string): boolean {
    return text.toLowerCase().includes(this.query);
  }

  private matchCount(): number {
    if (this.query === "") return 0;
    const total = this.total;
    const memo = this.counted;
    if (memo?.query === this.query && memo.total === total) return memo.matches;
    let n = 0;
    for (let i = 0; i < total; i++) if (this.hits(this.lineAt(i))) n++;
    this.counted = { query: this.query, total, matches: n };
    return n;
  }

  // ── anchoring ────────────────────────────────────────────────────────────

  /** `f` — pin to the tail, or release it where it stands. */
  toggleFollow(): void {
    if (this.follow) {
      this.top = Math.max(0, this.total - this.height);
      this.follow = false;
    } else this.toBottom();
  }

  get following(): boolean {
    return this.follow;
  }

  /** Scroll by `delta` rows; any scroll unpins the tail, since an operator who
   *  scrolls is reading, not watching. */
  scrollBy(delta: number): void {
    if (this.follow) {
      this.top = Math.max(0, this.total - this.height);
      this.follow = false;
    }
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

  get search(): string {
    return this.query;
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
    this.term.dispose();
  }
}
