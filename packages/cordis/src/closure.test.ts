import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const packageRoot = join(import.meta.dirname, "..");

const MANIFEST = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf-8"),
) as { dependencies?: Record<string, string> };

const DECLARED = Object.keys(MANIFEST.dependencies ?? {});

const EXPECTED_DEPENDENCIES = ["effect"];

const UI_RUNTIMES = new Set(["solid-js", "react", "react-dom", "preact", "vue", "svelte", "@solid-primitives"]);

const HYDRATED = new Set<string>([
  "@kolu/surface",
  "@kolu/surface-app",
  "@kolu/surface-daemon",
  "@olai/effect-cordis",
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
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(path);
  }
  return out;
}

function specifiersIn(source: string, fileName: string): string[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const literal = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) out.push(node.text);
  };
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal(node.moduleSpecifier);
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

describe("@odu/cordis's import closure", () => {
  it("has sources to police", () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.flatMap((s) => s.specifiers).length).toBeGreaterThan(0);
  });

  it("names no @odu package at all", () => {
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (spec.startsWith("@odu/")) offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} names an @odu package. This module is what lets ` +
        "the host and its rows SHARE a vocabulary without naming each other; " +
        "one import here undoes exactly that.",
    ).toEqual([]);
  });

  it("imports no node builtin and nothing off the hydrated set", () => {
    const declared = new Set(DECLARED);
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      const isTest = rel.endsWith(".test.ts");
      for (const spec of specifiers) {
        if (spec.startsWith(".")) continue;
        if (isTest && spec.startsWith("node:")) continue;
        if (spec.startsWith("node:") && !isTest) {
          offenders.push(`${rel}: ${spec} (a node builtin)`);
          continue;
        }
        const pkg = packageOf(spec);
        if (
          UI_RUNTIMES.has(pkg) ||
          UI_RUNTIMES.has(pkg.split("/")[0] ?? pkg) ||
          spec.endsWith("/solid")
        ) {
          offenders.push(`${rel}: ${spec} (a UI runtime — it belongs in @odu/face)`);
          continue;
        }
        if (declared.has(pkg) || HYDRATED.has(pkg)) continue;
        if (isTest && TEST_ONLY.has(pkg)) continue;
        offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} is in neither this package's manifest nor the ` +
        "hydrated set.",
    ).toEqual([]);
  });

  it("declares no UI runtime", () => {
    const offenders = DECLARED.filter(
      (pkg) => UI_RUNTIMES.has(pkg) || UI_RUNTIMES.has(pkg.split("/")[0] ?? pkg),
    );
    expect(
      offenders,
      `${offenders.join(", ")} is a UI runtime in the contract's manifest — every ` +
        "server-side row would carry it. A face's shared helper belongs in @odu/face.",
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
