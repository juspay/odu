/**
 * THE ONE STRING A BUNDLE AND A BOOT SCRIPT BOTH HAVE TO KNOW.
 *
 * `@odu/face`'s `./theme` remembers which theme a person pinned under
 * `THEME_KEY`. The shell's `<head>` reads the SAME key in four lines of
 * blocking script, because a module bundle runs after the first paint and a
 * person who chose light would otherwise watch a black frame flash on every
 * navigation, forever.
 *
 * Those two cannot import each other — one is an inline `<script>` in an HTML
 * template, the other is a module in another package — so the key is written
 * twice. A test is the receptacle for exactly that shape, the same way
 * `./palette.test.ts` is for the favicon's colours: two restatements of one
 * decision, agreeing by something other than nobody's promise.
 *
 * It reads both files as TEXT rather than importing the module. The boot
 * script is not a module at all, and the thing being compared is the literal a
 * browser will actually execute — not a value a bundler might have rewritten.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const theme = readFileSync(
  join(import.meta.dirname, "..", "..", "face", "src", "theme.tsx"),
  "utf-8",
);
const shell = readFileSync(join(import.meta.dirname, "index.html"), "utf-8");

/** The key, read out of the module that owns it. */
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
    // `./theme.css` has exactly two pinning rules — `:root[data-theme="dark"]`
    // and `:root[data-theme="light"]` — and absence is the follow-the-OS
    // state. A boot script that wrote `data-theme="system"` would select
    // nothing and silently do the opposite of what it was asked.
    expect(shell).toContain('setAttribute("data-theme", t)');
    expect(shell).toContain('t === "light" || t === "dark"');
  });
});
