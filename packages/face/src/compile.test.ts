import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { compileSolid as compile } from "../../../scripts/solidJsx";

const SRC = import.meta.dirname;

const VIEWS = readdirSync(SRC)
  .filter((entry) => entry.endsWith(".tsx"))
  .sort();

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
    const body = code.slice(start, code.indexOf("function TitleTooltip(props)", start));
    const effect = body.indexOf("_$effect(");
    expect(effect, "Button compiled with no effect at all").toBeGreaterThan(-1);
    expect(
      body.indexOf("props.disabled"),
      "Button's `disabled` is read before its first effect, so it is read once " +
        "and frozen — a busy control would stay pressable.",
    ).toBeGreaterThan(effect);
  });
});
