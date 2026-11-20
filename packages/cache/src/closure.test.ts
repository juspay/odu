import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const packageRoot = join(import.meta.dirname, "..");

const MANIFEST = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf-8"),
) as { dependencies?: Record<string, string> };

const DECLARED = Object.keys(MANIFEST.dependencies ?? {});

const EXPECTED_DEPENDENCIES = ["@odu/cordis", "@odu/credentials", "@odu/face", "@odu/objects", "effect", "solid-js"];

const HYDRATED = new Set<string>([
  "@kolu/surface",
  "@olai/effect-cordis",
]);

const BUN_BUILTINS = new Set(["bun:sqlite"]);

const FORBIDDEN = new Set([
  "@odu/service",
  "@odu/execution",
  "@odu/cli",
  "@odu/run-history",
  "@odu/service-client",
]);

const TEST_ONLY = new Set([
  "bun:test",
  "typescript",
  "@babel/core",
  "@babel/preset-typescript",
  "babel-preset-solid",
  "@kolu/surface-daemon",
]);

const POLICED_EXTENSIONS = [".ts", ".tsx"] as const;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...tsFilesUnder(path));
      continue;
    }
    if (POLICED_EXTENSIONS.some((extension) => entry.endsWith(extension))) out.push(path);
  }
  return out;
}

function specifiersIn(source: string, fileName: string): string[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    // TSX or TS by extension. TypeScript's parser resolves `<T>(x) => x` one way
    // in a `.ts` and another in a `.tsx`, so a JSX file parsed as TS produces a
    // tree with the imports still in it and the markup mangled — a policing
    // test that keeps passing while seeing less than it thinks.
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
    // TSX or TS by extension. TypeScript's parser resolves `<T>(x) => x` one way
    // in a `.ts` and another in a `.tsx`, so a JSX file parsed as TS produces a
    // tree with the imports still in it and the markup mangled — a policing
    // test that keeps passing while seeing less than it thinks.
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

const sources = tsFilesUnder(join(packageRoot, "src"))
  .map((full) => relative(packageRoot, full).split(sep).join("/"))
  .sort()
  .map((rel) => ({
    rel,
    source: readFileSync(join(packageRoot, rel), "utf-8"),
    specifiers: specifiersIn(readFileSync(join(packageRoot, rel), "utf-8"), rel),
  }));

describe("@odu/cache's import closure", () => {
  it("has sources to police", () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.flatMap((s) => s.specifiers).length).toBeGreaterThan(0);
  });

  it("never reaches out of the package directory", () => {
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (!spec.startsWith(".")) continue;
        if (join(rel, "..", spec).startsWith("..")) {
          offenders.push(`${rel}: ${spec}`);
        }
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} climbs out of the package with a relative ` +
        "import. A package boundary that a `../..` can step over is a folder.",
    ).toEqual([]);
  });

  it("imports only what its manifest and the declared builtins provide", () => {
    const declared = new Set(DECLARED);
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      const isTest = rel.endsWith(".test.ts");
      for (const spec of specifiers) {
        if (spec.startsWith(".") || spec.startsWith("node:")) continue;
        if (BUN_BUILTINS.has(spec)) continue;
        const pkg = packageOf(spec);
        if (declared.has(pkg) || HYDRATED.has(pkg)) continue;
        if (isTest && TEST_ONLY.has(pkg)) continue;
        offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} is in neither this package's manifest nor the ` +
        "builtin set this test pins.",
    ).toEqual([]);
  });

  it("is at the bottom of the wall, and never reaches up it", () => {
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (FORBIDDEN.has(packageOf(spec))) offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} reaches UP the wall. The cache is served by the ` +
        "root and administered through the service; it never imports either.",
    ).toEqual([]);
  });

  it("reads no environment of its own", () => {
    const offenders = sources
      .filter(({ rel }) => !rel.endsWith(".test.ts"))
      .filter(({ rel }) => rel !== "src/cli.ts")
      .filter(({ source, rel }) => readsProcessEnv(source, rel))
      .map(({ rel }) => rel);
    expect(
      offenders,
      `${offenders.join(", ")} reads process.env. Configuration arrives as ` +
        "arguments from the composition root.",
    ).toEqual([]);
  });

  it("costs exactly these installs", () => {
    expect(
      DECLARED.slice().sort(),
      "the manifest's dependencies moved. Pinned here rather than left to " +
        "drift — update it deliberately.",
    ).toEqual(EXPECTED_DEPENDENCIES);
  });
});
