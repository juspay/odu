import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const packageRoot = join(import.meta.dirname, "..");

const MANIFEST = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as {
  dependencies?: Record<string, string>;
};

const BUN_BUILTINS = new Set(["bun"]);

const TEST_ONLY = new Set(["bun:test", "typescript"]);

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...tsFilesUnder(path));
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(path);
  }
  return out;
}

function specifiersIn(source: string, fileName: string): string[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    // TypeScript's parser resolves `<T>(x) => x` one way in a `.ts` and another
    // in a `.tsx`, so a JSX file parsed as TS produces a tree with the imports
    // still in it and the markup mangled.
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const literal = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) out.push(node.text);
  };
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      literal(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) literal(node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      literal(node.arguments[0]);
    }
    ts.forEachChild(node, walk);
  };
  walk(parsed);
  return out;
}

function readsProcessEnv(source: string, fileName: string): boolean {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    // TypeScript's parser resolves `<T>(x) => x` one way in a `.ts` and another
    // in a `.tsx`, so a JSX file parsed as TS produces a tree with the imports
    // still in it and the markup mangled.
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let found = false;
  const walk = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "env" &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process"
    ) {
      found = true;
    }
    ts.forEachChild(node, walk);
  };
  walk(parsed);
  return found;
}

function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
}

const sources = [...tsFilesUnder(join(packageRoot, "src")), ...tsFilesUnder(join(packageRoot, "test"))]
  .map((full) => relative(packageRoot, full).split(sep).join("/"))
  .sort()
  .map((rel) => {
    const source = readFileSync(join(packageRoot, rel), "utf-8");
    return { rel, source, specifiers: specifiersIn(source, rel) };
  });

const isHarness = (rel: string): boolean => rel.endsWith(".test.ts") || rel.startsWith("test/");

describe("@odu/objects's import closure", () => {
  it("has sources to police", () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.flatMap((s) => s.specifiers).length).toBeGreaterThan(0);
  });

  it("never reaches out of the package directory", () => {
    const offenders = sources.flatMap(({ rel, specifiers }) =>
      specifiers.filter((spec) => spec.startsWith(".") && join(rel, "..", spec).startsWith("..")).map((spec) => `${rel}: ${spec}`),
    );
    expect(offenders, `${offenders.join(", ")} climbs out of the package with a relative import.`).toEqual([]);
  });

  it("imports no @odu package — not the cache, not any row", () => {
    const offenders = sources.flatMap(({ rel, specifiers }) =>
      specifiers.filter((spec) => spec.startsWith("@odu/")).map((spec) => `${rel}: ${spec}`),
    );
    expect(
      offenders,
      `${offenders.join(", ")} reaches into odu. A store knows keys and bytes; ` +
        "what they mean is its caller's, and the arrow runs cache → objects only.",
    ).toEqual([]);
  });

  it("imports only builtins, and the harness only in tests", () => {
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (spec.startsWith(".") || spec.startsWith("node:") || BUN_BUILTINS.has(spec)) continue;
        if (isHarness(rel) && TEST_ONLY.has(packageOf(spec))) continue;
        offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(offenders, `${offenders.join(", ")} is not a builtin this package may use.`).toEqual([]);
  });

  it("reads no environment", () => {
    const offenders = sources
      .filter(({ rel }) => !isHarness(rel))
      .filter(({ source, rel }) => readsProcessEnv(source, rel))
      .map(({ rel }) => rel);
    expect(offenders, `${offenders.join(", ")} reads process.env.`).toEqual([]);
  });

  it("installs nothing", () => {
    expect(Object.keys(MANIFEST.dependencies ?? {})).toEqual([]);
  });
});
