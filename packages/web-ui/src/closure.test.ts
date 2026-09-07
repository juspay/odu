/**
 * The WALL, enforced — what the browser is allowed to import.
 *
 * Two claims, and the second is the one that matters.
 *
 * **No `node:` anything.** This package is bundled into a tab. A filesystem
 * read resolves happily at build time and is a blank page at runtime, and no
 * compiler will say so — so it is said here.
 *
 * **No `@odu/service`, and no `@odu/execution`.** The browser talks to the
 * service over the wire and holds none of it: no catalog reader, no retry
 * policy, no idea of its own about what "red" means. That is what makes "the
 * browser has no execution or retry logic" a property this suite checks rather
 * than a sentence in a README — and it is what keeps the browser and the CLI
 * and the MCP face genuinely three views of ONE truth.
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

/** What a consumer must satisfy, pinned as a literal set. Growing it is a
 *  decision every downstream pays for, so it is written down rather than
 *  derived from whatever the manifest happens to say today. */
const EXPECTED_DEPENDENCIES = ["@odu/service-client", "effect", "solid-js"];

/** The `@kolu/*` sources a consumer must hydrate alongside this package. */
const HYDRATED = new Set<string>([
  // The browser's half of the framework: the Solid client hooks, the app
  // shell's `connectSurface`, and its lifecycle helpers.
  "@kolu/surface",
  "@kolu/surface-app",
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

describe("@odu/web-ui's import closure", () => {
  it("has sources to police", () => {
    expect(sources.length).toBeGreaterThan(0);
    // A parser that silently returned nothing would make every assertion
    // below vacuously true.
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

  it("never imports a node builtin", () => {
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      // THIS FILE is the exception, and the only one: a closure test reads the
      // directory it polices. It is never bundled — `bun test` runs it — so the
      // rule it enforces does not apply to the enforcer.
      if (rel.endsWith(".test.ts")) continue;
      for (const spec of specifiers) {
        if (spec.startsWith("node:")) offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} imports a node builtin into a browser bundle.`,
    ).toEqual([]);
  });

  it("holds no execution or retry logic of its own", () => {
    // The property the whole three-faces design rests on: the browser is a VIEW
    // of the service, so it must not be able to reach a catalog, a coordinator
    // or a retry policy. Checked rather than promised.
    const forbidden = new Set(["@odu/service", "@odu/execution", "@odu/cli", "@odu/run-history"]);
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (forbidden.has(packageOf(spec))) offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} would give the browser a second way to reach a ` +
        "run. Everything it knows arrives over @odu/service-client's surface.",
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
