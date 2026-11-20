import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const packageRoot = join(import.meta.dirname, "..");

const MANIFEST = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf-8"),
) as { dependencies?: Record<string, string> };

const DECLARED = Object.keys(MANIFEST.dependencies ?? {});

const EXPECTED_DEPENDENCIES = [
  "@odu/auth",
  "@odu/cache",
  "@odu/ci",
  "@odu/cloudflare",
  "@odu/cordis",
  "@odu/face",
  "@odu/service-client",
  "effect",
  "solid-js",
];

const HYDRATED = new Set<string>([
  "@kolu/surface",
  "@kolu/surface-app",
]);

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
    false,
    // TSX or TS by extension. TypeScript's parser resolves `<T>(x) => x` one way
    // in a `.ts` and another in a `.tsx`, so a JSX file parsed as TS does not
    // fail loudly — it produces a tree with the imports still in it and the
    // markup mangled, which is a policing test that keeps passing while seeing
    // less than it thinks.
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

  it("keeps the cache's view to ONE importer, and the run views out of it", () => {
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (!spec.startsWith("@odu/cache")) continue;
        if (rel === "src/main.tsx") {
          if (spec !== "@odu/cache/surface") offenders.push(`${rel}: ${spec} (the root mounts surfaces only)`);
          continue;
        }
        if (rel !== "src/app.tsx") offenders.push(`${rel}: ${spec}`);
        else if (spec !== "@odu/cache/face") offenders.push(`${rel}: ${spec} (the shell opens the view, not the contract)`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} reaches the cache from a place that is not the ` +
        "shell. The run views hold the runs' client and the cache view holds " +
        "the cache's; `app.tsx` is the ONE place that wires both.",
    ).toEqual([]);
  });

  it("keeps the door's view to ONE importer too", () => {
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (!spec.startsWith("@odu/auth")) continue;
        if (rel === "src/main.tsx") {
          if (spec !== "@odu/auth/surface") offenders.push(`${rel}: ${spec} (the root mounts surfaces only)`);
          continue;
        }
        if (rel !== "src/app.tsx") offenders.push(`${rel}: ${spec}`);
        else if (spec !== "@odu/auth/face") offenders.push(`${rel}: ${spec} (the shell opens the view, not the contract)`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} reaches the door from a place that is not the ` +
        "shell. A run or cache view that imported it would be a view that could " +
        "sign somebody in; the shell wires the sign-in page and the profile.",
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
