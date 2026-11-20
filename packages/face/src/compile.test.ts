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

/** THE SAME presets, in the same order, as `scripts/build-web-ui.ts`. */
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
    expect(code, `${view} compiled without a solid-js/web import`).toContain(
      'from "solid-js/web"',
    );
    expect(code, `${view} produced no template to clone`).toContain("_$template(");
    expect(code, `${view} was compiled by a jsx-runtime transform`).not.toContain(
      "jsx-runtime",
    );
  });

  it("compiles Button's disabled into an effect, not into its body", () => {
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
