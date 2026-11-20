import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const theme = readFileSync(
  join(import.meta.dirname, "..", "..", "face", "src", "theme.tsx"),
  "utf-8",
);
const shell = readFileSync(join(import.meta.dirname, "index.html"), "utf-8");

const KEY = /export const THEME_KEY = "([^"]+)"/.exec(theme)?.[1];

describe("the shell's pre-paint theme script", () => {
  it("is written against the key @odu/face owns", () => {
    expect(KEY, "@odu/face's ./theme no longer exports a THEME_KEY literal").toBeDefined();
    expect(
      shell,
      `the shell's boot script does not read ${String(KEY)}, so a pinned theme ` +
        "is applied only after the bundle runs — which is one black frame on " +
        "every navigation for anyone who chose light.",
    ).toContain(`localStorage.getItem("${String(KEY)}")`);
  });

  it("writes the attribute the stylesheet's two pins read", () => {
    expect(shell).toContain('setAttribute("data-theme", t)');
    expect(shell).toContain('t === "light" || t === "dark"');
  });
});
