/**
 * THE COMPILER IS PART OF THIS APP, so it is checked like part of this app.
 *
 * Solid's JSX is a compile target, not a call convention. `babel-preset-solid`
 * turns `<p class="n">{props.count}</p>` into a cloned `<template>` plus ONE
 * effect for the one dynamic binding; the component function itself runs exactly
 * once. Hand the same file to a generic JSX transform — Bun's built-in one, for
 * instance, which is what `scripts/build-web-ui.ts` would fall back to if its
 * loader ever stopped claiming `.tsx` — and you get `jsx(Component, props)`
 * calls, eagerly-read props, and a React-shaped render where the whole component
 * re-runs on every update with its signals re-created underneath it.
 *
 * That regression passes a typecheck, passes a bundle, and renders a page that
 * looks right in a screenshot. What it loses is everything the DOM was holding:
 * the caret in a field, the focus ring on a button, the scroll position of a log
 * pane a person was reading. So it is asserted here rather than trusted.
 *
 * Three claims, over the REAL sources rather than a fixture:
 *
 *   1. every view compiles to `solid-js/web` templates — the preset is actually
 *      reaching the files that ship;
 *   2. a signal read lands in a thunk rather than in the component body — which
 *      IS the statement "a component does not re-run when a value changes";
 *   3. a `<Show>`'s children compile to a getter — the compiler's answer to the
 *      dead-node bug `./dom.tsx`'s header records.
 *
 * The presets are reached through `createRequire` because neither ships type
 * declarations, and a `.d.ts` shim in this package would be a shipped-looking
 * file that is really a build-tool detail. They are the ROOT's build-time
 * toolchain (see the root manifest), not this package's closure — nothing here
 * imports them outside this test, and nothing a consumer installs includes them.
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

/** Every view this package ships. Listed rather than globbed: a file that stops
 *  being a `.tsx` should be a decision somebody made here, not a silent drop
 *  from the set this test polices. */
const VIEWS = ["main.tsx", "app.tsx", "board.tsx", "create.tsx", "detail.tsx", "dom.tsx"];

describe("the Solid compiler that builds this app", () => {
  it.each(VIEWS)("compiles %s to cloned templates, not to component calls", (view) => {
    const code = compile(readFileSync(join(SRC, view), "utf-8"), view);
    // `template` is dom-expressions' clone-a-parsed-fragment helper. Its
    // presence is the signature of the DOM-mode Solid transform; its absence
    // means some other transform ran.
    expect(code, `${view} compiled without a solid-js/web template`).toContain(
      'from "solid-js/web"',
    );
    expect(code).toContain("_$template(");
    // The tell of a generic React-shaped transform. It would bundle and render;
    // it would not be Solid.
    expect(code, `${view} was compiled by a jsx-runtime transform`).not.toContain(
      "jsx-runtime",
    );
  });

  it("keeps a dynamic read OUT of the component body", () => {
    const code = compile(
      "export function N(props: { count: number }) { return <p class='n'>{props.count}</p>; }",
      "probe.tsx",
    );
    // The read is compiled into a thunk handed to `insert`, so it re-runs on its
    // own when `count` moves. If it had been left in the body, the only way to
    // see a new value would be to run `N` again — which is the failure this
    // whole file exists to catch.
    expect(code).toContain("_$insert(");
    expect(code, "the signal read stayed in the component body").toMatch(
      /=>\s*props\.count/,
    );
  });

  it("makes a Show branch re-buildable", () => {
    // Children as a GETTER is what makes leaving a branch and coming back mint a
    // fresh one. Under hyperscript they were a value, built once when the props
    // object was spelled — so a branch that had gone false re-inserted its own
    // disposed nodes, and the app showed run A's page under run B's address.
    // `./dom.tsx`'s header tells that story; this is the line that keeps it told.
    const code = compile(
      "import { Show } from 'solid-js';\n" +
        "export function S(props: { on: boolean }) { return <Show when={props.on}><i>x</i></Show>; }",
      "probe.tsx",
    );
    expect(code, "a Show's children were compiled as a value").toMatch(
      /get children\(\)/,
    );
  });
});
