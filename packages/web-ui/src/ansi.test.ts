/**
 * What the browser's log pane promises about terminal output.
 *
 * Two kinds of claim live here, and they fail for different reasons.
 *
 * **The subset is the subset.** Colour and weight survive; cursor motion,
 * erase-line, screen modes and hyperlink URIs are removed; backgrounds are
 * read and dropped. Each of these is a decision rather than an accident, so
 * each gets a case — including the ones that assert something is GONE, which
 * are the ones a "just strip `\x1b[` up to a letter" rewrite would quietly
 * break.
 *
 * **Nothing is lost that was not escape.** The join property is the real
 * safety net: for any input without a carriage return, the span texts
 * concatenated back together are the input with its escapes removed and not
 * one character else — no dropped byte, no swallowed newline, no partial
 * sequence left on screen. A parser that lost a character in some corner
 * would pass every hand-written case above and fail this one.
 *
 * And a size bound, because this runs on a megabyte of log in a tab: the
 * timing case is not a benchmark, it is a tripwire for the quadratic rewrite —
 * a carriage return that re-slices everything committed so far, or a scan that
 * restarts from the beginning.
 */

import { describe, expect, it } from "bun:test";
import { ansiSpans } from "./ansi";

const ESC = "\u001b";
const BEL = "\u0007";

/** The spans as tuples, which is how the cases below want to read: the text, an
 *  inline colour where there is one, and the class list. That IS the span now —
 *  the module hands a view something ready to draw rather than an `fg` union and
 *  two decoders to run over it. */
function shape(text: string): Array<[string, string | null, string]> {
  return ansiSpans(text).map((s) => [s.text, s.color ?? null, s.class]);
}

/** Just the text, which is what a `<pre>`'s `innerText` would come out as. */
function flat(text: string): string {
  return ansiSpans(text)
    .map((s) => s.text)
    .join("");
}

describe("ansiSpans — the plain page", () => {
  it("returns one span for text with no escapes and no redraws", () => {
    const text = "building odu\nran 12 tests\n";
    expect(ansiSpans(text)).toEqual([{ text, class: "" }]);
  });

  it("returns nothing at all for empty input", () => {
    // An empty span would render as an empty element in the pane and read as
    // a run of output that happened. There was none.
    expect(ansiSpans("")).toEqual([]);
  });

  it("never emits an empty span, even when the escapes are all there is", () => {
    expect(ansiSpans(`${ESC}[31m${ESC}[0m${ESC}[2K`)).toEqual([]);
  });
});

describe("ansiSpans — SGR", () => {
  it("splits a nix-style error line into its colour runs", () => {
    expect(shape(`${ESC}[31;1merror:${ESC}[0m building`)).toEqual([
      ["error:", null, "ansi-1 ansi-b"],
      [" building", null, ""],
    ]);
  });

  it("carries the eight base colours as palette indices", () => {
    expect(shape(`${ESC}[32mok${ESC}[36m·${ESC}[39mplain`)).toEqual([
      ["ok", null, "ansi-2"],
      ["·", null, "ansi-6"],
      ["plain", null, ""],
    ]);
  });

  it("carries the bright colours as indices 8-15", () => {
    expect(shape(`${ESC}[90mdim grey${ESC}[97mwhite`)).toEqual([
      ["dim grey", null, "ansi-8"],
      ["white", null, "ansi-15"],
    ]);
  });

  it("treats a bare ESC[m as a reset", () => {
    expect(shape(`${ESC}[1;31mloud${ESC}[mquiet`)).toEqual([
      ["loud", null, "ansi-1 ansi-b"],
      ["quiet", null, ""],
    ]);
  });

  it("clears weight with 22 and leaves the colour alone", () => {
    expect(shape(`${ESC}[31;1;2mboth${ESC}[22mjust red`)).toEqual([
      ["both", null, "ansi-1 ansi-b ansi-d"],
      ["just red", null, "ansi-1"],
    ]);
  });

  it("carries dim on its own", () => {
    expect(shape(`${ESC}[2mfaint`)).toEqual([["faint", null, "ansi-d"]]);
  });

  it("folds a 256-colour index below 16 back onto the palette", () => {
    // So `38;5;9` re-tints with the theme exactly like `91` does, rather than
    // arriving as a hard-coded red the stylesheet cannot reach.
    expect(shape(`${ESC}[38;5;9mred`)).toEqual([["red", null, "ansi-9"]]);
  });

  it("resolves the 256-colour cube and greyscale ramp to hex", () => {
    // The same arithmetic as the TUI's paletteHex: 196 is the cube's pure red,
    // 244 is a mid grey off the ramp.
    expect(shape(`${ESC}[38;5;196mcube`)).toEqual([
      ["cube", "#ff0000", ""],
    ]);
    expect(shape(`${ESC}[38;5;244mgrey`)).toEqual([
      ["grey", "#808080", ""],
    ]);
  });

  it("accepts the colon spelling of an extended colour", () => {
    expect(shape(`${ESC}[38:5:196mcube`)).toEqual([["cube", "#ff0000", ""]]);
  });

  it("carries truecolor as a CSS colour", () => {
    expect(shape(`${ESC}[38;2;255;128;0morange`)).toEqual([
      ["orange", "rgb(255 128 0)", ""],
    ]);
  });

  it("accepts truecolor with a colon-spelled colour space id", () => {
    // `38:2::r:g:b` — the ITU form, where the empty slot is the colour space.
    expect(shape(`${ESC}[38:2::255:128:0morange`)).toEqual([
      ["orange", "rgb(255 128 0)", ""],
    ]);
  });

  it("reads a background and draws none of it", () => {
    // Parsed rather than skipped: the parameters of a 48 must not be mistaken
    // for the attributes that follow it.
    expect(shape(`${ESC}[41;33mwarn${ESC}[48;5;196;32mok`)).toEqual([
      ["warn", null, "ansi-3"],
      ["ok", null, "ansi-2"],
    ]);
  });

  it("ignores the attributes it does not draw", () => {
    // 3 italic, 4 underline, 7 inverse, 53 overline — dropped without
    // disturbing the colour around them.
    expect(shape(`${ESC}[31m${ESC}[3;4;7;53mtext`)).toEqual([
      ["text", null, "ansi-1"],
    ]);
  });

  it("holds style across a newline and across chunks", () => {
    expect(shape(`${ESC}[31mtwo\nlines`)).toEqual([
      ["two\nlines", null, "ansi-1"],
    ]);
  });
});

describe("ansiSpans — everything else an escape can say", () => {
  it("removes cursor and erase sequences", () => {
    expect(flat(`${ESC}[2K${ESC}[1A${ESC}[?25lstill here${ESC}[?25h`)).toBe(
      "still here",
    );
  });

  it("keeps the visible text of an OSC 8 hyperlink and drops the URI", () => {
    const link = `${ESC}]8;;https://example.test/run/7${BEL}run 7${ESC}]8;;${BEL}`;
    expect(shape(`see ${link} for more`)).toEqual([
      ["see run 7 for more", null, ""],
    ]);
  });

  it("accepts an OSC terminated by ST as well as by BEL", () => {
    expect(flat(`${ESC}]0;a window title${ESC}\\body`)).toBe("body");
  });

  it("removes a two-byte escape", () => {
    expect(flat(`${ESC}7saved${ESC}8${ESC}=text`)).toBe("savedtext");
  });

  it("removes a charset selection, intermediate byte and all", () => {
    // `ESC ( B` is three bytes; a parser that always skipped two would leave a
    // stray B in the log.
    expect(flat(`${ESC}(Bplain`)).toBe("plain");
  });

  it("drops an escape left unterminated at the end of a page", () => {
    // A log page can be split anywhere, and half a sequence on screen is junk.
    expect(flat(`done ${ESC}[3`)).toBe("done ");
    expect(flat(`done ${ESC}[`)).toBe("done ");
    expect(flat(`done ${ESC}`)).toBe("done ");
    expect(flat(`done ${ESC}]8;;https://example.test/`)).toBe("done ");
  });
});

describe("ansiSpans — the carriage return", () => {
  it("treats \\r\\n as nothing but a line ending", () => {
    expect(shape("one\r\ntwo\r\n")).toEqual([["one\ntwo\n", null, ""]]);
  });

  it("keeps only the last redraw of a progress line", () => {
    const redraw =
      `${ESC}[2K\rfetching 10%` +
      `${ESC}[2K\rfetching 60%` +
      `${ESC}[2K\rfetching 100%\n`;
    expect(shape(redraw)).toEqual([["fetching 100%\n", null, ""]]);
  });

  it("throws away only the current line, never the log above it", () => {
    expect(flat("kept\nthrown\rwritten again\ndone")).toBe(
      "kept\nwritten again\ndone",
    );
  });

  it("throws away styled spans on the returned line too", () => {
    expect(shape(`${ESC}[31mfailing…\r${ESC}[32mpassed\n`)).toEqual([
      ["passed\n", null, "ansi-2"],
    ]);
  });

  it("emits nothing for a page that ends on a bare \\r", () => {
    // The documented loss: without an emulator there is no cursor to leave
    // parked mid-line, so a follower rendering page-at-a-time loses the
    // partial line. Re-parsing the whole log recovers it.
    expect(ansiSpans("progress 40%\r")).toEqual([]);
    expect(flat("progress 40%\rprogress 80%")).toBe("progress 80%");
  });

  it("survives a redraw before anything has been written", () => {
    expect(shape("\rfirst")).toEqual([["first", null, ""]]);
  });
});

describe("ansiSpans — coalescing", () => {
  it("merges adjacent runs that say the same thing", () => {
    expect(shape(`${ESC}[31ma${ESC}[31mb${ESC}[0m${ESC}[0mc`)).toEqual([
      ["ab", null, "ansi-1"],
      ["c", null, ""],
    ]);
  });

  it("merges across a committed line boundary", () => {
    expect(shape(`${ESC}[31mred\n${ESC}[31mstill red`)).toEqual([
      ["red\nstill red", null, "ansi-1"],
    ]);
  });

  it("never returns two adjacent spans with the same style", () => {
    const inputs = [
      `${ESC}[31ma${ESC}[31mb`,
      `a\rb\rc\nd`,
      `${ESC}[31mx\r${ESC}[31my\n${ESC}[31mz`,
      `${ESC}[1mA${ESC}[22m${ESC}[1mB`,
    ];
    for (const input of inputs) {
      const spans = ansiSpans(input);
      for (let i = 1; i < spans.length; i++) {
        const a = spans[i - 1];
        const b = spans[i];
        expect(
          a?.class === b?.class && a?.color === b?.color,
          `${JSON.stringify(input)} produced two adjacent spans of one style`,
        ).toBe(false);
      }
      expect(spans.every((s) => s.text !== "")).toBe(true);
    }
  });
});

describe("ansiSpans — the join property", () => {
  /** Every escape sequence this module understands, as a stripper. Written
   *  independently of the parser on purpose: if both had the same idea of
   *  where a sequence ends, the property would only be asserting that a
   *  function agrees with itself. */
  const STRIP = new RegExp(
    [
      "\\u001b\\[[\\u0020-\\u003f]*[\\u0040-\\u007e]", // CSI
      "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)", // OSC
      "\\u001b[\\u0020-\\u002f]*[\\u0030-\\u007e]", // everything else
    ].join("|"),
    "g",
  );

  const INPUTS = [
    "plain text with no escapes at all\n",
    `${ESC}[31merror:${ESC}[0m could not build ${ESC}[1mfoo${ESC}[0m\n`,
    `${ESC}[2Kline\n${ESC}[38;5;196mcube${ESC}[0m\n${ESC}[38;2;1;2;3mrgb`,
    `${ESC}]8;;https://example.test/${BEL}link text${ESC}]8;;${BEL}\n`,
    `${ESC}]0;title${ESC}\\after the title\n`,
    `${ESC}7${ESC}(B${ESC}=mixed two- and three-byte escapes\n`,
    `unicode ✔ ✗ ⚠ and a wide 漢字 with ${ESC}[33mcolour${ESC}[0m\n`,
    "trailing newline\n\n\nand blank lines\n",
    `${ESC}[m${ESC}[0m${ESC}[39m nothing but resets\n`,
  ];

  it("loses the escapes and nothing else", () => {
    for (const input of INPUTS) {
      expect(flat(input), JSON.stringify(input)).toBe(input.replace(STRIP, ""));
    }
  });

  it("is exact about what the stripper is comparing against", () => {
    // A stripper that matched nothing would make the property vacuous.
    const stripped = INPUTS.map((i) => i.replace(STRIP, ""));
    expect(stripped.some((s, i) => s !== INPUTS[i])).toBe(true);
    expect(stripped.every((s) => !s.includes(ESC))).toBe(true);
  });
});

describe("ansiSpans — a megabyte of log", () => {
  const MIB = 1024 * 1024;

  function repeatTo(unit: string, size: number): string {
    return unit.repeat(Math.ceil(size / unit.length));
  }

  it("returns a plain megabyte instantly, as one span", () => {
    const text = repeatTo("a line of perfectly ordinary build output\n", MIB);
    const started = performance.now();
    const spans = ansiSpans(text);
    const took = performance.now() - started;
    expect(spans.length).toBe(1);
    expect(spans[0]?.text.length).toBe(text.length);
    expect(took, `${took.toFixed(1)}ms for a plain MiB`).toBeLessThan(100);
  });

  it("parses a coloured megabyte well inside a frame budget", () => {
    // Loose on purpose: this is not a benchmark, it is a tripwire for a
    // quadratic rewrite. A parser that re-scanned or re-sliced would be
    // seconds here, not milliseconds.
    const text = repeatTo(
      `${ESC}[32m✔${ESC}[0m ${ESC}[1mcheck${ESC}[22m passed in ` +
        `${ESC}[38;5;244m12ms${ESC}[0m\n`,
      MIB,
    );
    expect(text.length).toBeGreaterThanOrEqual(MIB);
    const started = performance.now();
    const spans = ansiSpans(text);
    const took = performance.now() - started;
    expect(spans.length).toBeGreaterThan(1000);
    expect(took, `${took.toFixed(1)}ms for a coloured MiB`).toBeLessThan(500);
  });

  it("parses a megabyte of redraws well inside a frame budget", () => {
    // The other quadratic shape: a progress bar that returns the carriage
    // tens of thousands of times over an ever-growing log.
    const text = repeatTo(`\r${ESC}[2Kdownloading 99% of a rather long path`, MIB);
    const started = performance.now();
    const spans = ansiSpans(text);
    const took = performance.now() - started;
    expect(spans.length).toBe(1);
    expect(took, `${took.toFixed(1)}ms for a MiB of redraws`).toBeLessThan(500);
  });
});

describe("ansiSpans — the span a view draws", () => {
  /** The projection every case above reads through, asserted on its own: a view
   *  sets `class` and `color` unconditionally and asks nothing about how the
   *  colour was spelled, which is the whole reason the two decoders that used to
   *  be exported are not. */
  const one = (text: string) => ansiSpans(text)[0];

  it("gives a plain span no class and no inline colour", () => {
    expect(one("plain")).toEqual({ text: "plain", class: "" });
  });

  it("names a palette colour by index and leaves the tint to the stylesheet", () => {
    expect(one(`${ESC}[94mblue`)).toEqual({ text: "blue", class: "ansi-12" });
  });

  it("draws a non-palette colour inline and adds no class for it", () => {
    expect(one(`${ESC}[38;5;196mcube`)).toEqual({
      text: "cube",
      class: "",
      color: "#ff0000",
    });
    expect(one(`${ESC}[38;2;1;2;3mtrue`)).toEqual({
      text: "true",
      class: "",
      color: "rgb(1 2 3)",
    });
  });

  it("carries weight alongside a colour", () => {
    expect(one(`${ESC}[31;1;2mboth`)?.class).toBe("ansi-1 ansi-b ansi-d");
    expect(one(`${ESC}[1mloud`)?.class).toBe("ansi-b");
    expect(one(`${ESC}[38;2;171;205;239;2mfaint`)).toEqual({
      text: "faint",
      class: "ansi-d",
      color: "rgb(171 205 239)",
    });
  });
});
