import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { compileSolid as compile } from "../../../../scripts/solidJsx";

const SRC = import.meta.dirname;

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
