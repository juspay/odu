/**
 * THE WALL, enforced — from inside the package it is about.
 *
 * Same instrument the other members carry, and deliberately a SIBLING rather
 * than a shared helper: each package states its own closure from inside its own
 * directory, because that directory is the unit the boundary is about. A guard
 * imported from a neighbour would be a guard that only reaches as far as the
 * neighbour does — and, worse, a package's closure test would then NAME another
 * `@odu/*` package, which is the very edge it is policing.
 *
 * The claim here is a COMPOSITION ROOT's, which is the one thing that makes this
 * package different from a row: it may name every row (that is its job) and it
 * may name the daemon's own parts, but it must name NOTHING it does not use. A
 * manifest is a claim about a closure, and a root that declared `@odu/execution`
 * while importing none of it is a claim that its build was going to be bigger
 * than it is. That is a drifting-document failure, so it is asserted both ways:
 * every declared `@odu/*` package is imported somewhere under `src/`, and every
 * `@odu/*` package imported under `src/` is declared.
 *
 * The walk is a PARSE, not a line scan, and TYPE-ONLY EDGES COUNT — see
 * `@odu/cache`'s twin for both arguments.
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

/** The `@odu/*` packages this manifest declares — the rows the roster names and
 *  the vocabulary both sides speak. Pinned so a package arriving or leaving is
 *  a diff somebody agrees to. */
const EXPECTED_ODU_DEPENDENCIES = [
  "@odu/auth",
  "@odu/cache",
  "@odu/ci",
  "@odu/cloudflare",
  "@odu/cordis",
  "@odu/launch",
  "@odu/run-history",
  "@odu/service-client",
];

/** The `@kolu/*` sources hydrated from a Nix pin rather than installed. */
const HYDRATED = new Set<string>([
  "@kolu/surface",
  "@kolu/surface-app",
  "@kolu/surface-daemon",
  "@kolu/surface-mcp",
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

/** Every module specifier a consumer's compiler would have to resolve: static
 *  imports and re-exports (`import type` included), `import x = require("…")`,
 *  dynamic `import()`, and `import("…").T` in type position. */
function specifiersIn(source: string, fileName: string): string[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
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
  .map((rel) => {
    const source = readFileSync(join(packageRoot, rel), "utf-8");
    return { rel, specifiers: specifiersIn(source, rel) };
  });

/** Every `@odu/*` package these sources name, tests included: a test that
 *  imports a row still needs the row installed. */
const named = new Set(
  sources
    .flatMap(({ specifiers }) => specifiers)
    .map(packageOf)
    .filter((pkg) => pkg.startsWith("@odu/")),
);

describe("@odu/host's import closure", () => {
  it("has sources to police", () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.flatMap((s) => s.specifiers).length).toBeGreaterThan(0);
  });

  it("declares exactly the @odu packages it imports", () => {
    const declaredOdu = DECLARED.filter((pkg) => pkg.startsWith("@odu/")).sort();
    expect(
      declaredOdu,
      "the manifest declares an @odu package these sources never import, or " +
        "imports one it does not declare. A composition root's dependency list " +
        "IS its closure; a row it stopped importing is a package its build no " +
        "longer needed and an entry somebody will believe.",
    ).toEqual([...named].sort());
    expect(declaredOdu).toEqual(EXPECTED_ODU_DEPENDENCIES);
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
        if (spec.startsWith("bun:") && isTest) continue;
        const pkg = packageOf(spec);
        if (declared.has(pkg) || HYDRATED.has(pkg)) continue;
        if (isTest && TEST_ONLY.has(pkg)) continue;
        offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} is in neither this package's manifest nor the ` +
        "set of hydrated pins this test names.",
    ).toEqual([]);
  });

  it("mounts rows without importing a row's internals", () => {
    // THE ROOT MAY NAME A ROW; it may not reach into one. A row's door is its
    // `exports` map, so what this asserts is that every row import goes through
    // a door rather than to a file behind it — the difference between composing
    // a row and knowing how it is built.
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (!spec.startsWith("@odu/") || spec === "@odu/cordis") continue;
        if (spec.startsWith("@odu/cordis/")) continue;
        const segments = spec.split("/").slice(2);
        // A door is one segment (`@odu/ci/row`, `@odu/cache/server`); a file
        // behind one is two or more (`@odu/ci/src/row`, `@odu/cache/dist/…`).
        if (segments.length > 1) offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} names a FILE inside a row rather than one of its ` +
        "doors. The composition root mounts rows; it does not reach past their " +
        "`exports`.",
    ).toEqual([]);
  });
});
