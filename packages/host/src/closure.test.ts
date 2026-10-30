/**
 * The WALL, enforced — what the HOST is allowed to import.
 *
 * This package is not a ROW. A row carries a surface, names only other rows,
 * and knows nothing about who serves it. The host is the other side of that:
 * it names the rows, serves their surfaces over one listener, and provides
 * what they need as services. So its closure has two claims that are its own,
 * and one it inherited.
 *
 * **No `@odu/cli`, and no `@odu/web-ui`.** Those are the two roots a row has
 * faces in — the terminal/argv/MCP faces and the browser. A daemon that
 * imported one would carry a renderer, an MCP bridge or a page's routing into
 * the process that supervises every run; and a row that imported the host
 * would be a row that named the thing serving it, which is the arrow backwards.
 * The arrow is `root → host → rows`, and this test is where the first half is
 * held.
 *
 * **The composition root is ONE file.** Reaching the engine is this package's
 * JOB — `./webPorts` binds the service's ports to the coordinator's launcher,
 * its retry policy, the catalog, the venue inventory and the forge. So the
 * claim cannot be "nothing here imports the engine"; it is that the two modules
 * which START and RETRY a run are named by `./webPorts` and by nothing else. A
 * second file constructing a launcher is a second scheduler in the daemon.
 *
 * The walk is a PARSE, not a line scan, and TYPE-ONLY EDGES COUNT — see
 * `@odu/run-client`'s twin for both arguments.
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

/** Pinned as a literal set: every entry is an install a consumer pays for, and
 *  `@odu/cli`'s absence is the wall this package exists to state. */
const EXPECTED_DEPENDENCIES = ["@modelcontextprotocol/sdk", "@odu/cache", "@odu/execution", "@odu/launch", "@odu/run-client", "@odu/run-history", "@odu/service", "@odu/service-client", "effect"];

/** The `@kolu/*` sources hydrated from a Nix pin rather than installed, plus
 *  the one graft that is not a kolu workspace directory at all. */
const HYDRATED = new Set<string>([
  // The listener, its origin gate and its `/mcp` route seam.
  "@kolu/surface",
  "@kolu/surface-app",
  // The singleton gate, and the survivable spawn that outlives a launcher.
  "@kolu/surface-daemon",
  "@kolu/surface-daemon-supervisor",
  // The MCP adapter the `/mcp` route projects the surface through.
  "@kolu/surface-mcp",
  // The plugin runtime the rows are: `@olai/effect-cordis` and the four cordis
  // packages behind its root door. Hydrated from two npins pins rather than
  // installed, exactly as the @kolu/* members are — its `./loader` door (a
  // file off a disk, a YAML parser) is deliberately NOT opened: odu's rows are
  // fixed at boot.
  "@olai/effect-cordis",
  "cordis",
  "@cordisjs/plugin-loader",
  "@cordisjs/plugin-include",
  "@cordisjs/plugin-group",
  // NOT a `@kolu/*` package, and hydrated for the same reason they are: kolu
  // gitignores `osfacts-client` and grafts it from its own `osfacts` pin, so no
  // revision of juspay/kolu contains it. odu performs the same graft from the
  // same upstream — and, since the singleton gate needs a reader rather than a
  // type, also builds the BINARY from that pin (`nix/overlay.nix`) and bakes
  // its path onto the wrapper.
  "osfacts-client",
]);

/** What the host may not name: the two roots that hold FACES. */
const FORBIDDEN_PACKAGES = new Set(["@odu/cli", "@odu/web-ui"]);

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

describe("@odu/host's import closure", () => {
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

  it("names no root that holds faces", () => {
    // The arrow is root → host → rows. `@odu/cli` and `@odu/web-ui` are rows'
    // faces: a daemon carrying either would ship a renderer, an argv projection
    // or a page's routing into the process that supervises every run.
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      for (const spec of specifiers) {
        if (FORBIDDEN_PACKAGES.has(packageOf(spec))) offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} names a root that holds faces. The host serves ` +
        "the rows' SURFACES; the faces that render them are clients of this " +
        "process, not parts of it.",
    ).toEqual([]);
  });

  it("binds the run launcher in exactly one place", () => {
    // THE COMPOSITION ROOT IS ONE FILE, and this is what says so. Reaching the
    // engine is the host's JOB — it is what `webPorts` is for — so the claim
    // cannot be "nothing here imports the coordinator". It is narrower and it
    // is the one that matters: the two modules that start and retry a RUN are
    // named by `webPorts.ts` and by nothing else. A second file constructing a
    // launcher would be a second scheduler in the daemon, and nothing else in
    // this package would notice.
    const offenders: string[] = [];
    for (const { rel, specifiers } of sources) {
      if (rel.endsWith(".test.ts")) continue;
      for (const spec of specifiers) {
        if (spec === "@odu/execution/coordinator/launcher" || spec === "@odu/execution/coordinator/recovery") {
          if (rel !== "src/webPorts.ts") offenders.push(`${rel}: ${spec}`);
        }
      }
    }
    expect(
      offenders,
      `${offenders.join(", ")} binds the engine outside the composition root. ` +
        "`src/webPorts.ts` is the ONE place the service's ports meet the " +
        "engine; a launcher anywhere else is a second scheduler.",
    ).toEqual([]);
    expect(
      sources.find((s) => s.rel === "src/webPorts.ts")?.specifiers,
      "the composition root still names both",
    ).toEqual(
      expect.arrayContaining([
        "@odu/execution/coordinator/launcher",
        "@odu/execution/coordinator/recovery",
      ]),
    );
  });

  it("costs exactly these installs", () => {
    expect(
      DECLARED.slice().sort(),
      "the manifest's dependencies moved. Pinned here rather than left to " +
        "drift — update it deliberately.",
    ).toEqual(EXPECTED_DEPENDENCIES);
  });
});
