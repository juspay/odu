/**
 * The WALL, enforced — what this package is allowed to import.
 *
 * Same instrument as `@odu/run-client`'s `closure.test.ts`, and deliberately a
 * SIBLING rather than a shared helper: each package must be able to state its
 * own closure from inside its own directory, because that is the unit a
 * consumer copies. A guard imported from a neighbour would be a guard that
 * travels only as far as the neighbour does — and the failure it catches is
 * exactly the failure of a directory that did not travel with everything it
 * needs.
 *
 * Two ways to break a consumer that `tsc` cannot see from inside this repo,
 * where odu's own node_modules resolves everything:
 *
 *   - an import that reaches back into odu's `src/` compiles here and is a
 *     `TS2307` downstream, because only this directory was copied;
 *   - an import of a package this manifest does not declare compiles here (the
 *     root node_modules has it) and is a missing module downstream.
 *
 * The walk is a PARSE, not a line scan — see the run-client twin for why a
 * regex over lines is a guard that passes because of today's formatting.
 * TYPE-ONLY EDGES COUNT: this package ships raw TypeScript, so a consumer's
 * `tsc` resolves an `import type` exactly as it resolves a value import.
 *
 * The one claim that is this package's own: the arrow to `@odu/run-client`
 * runs ONE WAY. run-history reads the vocabulary a live run speaks; run-client
 * knows nothing about durable history, and the day it does, this file is where
 * the cycle shows up.
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
const EXPECTED_DEPENDENCIES = ["@odu/run-client", "effect"];

/** The `@kolu/*` sources a consumer must hydrate alongside this package.
 *  EMPTY, and that is a property worth pinning: this package touches no
 *  surface framework at all — it is files and schemas — so a consumer that
 *  wants history alone hydrates nothing. The first `@kolu/*` import here would
 *  be a new directory every downstream has to copy. */
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

describe("@odu/run-history's import closure", () => {
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
    // The claim this package makes that its neighbour cannot: history depends
    // on the live vocabulary, never the reverse. Asserted from BOTH sides —
    // that we import it, and that it does not import us — so a cycle
    // introduced from either direction lands here.
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
