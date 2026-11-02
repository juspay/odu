/**
 * THE ONE THING THAT MUST NEVER APPEAR IN AN ACTION FILE: a workflow
 * expression anywhere but where the action itself is wired.
 *
 * GitHub evaluates `${{ … }}` while PARSING `action.yml` — in descriptions,
 * in comments, in any string — and while parsing, the `github` context does
 * not exist. One such expression refuses the WHOLE action with
 * `Unrecognized named-value: github`, so every repository that uses it goes
 * red at once, before a single step runs. That is what happened to kolu, olai
 * and agent-distro the day this action's `pin:` description documented its
 * own one-line example.
 *
 * The rule is narrow and mechanical, because the failure is: an expression in
 * `action.yml` may name `inputs.` and nothing else. `inputs` is the one
 * context an action's own `runs:` is evaluated with; everything a CALLER
 * writes — `github`, `secrets`, `matrix` — belongs in a workflow, and in the
 * README where it can be read.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ACTIONS = join(import.meta.dirname, "..", ".github", "actions");

/** Every `action.yml` this repository ships. */
const actionFiles = (): string[] =>
  readdirSync(ACTIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(ACTIONS, entry.name, "action.yml"));

/** Every `${{ … }}` in a file, with the line it sits on. */
function expressions(source: string): { line: number; text: string }[] {
  return source.split("\n").flatMap((line, at) =>
    [...line.matchAll(/\$\{\{([^}]*)\}\}/g)].map((found) => ({
      line: at + 1,
      text: (found[1] ?? "").trim(),
    })),
  );
}

describe("the action files this repository ships", () => {
  it("name only `inputs` in an expression, because the rest refuses the action", () => {
    const files = actionFiles();
    // Non-vacuity: there IS an action to check, and it DOES use expressions.
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((file) =>
      expressions(readFileSync(file, "utf-8"))
        .filter((found) => !found.text.startsWith("inputs."))
        .map((found) => `${file}:${found.line}: \${{ ${found.text} }}`),
    );
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : "an action.yml may only interpolate `inputs.…`; GitHub evaluates every other " +
          "expression at parse time, where `github` and `secrets` do not exist, and refuses " +
          "the whole action. Describe it in words here and keep the literal line in the README:\n" +
          offenders.join("\n"),
    ).toEqual([]);
    expect(
      files.some((file) => expressions(readFileSync(file, "utf-8")).length > 0),
    ).toBe(true);
  });
});
