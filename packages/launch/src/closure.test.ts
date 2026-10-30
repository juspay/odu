/**
 * The WALL, enforced — what the launch package is allowed to import.
 *
 * This package exists for ONE reason and its closure is the reason: **a row may
 * import it, and the registry may not be imported by a row.** `@odu/host` names
 * every row (it is the registry, the roster and the composer), so a face that
 * reached for the host to learn how to bootstrap would close the cycle the
 * fence refuses — and it would be a real one, not a formality: the CLI would
 * carry every row's SERVER to reach the code that starts one.
 *
 * So the two claims:
 *
 *   - **no row, and no registry.** `@odu/host` and `@odu/web-ui` are the host
 *     side; `@odu/cli`, `@odu/cache`, `@odu/service`, `@odu/service-client`,
 *     `@odu/execution`, `@odu/run-history` and `@odu/run-client` are rows. The
 *     one exception is `@odu/service-client`, and it is not a row's SERVER: it
 *     is the CONTRACT and the dial, which is what a bootstrap is written
 *     against.
 *   - **nothing about a run.** This package starts a DAEMON. It knows odu's
 *     re-invocation argv (`coordinator/spawn`) and nothing else of the engine —
 *     no launcher, no retry policy, no catalog writer.
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

/** Pinned as a literal set: three installs, and the absence of the host is the
 *  claim. */
const EXPECTED_DEPENDENCIES = ["@odu/execution", "@odu/service-client", "effect"];

/** The `@kolu/*` sources hydrated from a Nix pin rather than installed. */
const HYDRATED = new Set<string>([
  // The pid gate and the survivable spawn — the two mechanisms a daemon is
  // started with and a client waits on.
  "@kolu/surface-daemon",
  "@kolu/surface-daemon-supervisor",
  "@kolu/surface",
  // NOT a `@kolu/*` package, and hydrated for the same reason they are.
  "osfacts-client",
]);

/** `@odu/service-client` is the ONE row-side package a bootstrap may name — it
 *  holds the dial, and a bootstrap is written against a dial. Everything else
 *  server-side is refused by name. */
const ALLOWED_ROW_PACKAGES = new Set(["@odu/service-client"]);

/** The rows, and the host side. A specifier from any of these is a finding. */
const ROW_PACKAGES = new Set([
  "@odu/cli",
  "@odu/cache",
  "@odu/service",
  "@odu/run-history",
  "@odu/run-client",
]);

/**
 * The engine's two LEAVES this package may name, and neither is a row's server:
 * `common/version` is the string an identity cell carries, and `common/effectEdge`
 * is odu's single sanctioned `Effect.run*` boundary. Both are vocabulary a
 * bootstrap speaks; neither starts, retries or cancels anything.
 */
const ENGINE_LEAVES = new Set([
  "@odu/execution/common/version",
  "@odu/execution/common/effectEdge",
  // ...and the spawn DESCRIPTION, which starts nothing by itself and is what
  // this package's whole job is made of. Per-file and per-specifier below too.
  "@odu/execution/coordinator/spawn",
]);
const HOST_PACKAGES = new Set(["@odu/host", "@odu/web-ui", "@odu/launch"]);

/** Test-only imports — the harness, not the shipped closure. */
const TEST_ONLY = new Set(["bun:test", "typescript"]);

/**
 * The ONE exception, per-file AND per-specifier: odu's own re-invocation argv
 * and the environment a child needs live with the spawn machinery in
 * `@odu/execution/coordinator/spawn`, which starts nothing by itself. Allowing
 * the whole `coordinator` prefix would allow the launcher and the retry policy
 * with it.
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "src/webDaemonLaunch.ts": ["@odu/execution/coordinator/spawn"],
};

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

describe("@odu/launch's import closure", () => {
  it("has sources to police", () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.flatMap((s) => s.specifiers).length).toBeGreaterThan(0);
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
        "hydrated set this test pins.",
    ).toEqual([]);
  });

  it("names no row's server and no registry", () => {
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        const pkg = packageOf(spec);
        if (HOST_PACKAGES.has(pkg)) offenders.push(`${rel}: ${spec} (the host side)`);
        if (ENGINE_LEAVES.has(spec)) continue;
        if (pkg === "@odu/execution" || ROW_PACKAGES.has(pkg)) {
          offenders.push(`${rel}: ${spec} (a row's internals)`);
        }
        if (ALLOWED_ROW_PACKAGES.has(pkg) && pkg !== "@odu/service-client") {
          offenders.push(`${rel}: ${spec}`);
        }
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} names a row or the registry. This package exists ` +
        "so that a ROW can bootstrap: a row that imported the host would import " +
        "every row's server to reach the code that starts one.",
    ).toEqual([]);
  });

  it("keeps the spawn allowance per-file AND per-specifier", () => {
    const launcher = sources.find((s) => s.rel === "src/webDaemonLaunch.ts");
    expect(launcher).toBeDefined();
    expect(launcher?.specifiers).toContain("@odu/execution/coordinator/spawn");
    expect(launcher?.specifiers).not.toContain("@odu/execution/coordinator/launcher");
    expect(launcher?.specifiers).not.toContain("@odu/execution/coordinator/recovery");
  });

  it("does not let the spawn allowance travel to another file", () => {
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      // A TEST may name the spawn description: it is asserting what the config
      // says, and it starts nothing.
      if (rel.endsWith(".test.ts")) continue;
      for (const spec of specifiers) {
        if (!spec.startsWith("@odu/execution/coordinator")) continue;
        if ((ALLOWED[rel] ?? []).includes(spec)) continue;
        offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("costs exactly these installs", () => {
    expect(
      DECLARED.slice().sort(),
      "the manifest's dependencies moved. Pinned here rather than left to " +
        "drift — update it deliberately.",
    ).toEqual(EXPECTED_DEPENDENCIES);
  });
});
