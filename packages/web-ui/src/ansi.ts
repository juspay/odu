/**
 * ANSI colour, for a `<pre>` — the small honest subset of a terminal.
 *
 * The TUI's log pane (`packages/cli/src/logView.ts`) feeds a node's bytes to a
 * REAL VT (`@xterm/headless`) and reads colour back out of the emulator's
 * cells, which is the correct answer: `\r` overwrites in place, a cursor move
 * moves the cursor, and a wide glyph is two cells because something measured
 * it. The browser cannot have that answer. An emulator in the tab would mean
 * shipping xterm into the bundle AND rendering into its canvas/DOM, and the
 * acceptance suite reads a log pane's `innerText` — so the log has to stay a
 * `<pre>` of real text nodes that a person can select and a test can read.
 *
 * So this module claims LESS, on purpose, and says exactly what:
 *
 *   - SGR colour and weight become spans. Everything else an escape can say —
 *     cursor motion, erase-line, screen modes, titles, hyperlink URIs — is
 *     REMOVED rather than approximated, because a wrong cursor is worse than
 *     no cursor.
 *   - A bare `\r` is approximated as "discard this line and start it over",
 *     which is what a progress bar means by it (`nix build`, `bun test`) but
 *     is not what it means in general: a producer that returns the carriage
 *     and then writes SHORTER text leaves the tail of the old line visible on
 *     a real terminal, and here it does not. That is the one place this module
 *     is knowingly lying, and it lies in the direction of a readable log.
 *   - Backgrounds are parsed and dropped. The console owns its ground; a log
 *     line painted with somebody's idea of black on a light theme is unreadable
 *     in a way that losing the background never is.
 *
 * Palette colours (0-15) come out as an INDEX, not a hex string, so the
 * stylesheet's `--ansi-N` tokens decide what "red" looks like in each theme —
 * the same reason the TUI keeps its own `ANSI16` table instead of the
 * terminal's. 256-colour and truecolor have no such token and are drawn
 * inline.
 *
 * Pure and DOM-free: it takes a string and returns spans READY TO DRAW, which
 * is the whole of its contract with a view. WHICH of the two colour strategies
 * a run needs — a palette index the stylesheet tints, or a hex string drawn
 * inline — is this module's own business and stops at this module's edge: a
 * view that ran that discrimination itself would be holding a rendering rule
 * that is not its to hold, and would then have to re-derive the plain-run case
 * this module already knew.
 */

/** One run of same-styled text, READY TO DRAW. `class` is "" and `color` is
 *  undefined for the console's default ink, so a view sets both
 *  unconditionally and asks nothing about how a colour was spelled. */
export interface AnsiSpan {
  text: string;
  class: string;
  color?: string;
}

/** The working shape, private to this module. `fg` is an ANSI palette index
 *  0-15 (drawn through the stylesheet's `--ansi-N` tokens so it can be
 *  re-tinted), a CSS colour string for 256-colour and truecolor (drawn
 *  inline), or null for the console's default ink; `write` and `commit`
 *  coalesce runs on exactly these three fields. */
interface Run {
  text: string;
  fg: number | string | null;
  bold: boolean;
  dim: boolean;
}

/**
 * Split terminal output into styled spans. Pure; no DOM.
 *
 * `\n` is preserved inside the span text — the `<pre>` draws it — so for input
 * without a carriage return, joining every span's text reproduces the input
 * with the escapes removed and nothing else changed.
 */
export function ansiSpans(text: string): AnsiSpan[] {
  if (text === "") return [];
  // The overwhelmingly common page: no escapes, no redraws, one span. Two
  // linear scans and no per-character work at all.
  if (!text.includes("\u001b") && !text.includes("\r")) {
    return [{ text, class: "" }];
  }

  const out: Run[] = [];
  let fg: number | string | null = null;
  let bold = false;
  let dim = false;

  // The spans written since the last newline, held apart from `out`. A bare
  // `\r` throws exactly this away and a `\n` commits it, which is the whole of
  // the redraw rule — and it is also why a redraw is cheap: text that has
  // already been committed is never re-examined, so a progress bar that
  // returns the carriage ten thousand times costs ten thousand small arrays
  // rather than ten thousand copies of the log so far.
  let line: Run[] = [];

  /** Append to the current line, coalescing into its last span when the style
   *  has not changed. Empty text is never a span. */
  const write = (chunk: string): void => {
    if (chunk === "") return;
    const last = line[line.length - 1];
    if (
      last !== undefined &&
      last.fg === fg &&
      last.bold === bold &&
      last.dim === dim
    ) {
      last.text += chunk;
      return;
    }
    line.push({ text: chunk, fg, bold, dim });
  };

  /** The line survived: move it into the output, coalescing across the line
   *  boundary too — a newline is not a style change. */
  const commit = (): void => {
    for (const span of line) {
      const last = out[out.length - 1];
      if (
        last !== undefined &&
        last.fg === span.fg &&
        last.bold === span.bold &&
        last.dim === span.dim
      ) {
        last.text += span.text;
      } else {
        out.push(span);
      }
    }
    line = [];
  };

  const emit = (chunk: string): void => {
    const nl = chunk.lastIndexOf("\n");
    if (nl === -1) {
      write(chunk);
      return;
    }
    // Everything through the LAST newline is safe from a later `\r`; what
    // follows it is the new current line.
    write(chunk.slice(0, nl + 1));
    commit();
    write(chunk.slice(nl + 1));
  };

  const applySgr = (params: string): void => {
    // `ESC[m` is `ESC[0m`.
    if (params === "") {
      fg = null;
      bold = false;
      dim = false;
      return;
    }
    const fields = params.split(";");
    for (let f = 0; f < fields.length; f++) {
      const parts = (fields[f] ?? "").split(":");
      const code = sgrNumber(parts[0]);
      if (code === undefined) continue; // not a number: not ours to guess at
      if (code === 38 || code === 48) {
        // Extended colour, in either spelling: sub-parameters in this field
        // (`38:5:196`) or in the fields that follow (`38;5;196`).
        let colour: number | string | undefined;
        if (parts.length > 1) {
          colour = extendedColour(parts.slice(1));
        } else {
          const kind = sgrNumber(fields[f + 1]);
          const taken = kind === 5 ? 2 : kind === 2 ? 4 : 1;
          colour = extendedColour(fields.slice(f + 1, f + 1 + taken));
          f += taken;
        }
        // 48 is a background: parsed so its parameters cannot be mistaken for
        // the next attribute, then dropped.
        if (code === 38 && colour !== undefined) fg = colour;
        continue;
      }
      if (code === 0) {
        fg = null;
        bold = false;
        dim = false;
      } else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 22) {
        bold = false;
        dim = false;
      } else if (code >= 30 && code <= 37) fg = code - 30;
      else if (code === 39) fg = null;
      else if (code >= 90 && code <= 97) fg = code - 90 + 8;
      // Everything else — backgrounds (40-47, 49, 100-107), italic, underline,
      // blink, inverse, fonts — is ignored. An attribute this module does not
      // draw is better dropped than half-drawn.
    }
  };

  const next = /[\u001b\r]/g;
  let i = 0;
  for (;;) {
    next.lastIndex = i;
    const hit = next.exec(text);
    if (hit === null) {
      emit(text.slice(i));
      break;
    }
    const at = hit.index;
    if (at > i) emit(text.slice(i, at));
    if (text[at] === "\r") {
      // `\r\n` is a line ending and nothing else; the `\n` rides along in the
      // next plain chunk. A bare `\r` returns the carriage: this line is
      // thrown away and whatever follows writes it again.
      if (text[at + 1] !== "\n") line = [];
      i = at + 1;
      continue;
    }
    i = skipEscape(text, at, applySgr);
  }

  // Whatever the last line holds survives to the output — a log rarely ends
  // with a newline, and a trailing partial line is the line somebody is
  // watching.
  //
  // The exception is a page that ends ON a bare `\r`: that line was already
  // thrown away above and nothing is emitted for it. A follower that renders
  // each page as it arrives has therefore lost that partial line even though
  // the next page continues it — the price of approximating a redraw without
  // an emulator, which has no cursor to leave parked mid-line. Handing the
  // whole log back through here instead of page-at-a-time gets the right
  // answer, because then the two halves are one string.
  commit();
  return out.map(drawable);
}

/** A working run as a view can draw it. The two decisions folded in here used
 *  to be two more exports the only consumer imported and composed by hand:
 *  `ansi-<n>` for a palette fg, `ansi-b` for bold, `ansi-d` for dim — and an
 *  inline `color` ONLY for a colour the stylesheet has no token for, because a
 *  palette index is the stylesheet's to tint. */
function drawable(run: Run): AnsiSpan {
  const classes: string[] = [];
  if (typeof run.fg === "number") classes.push(`ansi-${run.fg}`);
  if (run.bold) classes.push("ansi-b");
  if (run.dim) classes.push("ansi-d");
  return {
    text: run.text,
    class: classes.join(" "),
    ...(typeof run.fg === "string" ? { color: run.fg } : {}),
  };
}

/**
 * Where an escape sequence ends — the index to resume reading at.
 *
 * Only `ESC [ … m` produces anything; every other sequence is consumed for its
 * length and thrown away, which is what "removed" means here. A sequence that
 * runs off the end of the input is dropped entirely rather than shown: a log
 * page can be split anywhere, and half an escape on screen is junk.
 */
function skipEscape(
  text: string,
  at: number,
  sgr: (params: string) => void,
): number {
  const c = text[at + 1];
  if (c === undefined) return text.length; // a lone ESC at the page boundary
  if (c === "[") {
    // CSI: parameter and intermediate bytes (0x20-0x3f), then one final byte
    // (0x40-0x7e). `m` is ours; `K`, `A`, `?25l` and the rest are dropped.
    let j = at + 2;
    while (j < text.length) {
      const b = text.charCodeAt(j);
      if (b < 0x20 || b > 0x3f) break;
      j++;
    }
    if (j >= text.length) return text.length;
    const final = text.charCodeAt(j);
    if (final < 0x40 || final > 0x7e) return j; // malformed: drop what we read
    if (text[j] === "m") sgr(text.slice(at + 2, j));
    return j + 1;
  }
  if (c === "]") {
    // OSC: a string terminated by BEL or by ST (`ESC \`). Titles and OSC 8
    // hyperlinks live here — dropping the sequence keeps the hyperlink's
    // VISIBLE text, which sits between the two OSCs, and loses only the URI.
    let j = at + 2;
    while (j < text.length) {
      const b = text.charCodeAt(j);
      if (b === 0x07) return j + 1;
      // An ESC that is not the start of ST abandons the OSC; resume there so
      // the sequence it begins is read properly.
      if (b === 0x1b) return text[j + 1] === "\\" ? j + 2 : j;
      j++;
    }
    return text.length;
  }
  // Everything else: ESC, zero or more intermediate bytes (0x20-0x2f), one
  // final byte — `ESC 7`, `ESC =`, `ESC ( B`.
  let j = at + 1;
  while (j < text.length) {
    const b = text.charCodeAt(j);
    if (b < 0x20 || b > 0x2f) break;
    j++;
  }
  return j >= text.length ? text.length : j + 1;
}

/** One SGR parameter as a number. An omitted parameter is 0, as the standard
 *  says; anything non-numeric is undefined, and its caller ignores it. */
function sgrNumber(field: string | undefined): number | undefined {
  if (field === undefined) return undefined;
  if (field === "") return 0;
  if (!/^[0-9]+$/.test(field)) return undefined;
  return Number(field);
}

/**
 * The colour an extended SGR names: `args` is what follows the 38 or 48.
 *
 * `5;n` is a palette index — folded to a plain index below 16 so it re-tints
 * with the theme like `31` does. `2;r;g;b` is truecolor; the r, g and b are
 * read as the LAST three arguments, because the colon spelling may carry an
 * (empty) colour-space id first: `38:2::255:0:0`.
 */
function extendedColour(
  args: readonly (string | undefined)[],
): number | string | undefined {
  const kind = sgrNumber(args[0]);
  if (kind === 5) {
    const n = sgrNumber(args[1]);
    if (n === undefined || n > 255) return undefined;
    return n < 16 ? n : cubeHex(n);
  }
  if (kind === 2) {
    const rgb = args.slice(-3).map(sgrNumber);
    const [r, g, b] = rgb;
    if (r === undefined || g === undefined || b === undefined) return undefined;
    if (r > 255 || g > 255 || b > 255) return undefined;
    return `rgb(${r} ${g} ${b})`;
  }
  return undefined;
}

/**
 * An xterm palette index above 15 as a hex colour: 16-231 the 6x6x6 cube,
 * 232-255 the greyscale ramp.
 *
 * The arithmetic is copied verbatim from `paletteHex` in
 * `packages/cli/src/logView.ts` — ONE arithmetic, two faces, so a 256-colour
 * log reads the same in the terminal pane and in the browser. Only the 0-15
 * half differs, and deliberately: the TUI resolves those against its own
 * palette table, and the browser hands the index to the stylesheet instead.
 */
function cubeHex(i: number): string {
  if (i >= 232) {
    const v = 8 + (i - 232) * 10;
    return `#${v.toString(16).padStart(2, "0").repeat(3)}`;
  }
  const n = i - 16;
  const step = (x: number): string =>
    (x === 0 ? 0 : 55 + x * 40).toString(16).padStart(2, "0");
  return `#${step(Math.floor(n / 36))}${step(Math.floor(n / 6) % 6)}${step(n % 6)}`;
}
