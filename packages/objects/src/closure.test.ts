/**
 * The WALL, enforced — what `@odu/objects` is allowed to import.
 *
 * A sibling of the other members' closure tests rather than a shared helper:
 * each package states its own closure from inside its own directory.
 *
 * The claims that make it a package rather than a folder of the cache:
 *
 *   - **it imports no `@odu/*` package at all.** A store knows keys and bytes;
 *     the moment it imported the cache it could learn what the bytes mean (a
 *     NAR, a bucket, a Nix hash), and the moment it imported a row it would be
 *     a row's internals. Refused by PREFIX here, so no future package is
 *     missing from a list.
 *   - **it installs nothing.** Its platform is `node:` builtins and one Bun
 *     builtin, `bun` (the S3 store's `S3Client`), named rather than matched.
 *   - **it reads no environment.** Declarations arrive as text and a reader.
 *
 * `test/` is walked too: the contract suite and the versitygw fixture ship to
 * consumers' suites through `./testing`, so they are held to the same wall.
 * The walk is a PARSE, not a line scan, and TYPE-ONLY EDGES COUNT.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const packageRoot = join(import.meta.dirname, "..");

const MANIFEST = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as {
  dependencies?: Record<string, string>;
};

/** The non-`node:` builtins this package may reach. Named, never prefix-matched. */
const BUN_BUILTINS = new Set(["bun"]);

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
    // `.tsx` INCLUDED: `./face` is Solid JSX, and a walker that only knew about
    // `.ts` would have quietly stopped policing it the day it was written —
    // the failure `@odu/web-ui`'s twin records having had.
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

/** Does this module READ the environment — a `process.env` property access,
 *  rather than the phrase appearing in prose? */
function readsProcessEnv(source: string, fileName: string): boolean {
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
  let found = false;
  const walk = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "env" &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process"
    ) {
      found = true;
    }
    ts.forEachChild(node, walk);
  };
  walk(parsed);
  return found;
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
}

const sources = [...tsFilesUnder(join(packageRoot, "src")), ...tsFilesUnder(join(packageRoot, "test"))]
  .map((full) => relative(packageRoot, full).split(sep).join("/"))
  .sort()
  .map((rel) => {
    const source = readFileSync(join(packageRoot, rel), "utf-8");
    return { rel, source, specifiers: specifiersIn(source, rel) };
  });

/** Test harness files: unit tests, and `test/`'s suite and fixture. */
const isHarness = (rel: string): boolean => rel.endsWith(".test.ts") || rel.startsWith("test/");

describe("@odu/objects's import closure", () => {
  it("has sources to police", () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.flatMap((s) => s.specifiers).length).toBeGreaterThan(0);
  });

  it("never reaches out of the package directory", () => {
    const offenders = sources.flatMap(({ rel, specifiers }) =>
      specifiers.filter((spec) => spec.startsWith(".") && join(rel, "..", spec).startsWith("..")).map((spec) => `${rel}: ${spec}`),
    );
    expect(offenders, `${offenders.join(", ")} climbs out of the package with a relative import.`).toEqual([]);
  });

  it("imports no @odu package — not the cache, not any row", () => {
    const offenders = sources.flatMap(({ rel, specifiers }) =>
      specifiers.filter((spec) => spec.startsWith("@odu/")).map((spec) => `${rel}: ${spec}`),
    );
    expect(
      offenders,
      `${offenders.join(", ")} reaches into odu. A store knows keys and bytes; ` +
        "what they mean is its caller's, and the arrow runs cache → objects only.",
    ).toEqual([]);
  });

  it("imports only builtins, and the harness only in tests", () => {
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (spec.startsWith(".") || spec.startsWith("node:") || BUN_BUILTINS.has(spec)) continue;
        if (isHarness(rel) && TEST_ONLY.has(packageOf(spec))) continue;
        offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(offenders, `${offenders.join(", ")} is not a builtin this package may use.`).toEqual([]);
  });

  it("reads no environment", () => {
    const offenders = sources
      .filter(({ rel }) => !isHarness(rel))
      .filter(({ source, rel }) => readsProcessEnv(source, rel))
      .map(({ rel }) => rel);
    expect(offenders, `${offenders.join(", ")} reads process.env.`).toEqual([]);
  });

  it("installs nothing", () => {
    expect(Object.keys(MANIFEST.dependencies ?? {})).toEqual([]);
  });
});
