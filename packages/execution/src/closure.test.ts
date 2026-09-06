/**
 * The WALL, enforced — what this package is allowed to import.
 *
 * Same instrument as the other members carry, and deliberately a SIBLING
 * rather than a shared helper: each package must be able to state its own
 * closure from inside its own directory, because that directory is the unit
 * the boundary is about. A guard imported from a neighbour is a guard that
 * only reaches as far as the neighbour does.
 *
 * What this one asserts that the others cannot: the engine never imports a
 * FACE. That is the property PR 2's service is built on.
 *
 * The walk is a PARSE, not a line scan, and TYPE-ONLY EDGES COUNT — see the
 * `@odu/run-client` twin for both arguments.
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

/** Pinned as a literal set: every entry is a wall this package leans on. */
const EXPECTED_DEPENDENCIES = ["@odu/run-client", "@odu/run-history", "effect"];

/** The `@kolu/*` sources hydrated from a Nix pin rather than installed — a
 *  manifest cannot name them (see the root bunfig.toml), so the set is pinned
 *  here instead. A NEW one is a new directory the packaging must copy. */
const HYDRATED = new Set<string>([
  "@kolu/log",
  "@kolu/shell-quote",
  "@kolu/surface",
  "@kolu/surface-remote",
  // The survivable-spawn spine (`coordinator/spawn.ts`). Its own manifest
  // drags `@kolu/surface-daemon` and `osfacts-client` along, and the second is
  // grafted from a SEPARATE upstream (juspay/osfacts) because kolu gitignores
  // it — see nix/overlay.nix. Neither is imported by odu; both are hydrated
  // because hydration is per-package.
  "@kolu/surface-daemon-supervisor",
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
    if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Every module specifier a consumer's compiler would have to resolve: static
 *  imports and re-exports (`import type` included), `import x = require("…")`,
 *  dynamic `import()`, and `import("…").T` in type position. */
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
    // The claim this package makes, and the reason PR 2 can serve this engine
    // from something that is not a terminal: `@odu/cli` carries a renderer and
    // a terminal emulator, and an engine that reached for one would drag both
    // into every consumer's closure. Watched-ness arrives through
    // `common/presentation.ts` instead, and `RunDeps.face` defaults to silence.
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (packageOf(spec) === "@odu/cli") offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(offenders, offenders.join(", ")).toEqual([]);
  });


  it("costs exactly these installs", () => {
    expect(
      DECLARED.slice().sort(),
      "the manifest's dependencies moved. Pinned here rather than left to " +
        "drift — update it deliberately.",
    ).toEqual(EXPECTED_DEPENDENCIES);
  });
});
