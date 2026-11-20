import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const packageRoot = join(import.meta.dirname, "..");

const MANIFEST = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf-8"),
) as { dependencies?: Record<string, string> };

const DECLARED = Object.keys(MANIFEST.dependencies ?? {});

const EXPECTED_DEPENDENCIES = ["@odu/run-client", "effect"];

const HYDRATED = new Set<string>([]);

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
    /* setParentNodes */ false,
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

describe("@odu/run-history's import closure", () => {
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
      `${offenders.join(", ")} imports out of the package directory. A consumer ` +
        "hydrates THIS directory and nothing else, so the import would resolve " +
        "here and be a missing module there.",
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
      `${offenders.join(", ")} is not in this package's manifest, nor in the ` +
        "hydrated set this test pins.",
    ).toEqual([]);
  });

  it("keeps the run-client arrow pointing one way", () => {
    const usesRunClient = sources.some(({ specifiers }) =>
      specifiers.some((s) => packageOf(s) === "@odu/run-client"),
    );
    expect(usesRunClient).toBe(true);

    const clientSrc = join(packageRoot, "..", "run-client", "src");
    const backEdges = tsFilesUnder(clientSrc)
      .map((full) => ({
        rel: relative(clientSrc, full),
        specifiers: specifiersIn(readFileSync(full, "utf-8"), full),
      }))
      .filter(({ specifiers }) =>
        specifiers.some((s) => packageOf(s) === "@odu/run-history"),
      )
      .map(({ rel }) => rel);
    expect(
      backEdges,
      `${backEdges.join(", ")} in @odu/run-client imports @odu/run-history. ` +
        "The lean client must stay lean: a consumer that only dials a live run " +
        "would then hydrate the whole durable catalog to do it.",
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
