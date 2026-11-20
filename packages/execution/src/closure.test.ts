import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const packageRoot = join(import.meta.dirname, "..");

const MANIFEST = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf-8"),
) as { dependencies?: Record<string, string> };

const DECLARED = Object.keys(MANIFEST.dependencies ?? {});

const EXPECTED_DEPENDENCIES = [
  "@odu/cache",
  "@odu/run-client",
  "@odu/run-history",
  "effect",
];

const HYDRATED = new Set<string>([
  "@kolu/log",
  "@kolu/shell-quote",
  "@kolu/surface",
  "@kolu/surface-remote",
  "@kolu/surface-daemon-supervisor",
]);

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

describe("@odu/execution's import closure", () => {
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

  it("imports only what its manifest and the hydrated set provide", () => {
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

  it("never imports a FACE", () => {
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (packageOf(spec) === "@odu/cli") offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(offenders, offenders.join(", ")).toEqual([]);
  });

  it("reaches the cache row through its PUSH DOOR and nothing else", () => {
    const allowed: Record<string, true> = { "@odu/cache/push": true };
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (packageOf(spec) !== "@odu/cache") continue;
        if (allowed[spec] === true) continue;
        offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} reaches into @odu/cache past its \`./push\` ` +
        "door. The engine is a CLIENT of a cache's HTTP API; it is not a " +
        "consumer of the cache row.",
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
