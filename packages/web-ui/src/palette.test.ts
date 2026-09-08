/**
 * THE COLOURS THIS PAGE DRAWS THAT THE STYLESHEET CANNOT REACH.
 *
 * A favicon is an SVG built in TypeScript, because its hue is a function of
 * live state and a build cannot know which state is true. That puts four
 * colours in `format.ts` as hex literals — the dot, the ground, the sigil —
 * that are also tokens in `styles.css`, in a language that cannot import them
 * and is not imported by them. Two restatements of one design choice, agreeing
 * by nobody's promise.
 *
 * A TEST is the receptacle for exactly that shape: two languages that must
 * agree and cannot reach each other. Reading the stylesheet is legal here —
 * `closure.test.ts` bars `node:` from the shipped modules, not from the suite.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { faviconSvg } from "./format";

const css = readFileSync(join(import.meta.dirname, "styles.css"), "utf-8");

function token(name: string): string {
  const hit = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  return (hit?.[1] ?? "").trim();
}

/** Every palette token is `light-dark(light, dark)`. The mark's ground is dark
 *  in BOTH themes — it is a rounded black square whichever way the desktop is
 *  set — so it is always the dark half that belongs on it. */
function dark(name: string): string {
  const half = /light-dark\([^,]+,\s*([^)]+)\)/.exec(token(name))?.[1]?.trim();
  expect(half, `--${name} is not a light-dark() pair`).toBeDefined();
  return half ?? "";
}

describe("the favicon is drawn in the stylesheet's own colours", () => {
  const contains = (svg: string, hex: string): boolean =>
    svg.includes(encodeURIComponent(hex));

  it("uses --red's dark half for a failing board", () => {
    expect(contains(faviconSvg("red"), dark("red"))).toBe(true);
  });

  it("uses --amber's dark half for a busy one", () => {
    expect(contains(faviconSvg("amber"), dark("amber"))).toBe(true);
  });

  it("draws the mark on --canvas in --quiet, the same as the wordmark", () => {
    const svg = faviconSvg("red");
    expect(contains(svg, dark("canvas"))).toBe(true);
    expect(contains(svg, dark("quiet"))).toBe(true);
  });
});
