/**
 * The WALL, enforced — what this package is allowed to import.
 *
 * Same instrument as `@odu/run-client`'s and `@odu/run-history`'s, and
 * deliberately a SIBLING rather than a shared helper: each package must be able
 * to state its own closure from inside its own directory, because that is the
 * unit a consumer copies.
 *
 * The claim that is THIS package's own is BROWSER SAFETY. Every module here is
 * loaded into a tab by `packages/web-ui`, so a `node:` import — a filesystem
 * read, a `child_process` — would not fail here, where the bundler is happy to
 * resolve it, but in the browser, at runtime, as a blank page. There is no
 * compiler check for that, so it is checked here: `node:*` is refused
 * OUTRIGHT, and the refusal is the reason the service's platform half lives one
 * wall up in `@odu/service`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
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
const EXPECTED_DEPENDENCIES = ["@odu/run-client", "@odu/run-history", "effect"];

/** The `@kolu/*` sources a consumer must hydrate alongside this package. */
const HYDRATED = new Set<string>([
  // The framework's browser-safe half: the contract vocabulary
  // (`defineSurface`), the face builder, the websocket link and the shell
  // constant the dial reads its terminal close code from. A consumer that
  // hydrates this package hydrates these two directories with it.
  "@kolu/surface",
  "@kolu/surface-app",
  // The daemon-home algebra `./socket` derives the service's socket path from
  // (`resolveDaemonHome`) — reached by the node-only half alone.
  "@kolu/surface-daemon",
]);

/**
 * The NODE-ONLY modules — the platform half, which a browser must never reach.
 *
 * `./socket` is the service's LOCAL transport: a unix socket in the daemon's
 * home, plus the home's name derivation (`node:crypto`) and the path algebra
 * (`node:path`, via `@kolu/surface-daemon`). There is nowhere else for it to
 * live that would not make every local client re-derive the daemon's address,
 * so it lives here and is DECLARED — the wall below stops being a blanket over
 * the directory and becomes a statement about which modules are the browser's.
 */
const NODE_ONLY = new Set(["src/socket.ts"]);

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

describe("@odu/service-client's import closure", () => {
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

  it("never imports a node builtin outside the declared node-only modules", () => {
    // The claim this package makes that its neighbours do not: every module the
    // BROWSER reaches is bundled into a tab, where a `node:` import resolves at
    // build time and is a blank page at runtime. `NODE_ONLY` names the platform
    // half — the service's local socket transport — so the rule is about which
    // modules the browser can reach rather than about the whole directory.
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      // THIS FILE is the exception, and the only one: a closure test reads the
      // directory it polices. It is never bundled — `bun test` runs it — so the
      // rule it enforces does not apply to the enforcer.
      if (rel.endsWith(".test.ts") || NODE_ONLY.has(rel)) continue;
      for (const spec of specifiers) {
        if (spec.startsWith("node:")) offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} imports a node builtin. Platform I/O belongs ` +
        "either one wall up, in @odu/service, or in a module declared in " +
        "NODE_ONLY — a browser tab reaching it is a blank page.",
    ).toEqual([]);
  });

  it("keeps the node-only modules out of a browser's reach", () => {
    // NODE_ONLY is a claim about what a BUNDLER follows, not about what a file
    // says: a browser-safe module that imports `./socket` — directly, or
    // through a re-export — pulls `node:crypto` into the tab regardless. One
    // hop is enough to catch it, because the set of browser-reachable modules
    // IS `src` minus NODE_ONLY: the first edge out of that set is the
    // violation, and a module added to NODE_ONLY is exempt from the rule by
    // the same declaration the other test reads.
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      if (rel.endsWith(".test.ts") || NODE_ONLY.has(rel)) continue;
      for (const spec of specifiers) {
        const target = normalize(join(dirname(rel), spec));
        const file = target.endsWith(".ts") ? target : `${target}.ts`;
        if (NODE_ONLY.has(file)) offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} reaches a NODE_ONLY module from a module a ` +
        "browser may import.",
    ).toEqual([]);
  });

  it("does not import the service or the engine", () => {
    const forbidden = new Set(["@odu/service", "@odu/execution", "@odu/cli"]);
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (forbidden.has(packageOf(spec))) offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} reaches UP the wall. This package is the ` +
        "contract; the things that implement it depend on it, never the reverse.",
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
