import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const packageRoot = join(import.meta.dirname, "..");

const MANIFEST = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf-8"),
) as {
  dependencies?: Record<string, string>;
  sideEffects?: false | readonly string[];
};

const DECLARED = Object.keys(MANIFEST.dependencies ?? {});

const EXPECTED_DEPENDENCIES = ["effect"];

const HYDRATED = new Set(["@kolu/surface"]);

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

function sideEffectImportsIn(source: string, fileName: string): string[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  return parsed.statements
    .filter(
      (node): node is ts.ImportDeclaration =>
        ts.isImportDeclaration(node) && node.importClause === undefined,
    )
    .flatMap((node) =>
      ts.isStringLiteralLike(node.moduleSpecifier)
        ? [node.moduleSpecifier.text]
        : [],
    );
}

function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
}

interface Scanned {
  readonly rel: string;
  readonly specifiers: readonly string[];
  readonly sideEffectImports: readonly string[];
}

const sources: Scanned[] = tsFilesUnder(join(packageRoot, "src"))
  .map((full) => relative(packageRoot, full).split(sep).join("/"))
  .sort()
  .map((rel) => {
    const source = readFileSync(join(packageRoot, rel), "utf-8");
    return {
      rel,
      specifiers: specifiersIn(source, rel),
      sideEffectImports: sideEffectImportsIn(source, rel).map((spec) => {
        if (!spec.startsWith(".")) return spec;
        const path = join(rel, "..", spec).split(sep).join("/");
        return `./${path.endsWith(".ts") ? path : `${path}.ts`}`;
      }),
    };
  });

describe("@odu/run-client's import closure", () => {
  it("has sources to police", () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.flatMap((s) => s.specifiers).length).toBeGreaterThan(0);
  });

  it("sees the spellings a line scan misses", () => {
    const evasive = [
      'import {\n  a,\n} from "multiline/pkg";',
      'import\n  type { B }\n  from\n  "wrapped/pkg";',
      'const m = await import("dynamic/pkg");',
      'type T = import("typeposition/pkg").X;',
    ].join("\n");
    expect(specifiersIn(evasive, "evasive.ts").sort()).toEqual([
      "dynamic/pkg",
      "multiline/pkg",
      "typeposition/pkg",
      "wrapped/pkg",
    ]);
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
        "here and be a missing module there. Either the module belongs in the " +
        "package, or the value it wants should be passed in.",
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
        "hydrated @kolu/* set this test pins. Declare it (and check what it " +
        "costs every consumer's install) or hydrate it — a new @kolu/* is a " +
        "new directory every downstream must copy, so widening HYDRATED is a " +
        "decision, not a formality.",
    ).toEqual([]);
  });

  it("never lets a bundler drop a module that exists for its effect", () => {
    const listed = new Set(
      MANIFEST.sideEffects === false ? [] : (MANIFEST.sideEffects ?? []),
    );
    const impure = new Set<string>();
    for (const { rel, sideEffectImports } of sources) {
      if (rel.endsWith(".test.ts")) continue;
      for (const target of sideEffectImports) {
        if (!target.startsWith("./")) continue;
        impure.add(target).add(`./${rel}`);
      }
    }
    const unlisted = [...impure].filter((m) => !listed.has(m)).sort();
    expect(
      unlisted,
      `${unlisted.join(", ")} is imported for its side effect but is not in ` +
        "the manifest's `sideEffects`. A bundler that trusts the manifest will " +
        "drop it, and the effect goes with it. List the module AND the file " +
        "that imports it, or stop relying on the effect.",
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
