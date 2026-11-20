import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const mainPath = join(import.meta.dirname, "..", "..", "..", "src", "main.ts");
const source = readFileSync(mainPath, "utf-8");
const ciPath = join(import.meta.dirname, "ciCli.ts");
const ciSource = readFileSync(ciPath, "utf-8");

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

const ROOT_CLIENTS = ["mcp"] as const;

const HISTORY_SUBS = ["list", "show", "import", "prune"] as const;

function optionsByCaseLabel(text: string): Map<string, Set<string>> {
  const parsed = ts.createSourceFile(
    "dispatch.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
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

  const fallingThrough: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression)) {
      const label = node.expression.text;
      if (node.statements.length === 0) {
        fallingThrough.push(label);
      } else {
        const names = new Set<string>();
        for (const statement of node.statements) {
          for (const name of optionNames(statement)) names.add(name);
        }
        for (const sharing of [...fallingThrough, label]) out.set(sharing, names);
        fallingThrough.length = 0;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return out;
}

const cases = optionsByCaseLabel(source);
const ciCases = optionsByCaseLabel(ciSource);

describe("odu's argv grammar", () => {
  it("found both dispatches at all", () => {
    expect([...ciCases.keys()]).toContain("run");
    expect(ciCases.size).toBeGreaterThan(15);
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
    expect(source).toContain("--origin URL");
    expect(ciSource).toContain("--origin URL");
  });

  it("keeps no retired command at the root", () => {
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
