export interface AnsiSpan {
  text: string;
  class: string;
  color?: string;
}

interface Run {
  text: string;
  fg: number | string | null;
  bold: boolean;
  dim: boolean;
}

export function ansiSpans(text: string): AnsiSpan[] {
  if (text === "") return [];
  if (!text.includes("\u001b") && !text.includes("\r")) {
    return [{ text, class: "" }];
  }

  const out: Run[] = [];
  let fg: number | string | null = null;
  let bold = false;
  let dim = false;

  let line: Run[] = [];

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
      if (code === undefined) continue;
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
      if (text[at + 1] !== "\n") line = [];
      i = at + 1;
      continue;
    }
    i = skipEscape(text, at, applySgr);
  }

  commit();
  return out.map(drawable);
}

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

function skipEscape(
  text: string,
  at: number,
  sgr: (params: string) => void,
): number {
  const c = text[at + 1];
  if (c === undefined) return text.length;
  if (c === "[") {
    // CSI: parameter and intermediate bytes (0x20-0x3f), then one final byte
    // (0x40-0x7e).
    let j = at + 2;
    while (j < text.length) {
      const b = text.charCodeAt(j);
      if (b < 0x20 || b > 0x3f) break;
      j++;
    }
    if (j >= text.length) return text.length;
    const final = text.charCodeAt(j);
    if (final < 0x40 || final > 0x7e) return j;
    if (text[j] === "m") sgr(text.slice(at + 2, j));
    return j + 1;
  }
  if (c === "]") {
    // OSC: a string terminated by BEL or by ST (`ESC \`).
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
 * `2;r;g;b` is truecolor; the r, g and b are read as the LAST three
 * arguments, because the colon spelling may carry an (empty) colour-space id
 * first: `38:2::255:0:0`.
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
