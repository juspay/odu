import { Terminal } from "@xterm/headless";

export interface LogSpan {
  text: string;
  fg: string | undefined;
}

export interface LogRow {
  text: string;
  match: boolean;
  spans: LogSpan[];
}

const SCROLLBACK = 5000;

export const ANSI16 = [
  "#3b4650", "#e8695b", "#6fcf8e", "#e6b24d",
  "#6a9fdc", "#bb8ce2", "#5ec8c4", "#c6d2d3",
  "#5d6d70", "#ef8578", "#8ddba6", "#f0c46e",
  "#8bb8e8", "#cda6ec", "#7fd8d4", "#e8f0f0",
] as const;

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
  private top = 0;
  private cursor = -1;
  private query = "";
  private height: number;
  private highWater = 0;
  private contentVersion = 0;
  /** `Terminal.write` defers its callback, and a focus change disposes this
   *  view synchronously — so the continuation can land after disposal and
   *  touch a disposed buffer, which xterm reports by printing a stack trace to
   *  stderr. */
  private disposed = false;
  private counted:
    | { query: string; contentVersion: number; matches: number }
    | undefined;

  constructor(cols: number, height: number, query = "") {
    this.height = Math.max(1, height);
    this.query = query.toLowerCase();
    this.term = new Terminal({
      cols: Math.max(1, cols),
      // The VT's own rows must not be smaller than the window we intend to
      // show, or the emulator wraps content we would then read back short.
      rows: Math.max(this.height, 24),
      scrollback: SCROLLBACK,
      // The bytes come from a PIPE, not a pty, so the termios `\n` -> `\r\n`
      // translation never happened; without this xterm moves down a row and
      // KEEPS the column.
      convertEol: true,
      allowProposedApi: true,
    });
  }

  async write(text: string): Promise<void> {
    await new Promise<void>((resolve) => this.term.write(text, resolve));
    // Touching the buffer after a dispose throws out of xterm and onto the
    // terminal.
    if (this.disposed) return;
    this.contentVersion += 1;
    this.clampAnchor();
  }

  reset(): void {
    this.term.reset();
    this.follow = true;
    this.top = 0;
    this.cursor = -1;
    this.highWater = 0;
    this.contentVersion += 1;
  }

  private clampAnchor(): void {
    if (this.follow) this.toBottom();
    else this.top = Math.min(this.top, this.maxTop());
  }

  resize(cols: number, height: number): void {
    const next = Math.max(1, height);
    const cols_ = Math.max(1, cols);
    if (next === this.height && cols_ === this.term.cols) return;
    this.height = next;
    this.term.resize(cols_, Math.max(this.height, 24));
    this.highWater = 0;
    this.contentVersion += 1;
    this.clampAnchor();
  }

  /** NOT `buffer.active.length`: that is scrollback plus the emulator's full
   *  row count, so a two-line log in a 24-row emulator reports 24 and the tail
   *  window lands on twenty-two blanks. */
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

  /** `translateToString` flattens the attributes away, so the cells are walked
   *  to keep the producer's own colours. */
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
    while (spans.length > 0) {
      const last = spans[spans.length - 1];
      if (last === undefined) break;
      last.text = last.text.replace(/\s+$/, "");
      if (last.text !== "") break;
      spans.pop();
    }
    return spans;
  }

  get windowTop(): number {
    return this.start;
  }

  private get start(): number {
    return this.follow ? this.maxTop() : this.top;
  }

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

  get matches(): number {
    return this.matchCount();
  }

  private hits(text: string): boolean {
    return text.toLowerCase().includes(this.query);
  }

  private matchCount(): number {
    if (this.query === "") return 0;
    const memo = this.counted;
    if (memo?.query === this.query && memo.contentVersion === this.contentVersion) {
      return memo.matches;
    }
    const total = this.total;
    let n = 0;
    for (let i = 0; i < total; i++) if (this.hits(this.lineAt(i))) n++;
    this.counted = {
      query: this.query,
      contentVersion: this.contentVersion,
      matches: n,
    };
    return n;
  }

  toggleFollow(): void {
    if (this.follow) this.unpin();
    else this.toBottom();
  }

  private unpin(): void {
    this.top = this.maxTop();
    this.follow = false;
  }

  get following(): boolean {
    return this.follow;
  }

  scrollBy(delta: number): void {
    if (this.follow) this.unpin();
    this.top = Math.max(0, Math.min(this.maxTop(), this.top + delta));
  }

  scrollTo(line: number): void {
    this.unpin();
    this.top = Math.max(0, Math.min(this.maxTop(), Math.round(line)));
  }

  get maxWindowTop(): number {
    return this.maxTop();
  }

  private maxTop(): number {
    return Math.max(0, this.total - this.height);
  }

  toTop(): void {
    this.follow = false;
    this.top = 0;
  }

  toBottom(): void {
    this.follow = true;
    this.top = this.maxTop();
  }

  setQuery(q: string): void {
    const next = q.toLowerCase();
    if (next === this.query) return;
    this.query = next;
    this.cursor = -1;
    this.counted = undefined;
  }

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
