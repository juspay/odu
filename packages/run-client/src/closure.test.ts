/**
 * The WALL, enforced — what this package is allowed to import.
 *
 * Two ways to break a consumer that `tsc` cannot see from inside this repo,
 * where odu's own node_modules resolves everything:
 *
 *   - an import that reaches back into odu's `src/` compiles here and is a
 *     `TS2307` downstream, because only this directory was copied;
 *   - an import of a package this manifest does not declare compiles here
 *     (odu's root node_modules has it) and is a missing module downstream.
 *
 * So the closure is walked rather than asserted in prose — the instrument
 * `@kolu/padi-client` carries as `hydrate.closure.test.ts`, against the same
 * class of bug. It is what makes "the arrow never points back" a fact instead
 * of a convention; the README says why that matters.
 *
 * THE WALK IS A PARSE, not a line scan, and the difference is the whole
 * reliability of this file. A regex over lines catches the spellings this
 * directory happens to use today and waves through the ones it does not: a
 * multiline `import {\n  x\n} from "…"`, a `from` on its own line, a dynamic
 * `import()`, an `import("mod").T` in type position. A guard that passes
 * because of how the code is currently formatted is not a guard.
 *
 * TYPE-ONLY EDGES COUNT. This package ships raw TypeScript, so a consumer's
 * `tsc` resolves an `import type` exactly as it resolves a value import and
 * fails `TS2307` when it cannot. A runtime-only walk sees a package leave the
 * manifest while staying in the program — which is how a dependency demoted on
 * the strength of "every use is `import type`" passed kolu's own guard and
 * broke the first out-of-repo consumer three type sites later
 * (juspay/kolu#2216).
 *
 * `@kolu/*` is admitted by {@link HYDRATED} rather than by the manifest,
 * because those sources are hydrated from a Nix pin and never installed — see
 * the manifest's `//dependencies`. Pinning the exact set here is the point: a
 * NEW `@kolu/*` import is a new directory every downstream must copy, and that
 * is not a fact that may slip in silently.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const packageRoot = join(import.meta.dirname, "..");

/** Declared in `package.json` and installed from the lockfile. */
const DECLARED = Object.keys(
  (
    JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf-8"),
    ) as { dependencies?: Record<string, string> }
  ).dependencies ?? {},
);

/** What a consumer must install, pinned as a literal set — the number IS the
 *  claim the README makes, and an unpinned "smaller than odu" would rot
 *  quietly. Growing it is a decision every downstream pays for. */
const EXPECTED_DEPENDENCIES = ["effect"];

/** The @kolu/* sources a consumer must hydrate alongside this package. Listed
 *  here because a manifest cannot name them (see the module header), and kept
 *  MINIMAL: every entry is a directory the downstream's own `nix/consumer`
 *  wiring has to copy. */
const HYDRATED = new Set(["@kolu/surface"]);

/** Test-only imports — the harness, not the shipped closure. A consumer that
 *  hydrates this package copies the `.test.ts` files too but never runs them,
 *  so these are admitted only from a test file. `typescript` is the parser
 *  this very walk uses; odu declares it, no downstream needs it. */
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
 *  imports and re-exports (`import type` included — see the header), `import
 *  x = require("…")`, dynamic `import()`, and `import("…").T` in type
 *  position. Read off the parse tree, so a spelling this package does not use
 *  today is covered the day someone writes it. */
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

interface Scanned {
  readonly rel: string;
  readonly specifiers: readonly string[];
}

const sources: Scanned[] = tsFilesUnder(join(packageRoot, "src"))
  .map((full) => relative(packageRoot, full).split(sep).join("/"))
  .sort()
  .map((rel) => ({
    rel,
    specifiers: specifiersIn(
      readFileSync(join(packageRoot, rel), "utf-8"),
      rel,
    ),
  }));

describe("@odu/run-client's import closure", () => {
  it("has sources to police", () => {
    expect(sources.length).toBeGreaterThan(0);
    // The walk itself must be load-bearing: a parser that silently returned
    // nothing would make every assertion below vacuously true.
    expect(sources.flatMap((s) => s.specifiers).length).toBeGreaterThan(0);
  });

  it("sees the spellings a line scan misses", () => {
    // The guard on the guard. These four are exactly what the previous regex
    // waved through, so the parse is pinned by an example rather than by the
    // absence of a counter-example in today's sources.
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
        // A relative import that climbs out of the package directory is the
        // shape that compiles in-repo and vanishes downstream.
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

  it("costs a consumer exactly these installs", () => {
    expect(
      DECLARED.slice().sort(),
      "the manifest's dependencies moved. Every entry is an install in every " +
        "downstream that hydrates this package, so the list is pinned here " +
        "rather than left to drift — update it deliberately.",
    ).toEqual(EXPECTED_DEPENDENCIES);
  });
});
