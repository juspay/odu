/**
 * THE WALL for what every row's face shares — and it is about absence.
 *
 * `@odu/face` is imported by two or more rows' faces and owned by none, so it
 * names NO `@odu/*` package (one would let a face reach another row through
 * it), nothing from `node:` (a browser bundle loads it), and costs exactly the
 * two installs a control needs.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const packageRoot = join(import.meta.dirname, "..");

const MANIFEST = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf-8"),
) as { dependencies?: Record<string, string> };

const DECLARED = Object.keys(MANIFEST.dependencies ?? {});

/** Pinned: the control's signals and the type of what it runs. */
const EXPECTED_DEPENDENCIES = ["effect", "solid-js"];

/** Nothing hydrated: a control needs no surface framework, only an `Effect`
 *  to run through the shell's edge. */
const HYDRATED = new Set<string>([]);

/** Test-only imports — the harness, not the shipped closure. */
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

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
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

describe("@odu/face's import closure", () => {
  it("has sources to police", () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.flatMap((s) => s.specifiers).length).toBeGreaterThan(0);
  });

  it("names no @odu package at all", () => {
    // THE CLAIM: a helper that named one row would let every face that imports
    // it reach that row.
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (spec.startsWith("@odu/")) offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} names an @odu package — two rows' faces import ` +
        "this one, so a row named here is a row every one of them can reach.",
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
        // A browser bundle loads this module; `node:` would be a blank page.
        // (The suite itself reads the directory it polices, and is never
        // bundled — the `@odu/web-ui` twin records that exception.)
        if (spec.startsWith("node:") && !isTest) {
          offenders.push(`${rel}: ${spec} (a node builtin)`);
          continue;
        }
        const pkg = packageOf(spec);
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

  it("costs exactly these installs", () => {
    expect(
      DECLARED.slice().sort(),
      "the manifest's dependencies moved. Pinned here rather than left to " +
        "drift — update it deliberately.",
    ).toEqual(EXPECTED_DEPENDENCIES);
  });
});
