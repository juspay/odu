/**
 * THE USAGE TEXT IS A PROMISE — and this is what keeps it one.
 *
 * Both dispatchers end their help with a sentence every script author reads as
 * a guarantee:
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
 * There are TWO grammars to read now: the root (`src/main.ts`) names rows and
 * the service, and the runs' row names its own verbs (`./ciCli`). The promise
 * is the same in both, so both are parsed.
 *
 * The check is a PARSE rather than a run, because the thing being asserted is
 * a property of the argv grammar, and running twenty commands to discover it
 * would need a service for most of them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const mainPath = join(import.meta.dirname, "..", "..", "..", "src", "main.ts");
const source = readFileSync(mainPath, "utf-8");
const ciPath = join(import.meta.dirname, "ciCli.ts");
const ciSource = readFileSync(ciPath, "utf-8");

/**
 * Every verb of the runs' row — which, since the consolidation, is every one
 * of them: each is a client of the shared service, and `--origin` is how a
 * caller points one at a server that is not this machine's default.
 *
 * `help`, `--help`, `-h` and the bare invocation print text; `history` is a
 * dispatcher whose four sub-commands are checked separately below.
 */
const CI_CLIENTS = [
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
] as const;

/**
 * The root's own service clients.
 *
 * `ci`, `cache` and `auth` are ROWS: they take a word and hand the rest to the
 * row's face, which declares the flag itself (`odu cache use --origin …`), so
 * the root case has no `parseArgs` of its own to check. `web` and `web-daemon`
 * ARE the service rather than clients of one, and `surface` owns its whole
 * argv grammar — `--origin` included — through the generated face.
 */
const ROOT_CLIENTS = ["mcp"] as const;

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
    "dispatch.ts",
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
const ciCases = optionsOfCases(ciSource);

describe("odu's argv grammar", () => {
  it("found both dispatches at all", () => {
    // A parse that matched nothing would make every assertion below vacuous —
    // the failure mode this whole file exists to catch, arriving one level up.
    expect([...ciCases.keys()]).toContain("run");
    expect(ciCases.size).toBeGreaterThan(15);
    // The root is small on purpose: one word per row, plus the service.
    expect([...cases.keys()]).toContain("ci");
    expect([...cases.keys()]).toContain("mcp");
  });

  it("lets every service client be pointed at an origin, as the help promises", () => {
    const missing: string[] = [];
    for (const [command, parsedCases, where] of [
      ...CI_CLIENTS.map((c) => [c, ciCases, "odu ci"] as const),
      ...ROOT_CLIENTS.map((c) => [c, cases, "odu"] as const),
    ]) {
      const options = parsedCases.get(command);
      if (options === undefined) {
        missing.push(`${where} ${command} (no case found — was it renamed?)`);
        continue;
      }
      // `dump` and `graph` share a body; the empty clause is the one that falls
      // through, so an empty set here is only a failure if its neighbour is
      // empty too. Both are asserted, so a genuine omission still fails.
      if (options.size === 0) continue;
      if (!options.has("origin")) missing.push(`${where} ${command}`);
    }
    expect(
      missing,
      `${missing.join(", ")} do not declare --origin, but the usage text ` +
        "says every service client accepts it. `parseArgs` THROWS on an " +
        "unknown option, so this is not a silently ignored flag — it is a " +
        "parser error from a flag the program's own help advertises.",
    ).toEqual([]);
  });

  it("lets every history sub-command be pointed at an origin too", () => {
    const missing = HISTORY_SUBS.filter(
      (sub) => !(ciCases.get(sub)?.has("origin") ?? false),
    );
    expect(missing, `history ${missing.join(", ")} do not declare --origin`).toEqual(
      [],
    );
  });

  it("still says so in both usage texts", () => {
    // The other half. If the sentence is ever removed, this test is asserting a
    // promise nobody makes — which is a different bug, and worth failing on so
    // somebody decides rather than drifts.
    expect(source).toContain("--origin URL");
    expect(ciSource).toContain("--origin URL");
  });

  it("keeps no retired command at the root", () => {
    // THE RETIREMENT, FROM THE OTHER SIDE (PLAN 2.10). A row's verb typed bare
    // is an unknown command, and a `case` that quietly came back — as an alias,
    // or as a "just this one" exception — is the drift this step removes.
    for (const retired of [
      "run",
      "wait",
      "rerun",
      "cancel",
      "logs",
      "history",
      "status",
      "attach",
      "hosts",
      "lease",
      "release",
      "dump",
      "graph",
      "protect",
      "runs",
      "cloudflare",
    ]) {
      expect(
        [...cases.keys()],
        `odu ${retired} is a row's verb (or a spelling that is gone); the root ` +
          "names rows and the service, and nothing else.",
      ).not.toContain(retired);
    }
  });
});
