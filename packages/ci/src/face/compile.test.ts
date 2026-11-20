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

const VIEWS = [
  "ci.tsx",
  "board.tsx",
  "commit.tsx",
  "create.tsx",
  "detail.tsx",
  "ops.tsx",
];

const MARKUP = new Set(["board.tsx", "commit.tsx", "create.tsx", "detail.tsx", "ops.tsx"]);

describe("the Solid compiler that builds this app", () => {
  it.each(VIEWS)("compiles %s to cloned templates, not to component calls", (view) => {
    const code = compile(readFileSync(join(SRC, view), "utf-8"), view);
    expect(code, `${view} compiled without a solid-js/web import`).toContain(
      'from "solid-js/web"',
    );
    if (MARKUP.has(view)) expect(code).toContain("_$template(");
    expect(code, `${view} was compiled by a jsx-runtime transform`).not.toContain(
      "jsx-runtime",
    );
  });

  it("keeps a dynamic read OUT of the component body", () => {
    const code = compile(
      "export function N(props: { count: number }) { return <p class='n'>{props.count}</p>; }",
      "probe.tsx",
    );
    expect(code).toContain("_$insert(");
    expect(code, "the signal read stayed in the component body").toMatch(
      /=>\s*props\.count/,
    );
  });

  it("makes a Show branch re-buildable", () => {
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
