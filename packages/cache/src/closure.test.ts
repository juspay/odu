/**
 * The WALL, enforced — what this package is allowed to import.
 *
 * Same instrument as the other members carry, and deliberately a SIBLING rather
 * than a shared helper: each package must be able to state its own closure from
 * inside its own directory, because that directory is the unit the boundary is
 * about. A guard imported from a neighbour is a guard that only reaches as far
 * as the neighbour does.
 *
 * Three claims are THIS package's own, and the first two are why it is a
 * package at all:
 *
 *   - **it imports none of odu's engine or faces.** A cache that could reach
 *     `@odu/execution` would be a second way to start a run; one that reached
 *     `@odu/service` could not be served from a listener without the service;
 *     one that reached `@odu/run-history` would drag a catalog reader into a
 *     substituter. Refused by name, from this side.
 *   - **it reads no environment.** The composition root passes the state
 *     directory, the root token and the store URI in. A cache that read
 *     `process.env` itself would have a second, invisible configuration — and
 *     the one variable that must never be found by accident is a root token.
 *     The ONE exception is `./cli`, and it is not the engine: a face IS a
 *     process, and a process reads its own environment (which token to present
 *     is the caller's, not the daemon's).
 *   - **its platform is `node:` builtins and one Bun builtin.** `bun:sqlite` is
 *     named here rather than admitted by a prefix, so the day a second Bun
 *     builtin appears is a day this file changes.
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

/** Pinned as a literal set: `effect` and `solid-js` — the second is `./face`'s
 *  cost, and the reason the face is a separate DOOR rather than a module the
 *  server could reach. `@kolu/surface` is HYDRATED from a Nix pin and so is
 *  absent here by design. */
const EXPECTED_DEPENDENCIES = ["@odu/cordis", "effect", "solid-js"];

/** The `@kolu/*` sources hydrated from a Nix pin rather than installed. Four
 *  doors of this package open the framework: the surface (`/define`,
 *  `/expose`), the server (`/server`), and the CLI face's client
 *  (`/client`, `/project`, `/link`). */
const HYDRATED = new Set<string>([
  "@kolu/surface",
  // The row IS a `definePlugin`: `./server` is mounted by the host as one of
  // its rows, so the plugin runtime's root door is part of this package's
  // closure. (`./loader` — a file off a disk, a YAML parser — is not.)
  "@olai/effect-cordis",
]);

/** The non-`node:` builtins this package may reach. Named, never prefix-matched:
 *  a prefix would let `bun:ffi` in with `bun:sqlite`. */
const BUN_BUILTINS = new Set(["bun:sqlite"]);

/** The walls that run the other way. This package is the BOTTOM of odu's graph:
 *  nothing above it may appear below it. */
const FORBIDDEN = new Set([
  "@odu/service",
  "@odu/execution",
  "@odu/cli",
  "@odu/run-history",
  "@odu/service-client",
]);

/** Test-only imports — the harness, not the shipped closure. */
const TEST_ONLY = new Set([
  "bun:test",
  "typescript",
  // `face.test.ts` compiles the view with the app's own compiler; the presets
  // are the ROOT's build toolchain (see the root manifest), never a runtime
  // dependency — nothing a consumer installs includes them.
  "@babel/core",
  "@babel/preset-typescript",
  "babel-preset-solid",
]);

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

const sources = tsFilesUnder(join(packageRoot, "src"))
  .map((full) => relative(packageRoot, full).split(sep).join("/"))
  .sort()
  .map((rel) => ({
    rel,
    source: readFileSync(join(packageRoot, rel), "utf-8"),
    specifiers: specifiersIn(readFileSync(join(packageRoot, rel), "utf-8"), rel),
  }));

describe("@odu/cache's import closure", () => {
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

  it("imports only what its manifest and the declared builtins provide", () => {
    const declared = new Set(DECLARED);
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      const isTest = rel.endsWith(".test.ts");
      for (const spec of specifiers) {
        if (spec.startsWith(".") || spec.startsWith("node:")) continue;
        if (BUN_BUILTINS.has(spec)) continue;
        const pkg = packageOf(spec);
        if (declared.has(pkg) || HYDRATED.has(pkg)) continue;
        if (isTest && TEST_ONLY.has(pkg)) continue;
        offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} is in neither this package's manifest nor the ` +
        "builtin set this test pins.",
    ).toEqual([]);
  });

  it("is at the bottom of the wall, and never reaches up it", () => {
    // The claim: a substituter knows the Nix protocol and nothing about how odu
    // runs CI. Asserted here rather than only from the other side, because a
    // package that grew the edge would still be caught by its neighbour's test
    // only if the neighbour's test existed first.
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (FORBIDDEN.has(packageOf(spec))) offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} reaches UP the wall. The cache is served by the ` +
        "root and administered through the service; it never imports either.",
    ).toEqual([]);
  });

  it("reads no environment of its own", () => {
    // The root passes the state directory, the root token and the store URI in.
    // A second, invisible configuration is exactly how a root token ends up
    // being read from somewhere nobody audited.
    //
    // Read off the PARSE, not the text: a comment explaining why this package
    // takes its configuration as arguments is not a read of it.
    const offenders = sources
      .filter(({ rel }) => !rel.endsWith(".test.ts"))
      // `./cli` is a FACE and lives in a process: which root token to present,
      // and where `~` is, are its caller's facts. Everything the ENGINE does
      // takes them as arguments.
      .filter(({ rel }) => rel !== "src/cli.ts")
      .filter(({ source, rel }) => readsProcessEnv(source, rel))
      .map(({ rel }) => rel);
    expect(
      offenders,
      `${offenders.join(", ")} reads process.env. Configuration arrives as ` +
        "arguments from the composition root.",
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
