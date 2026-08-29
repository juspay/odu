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
 * `@kolu/*` is admitted by {@link HYDRATED} rather than by the manifest,
 * because those sources are hydrated from a Nix pin and never installed — see
 * the manifest's `//dependencies`. Pinning the exact set here is the point: a
 * NEW `@kolu/*` import is a new directory every downstream must copy, and that
 * is not a fact that may slip in silently.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "bun:test";

const packageRoot = join(import.meta.dirname, "..");

/** Declared in `package.json` and installed from the lockfile. */
const DECLARED = new Set(
  Object.keys(
    (
      JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf-8"),
      ) as { dependencies?: Record<string, string> }
    ).dependencies ?? {},
  ),
);

/** The @kolu/* sources a consumer must hydrate alongside this package. Listed
 *  here because a manifest cannot name them (see the module header), and kept
 *  MINIMAL: every entry is a directory the downstream's own `nix/consumer`
 *  wiring has to copy. */
const HYDRATED = new Set(["@kolu/surface"]);

/** Test-only imports — the harness, not the shipped closure. A consumer that
 *  hydrates this package copies the `.test.ts` files too but never runs them,
 *  so `bun:test` is admitted only from a test file. */
const TEST_ONLY = new Set(["bun:test"]);

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

/** Every `import … from "X"` / `export … from "X"` / bare `import "X"`
 *  specifier in a source file. Deliberately a scan and not a parse: the shapes
 *  this package uses are the three below, and a spelling it does not use is one
 *  no reviewer would expect to find here either. */
function specifiersIn(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(re)) {
    const spec = m[1] ?? m[2];
    if (spec !== undefined) out.push(spec);
  }
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
  .sort();

describe("@odu/run-client's import closure", () => {
  it("has sources to police", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it("never reaches back into odu", () => {
    const offenders: string[] = [];
    for (const rel of sources) {
      const source = readFileSync(join(packageRoot, rel), "utf-8");
      for (const spec of specifiersIn(source)) {
        // A relative import that climbs out of the package directory is the
        // shape that compiles in-repo and vanishes downstream.
        if (!spec.startsWith(".")) continue;
        const resolved = join(rel, "..", spec);
        if (resolved.startsWith("..")) offenders.push(`${rel}: ${spec}`);
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
    const offenders: string[] = [];
    for (const rel of sources) {
      const isTest = rel.endsWith(".test.ts");
      const source = readFileSync(join(packageRoot, rel), "utf-8");
      for (const spec of specifiersIn(source)) {
        if (spec.startsWith(".") || spec.startsWith("node:")) continue;
        const pkg = packageOf(spec);
        if (DECLARED.has(pkg) || HYDRATED.has(pkg)) continue;
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
});
