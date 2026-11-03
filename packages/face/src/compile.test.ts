/**
 * THE COMPILER IS PART OF THIS PACKAGE NOW, so it is checked like part of it.
 *
 * `@odu/face` used to hold two plain `.ts` modules. It holds the design
 * system's PRIMITIVES — every button, pill, panel and lane strip every row's
 * face draws — so the compiler argument that `@odu/ci/face`'s twin makes now
 * applies here, and applies harder: a mis-compiled view in one row is one
 * broken screen, a mis-compiled `Button` is every control in the application.
 *
 * Solid's JSX is a compile target, not a call convention. `babel-preset-solid`
 * turns `<p class="n">{props.count}</p>` into a cloned `<template>` plus ONE
 * effect for the one dynamic binding; the component function runs exactly
 * once. Hand the same file to a generic JSX transform — Bun's built-in one,
 * which is what `scripts/build-web-ui.ts` would fall back to if its loader
 * ever stopped claiming `.tsx` — and you get `jsx(Component, props)` calls,
 * eagerly-read props, and a React-shaped render where the whole component
 * re-runs with its signals re-created underneath it. That regression passes a
 * typecheck, passes a bundle, and renders a page that looks right in a
 * screenshot; what it loses is the caret in a field, the focus ring on a
 * button, and the scroll position of a log pane a person was reading.
 *
 * The presets are reached through `createRequire` because neither ships type
 * declarations, and a `.d.ts` shim here would be a shipped-looking file that
 * is really a build-tool detail. They are the ROOT's build-time toolchain, not
 * this package's closure — which is why `closure.test.ts` still pins this
 * package's dependencies at exactly `effect` and `solid-js`.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const require_ = createRequire(import.meta.url);
const babel = require_("@babel/core") as {
  transformSync: (
    code: string,
    options: Record<string, unknown>,
  ) => { code?: string | null } | null;
};
const solidPreset: unknown = require_("babel-preset-solid");
const typescriptPreset: unknown = require_("@babel/preset-typescript");

const SRC = import.meta.dirname;

/** THE SAME presets, in the same order, as `scripts/build-web-ui.ts`. Two
 *  spellings of one toolchain is a drift that goes quiet — so if this list and
 *  that one ever disagree, this suite is checking a compiler nothing ships. */
function compile(source: string, filename: string): string {
  const out = babel.transformSync(source, {
    filename,
    babelrc: false,
    configFile: false,
    presets: [
      [typescriptPreset, { isTSX: true, allExtensions: true }],
      [solidPreset, {}],
    ],
  });
  const code = out?.code;
  if (code == null) throw new Error(`the Solid compiler produced nothing for ${filename}`);
  return code;
}

/** Every view this package ships. Listed rather than globbed: a file that
 *  stops being a `.tsx` should be a decision somebody made here, not a silent
 *  drop from the set this test polices. */
const VIEWS = ["ui.tsx", "theme.tsx"];

describe("the Solid compiler that builds the shared primitives", () => {
  it.each(VIEWS)("compiles %s to cloned templates, not to component calls", (view) => {
    const code = compile(readFileSync(join(SRC, view), "utf-8"), view);
    // `template` is dom-expressions' clone-a-parsed-fragment helper. Its
    // presence is the signature of the DOM-mode Solid transform; its absence
    // means some other transform ran.
    expect(code, `${view} compiled without a solid-js/web import`).toContain(
      'from "solid-js/web"',
    );
    expect(code, `${view} produced no template to clone`).toContain("_$template(");
    // The tell of a generic React-shaped transform. It would bundle and
    // render; it would not be Solid.
    expect(code, `${view} was compiled by a jsx-runtime transform`).not.toContain(
      "jsx-runtime",
    );
  });

  it("compiles Button's disabled into an effect, not into its body", () => {
    // `Button` is the one component every control in this application goes
    // through, and `disabled` is the binding that matters: read once in the
    // component body, a control that becomes busy stays pressable until
    // something else happens to re-render the page. The Solid transform puts
    // it in an `effect`, which is what makes it track.
    const code = compile(readFileSync(join(SRC, "ui.tsx"), "utf-8"), "ui.tsx");
    const start = code.indexOf("function Button(props)");
    expect(start, "ui.tsx no longer compiles a Button component").toBeGreaterThan(-1);
    const body = code.slice(start, code.indexOf("function Hint(props)", start));
    const effect = body.indexOf("_$effect(");
    expect(effect, "Button compiled with no effect at all").toBeGreaterThan(-1);
    expect(
      body.indexOf("props.disabled"),
      "Button's `disabled` is read before its first effect, so it is read once " +
        "and frozen — a busy control would stay pressable.",
    ).toBeGreaterThan(effect);
  });
});
