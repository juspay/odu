import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const packageRoot = join(import.meta.dirname, "..");

const MANIFEST = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf-8"),
) as { dependencies?: Record<string, string> };

const DECLARED = Object.keys(MANIFEST.dependencies ?? {});

const EXPECTED_DEPENDENCIES = ["@odu/run-client", "@odu/run-history", "effect"];

const HYDRATED = new Set<string>([
  "@kolu/surface",
  "@kolu/surface-app",
  "@kolu/surface-daemon",
]);

const NODE_ONLY = new Set(["src/socket.ts"]);

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
    if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

function specifiersIn(source: string, fileName: string): string[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
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
    specifiers: specifiersIn(readFileSync(join(packageRoot, rel), "utf-8"), rel),
  }));

describe("@odu/service-client's import closure", () => {
  it("has sources to police", () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.flatMap((s) => s.specifiers).length).toBeGreaterThan(0);
  });

  it("never reaches back into odu", () => {
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
      `${offenders.join(", ")} imports out of the package directory.`,
    ).toEqual([]);
  });

  it("imports only what a consumer will have", () => {
    const declared = new Set(DECLARED);
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      const isTest = rel.endsWith(".test.ts");
      for (const spec of specifiers) {
        if (spec.startsWith(".") || spec.startsWith("node:")) continue;
        const pkg = packageOf(spec);
        if (declared.has(pkg) || HYDRATED.has(pkg)) continue;
        if (isTest && TEST_ONLY.has(pkg)) continue;
        offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} is in neither this package's manifest nor the ` +
        "hydrated @kolu/* set this test pins.",
    ).toEqual([]);
  });

  it("never imports a node builtin outside the declared node-only modules", () => {
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      if (rel.endsWith(".test.ts") || NODE_ONLY.has(rel)) continue;
      for (const spec of specifiers) {
        if (spec.startsWith("node:")) offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} imports a node builtin. Platform I/O belongs ` +
        "either one wall up, in @odu/service, or in a module declared in " +
        "NODE_ONLY — a browser tab reaching it is a blank page.",
    ).toEqual([]);
  });

  it("keeps the node-only modules out of a browser's reach", () => {
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      if (rel.endsWith(".test.ts") || NODE_ONLY.has(rel)) continue;
      for (const spec of specifiers) {
        const target = normalize(join(dirname(rel), spec));
        const file = target.endsWith(".ts") ? target : `${target}.ts`;
        if (NODE_ONLY.has(file)) offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} reaches a NODE_ONLY module from a module a ` +
        "browser may import.",
    ).toEqual([]);
  });

  it("reaches run-history's portable half, plus the state root from the node-only module", () => {
    const portable = new Set(["@odu/run-history/schema", "@odu/run-history/ids"]);
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (packageOf(spec) !== "@odu/run-history") continue;
        if (portable.has(spec)) continue;
        if (spec === "@odu/run-history/paths" && NODE_ONLY.has(rel)) continue;
        offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} reaches a platform subpath of @odu/run-history. ` +
        "Only ./schema and ./ids are portable; ./paths is for src/socket.ts alone.",
    ).toEqual([]);
  });

  it("does not import the service or the engine", () => {
    const forbidden = new Set(["@odu/service", "@odu/execution", "@odu/cli"]);
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (forbidden.has(packageOf(spec))) offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} reaches UP the wall. This package is the ` +
        "contract; the things that implement it depend on it, never the reverse.",
    ).toEqual([]);
  });

  it("costs a consumer exactly these installs", () => {
    expect(
      DECLARED.slice().sort(),
      "the manifest's dependencies moved. Every entry is an install in every " +
        "downstream that hydrates this package, so the list is pinned here " +
        "rather than left to drift — update it deliberately.",
    ).toEqual(EXPECTED_DEPENDENCIES);
  });
});
