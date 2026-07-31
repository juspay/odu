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
export interface LogRow {
  text: string;
  match: boolean;
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
    // A reflow rewrites the buffer, so the memo is stale for the same reason a
    // write makes it stale.
    this.writes += 1;
    this.clampAnchor();
  }

  /** Lines actually written, scrollback included.
   *
   *  NOT `buffer.active.length`: that is scrollback + the emulator's full row
   *  count, so a two-line log in a 24-row emulator reports 24 and the tail
   *  window lands on twenty-two blanks. The written extent is where the cursor
   *  has reached — plus the cursor's own line when it holds anything, since
   *  output without a trailing newline is still output.
   *
   *  Advancing the high-water mark here rather than in `write()` gives it one
   *  owner: it is then also correct after a `resize` reflow, which no write
   *  callback would have seen. */
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
      const text = start + i < total ? this.lineAt(start + i) : "";
      out.push({ text, match: this.query !== "" && this.hits(text) });
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
