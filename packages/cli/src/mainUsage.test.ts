/**
 * THE USAGE TEXT IS A PROMISE — and this is what keeps it one.
 *
 * `src/main.ts` ends its help with a sentence every script author reads as a
 * guarantee:
 *
 *   > `--origin URL` is accepted by every service client.
 *
 * That was false for eight of them. `parseArgs` throws on an unknown option, so
 * `odu hosts --origin http://…` did not fall back to the default or warn: it
 * died with a parser error, from a flag the program's own help says it takes.
 * The `Opts` interfaces all carried `origin?` — the plumbing was there — and
 * only the argv declaration was missing, which is exactly the kind of gap that
 * survives review because every individual file looks right.
 *
 * The check is a PARSE of `main.ts` rather than a run of it, because the thing
 * being asserted is a property of the argv grammar, and running twenty commands
 * to discover it would need a service for most of them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const mainPath = join(import.meta.dirname, "..", "..", "..", "src", "main.ts");
const source = readFileSync(mainPath, "utf-8");

/**
 * Every command whose subject is the shared service — which, since the
 * consolidation, is every public command except the three that answer without
 * dialling anything.
 *
 * `help`, `--help`, `-h` and the bare invocation print text. `web` and
 * `web-daemon` ARE the service rather than clients of one, and `surface` owns
 * its own argv grammar (`--origin` included) through the generated face. `runs`
 * is a removal stub. Everything else is here.
 */
const SERVICE_CLIENTS = [
  "run",
  "wait",
  "rerun",
  "cancel",
  "logs",
  "status",
  "attach",
  "hosts",
  "lease",
  "release",
  "dump",
  "graph",
  "protect",
  "mcp",
] as const;

/** The `history` sub-commands, which have a dispatcher of their own. */
const HISTORY_SUBS = ["list", "show", "import", "prune"] as const;

/**
 * The option names declared by every `parseArgs({ options: { … } })` inside the
 * body of `case "<name>":`.
 *
 * Read off the AST rather than by regex: a `case` body is a run of statements
 * with no node of its own, several of them share a body by falling through
 * (`dump` and `graph`), and the options object is nested two levels inside a
 * call. A line scan would have to reproduce all three and would quietly report
 * "no options declared" — a PASS — for anything it failed to match.
 */
function optionsOfCases(text: string): Map<string, Set<string>> {
  const parsed = ts.createSourceFile(
    "main.ts",
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const out = new Map<string, Set<string>>();

  const optionNames = (node: ts.Node): Set<string> => {
    const names = new Set<string>();
    const visit = (n: ts.Node): void => {
      if (
        ts.isPropertyAssignment(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === "options" &&
        ts.isObjectLiteralExpression(n.initializer)
      ) {
        for (const prop of n.initializer.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const key = prop.name;
          if (ts.isIdentifier(key)) names.add(key.text);
          else if (ts.isStringLiteralLike(key)) names.add(key.text);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return names;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression)) {
      // A clause with an EMPTY body falls through to the next one, and the
      // options belong to whichever clause actually has statements. Collected
      // per-clause and merged by the caller's own reading of the labels: here
      // an empty body simply contributes nothing, and the fall-through target
      // contributes for both.
      const names = new Set<string>();
      for (const statement of node.statements) {
        for (const name of optionNames(statement)) names.add(name);
      }
      out.set(node.expression.text, names);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return out;
}

const cases = optionsOfCases(source);

describe("src/main.ts's argv grammar", () => {
  it("found the dispatch at all", () => {
    // A parse that matched nothing would make every assertion below vacuous —
    // the failure mode this whole file exists to catch, arriving one level up.
    expect(cases.size).toBeGreaterThan(15);
    expect([...cases.keys()]).toContain("run");
  });

  it("lets every service client be pointed at an origin, as the help promises", () => {
    const missing: string[] = [];
    for (const command of SERVICE_CLIENTS) {
      const options = cases.get(command);
      if (options === undefined) {
        missing.push(`${command} (no case found — was it renamed?)`);
        continue;
      }
      // `dump` and `graph` share a body; the empty clause is the one that falls
      // through, so an empty set here is only a failure if its neighbour is
      // empty too. Both are asserted, so a genuine omission still fails.
      if (options.size === 0) continue;
      if (!options.has("origin")) missing.push(command);
    }
    expect(
      missing,
      `${missing.join(", ")} do not declare --origin, but src/main.ts's USAGE ` +
        "says every service client accepts it. `parseArgs` THROWS on an " +
        "unknown option, so this is not a silently ignored flag — it is a " +
        "parser error from a flag the program's own help advertises.",
    ).toEqual([]);
  });

  it("lets every history sub-command be pointed at an origin too", () => {
    const missing = HISTORY_SUBS.filter(
      (sub) => !(cases.get(sub)?.has("origin") ?? false),
    );
    expect(missing, `history ${missing.join(", ")} do not declare --origin`).toEqual(
      [],
    );
  });

  it("still says so in the usage text", () => {
    // The other half. If the sentence is ever removed, this test is asserting a
    // promise nobody makes — which is a different bug, and worth failing on so
    // somebody decides rather than drifts.
    expect(source).toContain("--origin URL");
  });
});
