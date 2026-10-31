/**
 * THE WALL, enforced — and this package's claim is the SHORTEST in the tree.
 *
 * `@odu/cordis` is the vocabulary `@odu/host` and its rows share, and the whole
 * reason it exists is that neither side may name the other: the host is the
 * registry (a row may not import it), and a row's own package cannot hold the
 * tags its siblings need. So this module names NO `@odu/*` package at all — a
 * single one would undo it in a line — and, being a module a BROWSER bundle and
 * a server both load, nothing from `node:` either.
 *
 * Two claims, and both are about absence, which makes the non-vacuity floors
 * below the load-bearing part: a walker that found no files would pass both.
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

/** Pinned: one install, and no `@odu/*` at all. */
const EXPECTED_DEPENDENCIES = ["effect"];

/** UI RUNTIMES, refused by name beside the `node:` rule. This package is the
 *  contract every server-side row and the host load; a reactive UI helper is
 *  not vocabulary they share, and putting one here put a UI runtime in every
 *  server's manifest (review 2 of PR 2.5). A face's shared helpers live in
 *  `@odu/face`. */
const UI_RUNTIMES = new Set(["solid-js", "react", "react-dom", "preact", "vue", "svelte", "@solid-primitives"]);

/** The `@kolu/*` sources hydrated from a Nix pin rather than installed. */
const HYDRATED = new Set<string>([
  "@kolu/surface",
  "@kolu/surface-app",
  // `Logger`, the type the `Log` tag carries.
  "@kolu/surface-daemon",
  "@olai/effect-cordis",
]);

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

describe("@odu/cordis's import closure", () => {
  it("has sources to police", () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.flatMap((s) => s.specifiers).length).toBeGreaterThan(0);
  });

  it("names no @odu package at all", () => {
    // THE CLAIM. A tag, a row record or a composition helper that imported one
    // row's package would make this the thing a row cannot import — which is
    // the whole design.
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
        // A browser bundle loads this module; `node:` would be a blank page.
        // (The suite itself reads the directory it polices, and is never
        // bundled — the `@odu/web-ui` twin records that exception.)
        if (spec.startsWith("node:") && !isTest) {
          offenders.push(`${rel}: ${spec} (a node builtin)`);
          continue;
        }
        const pkg = packageOf(spec);
        // The surface framework's Solid binding is a UI runtime too, under a
        // hydrated package whose other doors this module may open.
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
