/**
 * READING A PIPELINE THROUGH THE PORT — and, mostly, failing to.
 *
 * The success path is the boring half: `just` parses, the DAG resolves, the
 * facts come out. What a face branches on is the OTHER half, and the property
 * that matters there is that a checkout with a broken justfile produces a VALUE
 * and not an exception. `loadJustPipeline` throws for every one of the four
 * ways it can fail, and a thrown error inside a daemon procedure is a 500 with
 * no refusal code — which is how `pipeline.read` would have answered "your
 * justfile has a cycle" if this adapter had forwarded the throw.
 *
 * The second property is that the engine's sentence survives. It names the
 * recipe; this layer cannot, and a face that got "could not read the pipeline"
 * would have thrown away the only actionable part.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPipeline } from "./pipelinePort";

const trash: string[] = [];
afterEach(() => {
  for (const dir of trash.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkout holding exactly this justfile (or none at all). */
function checkout(justfile?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-pipeline-port-"));
  trash.push(dir);
  if (justfile !== undefined) writeFileSync(join(dir, "justfile"), justfile);
  return dir;
}

/**
 * A fixture that parses on EVERY platform this suite runs on.
 *
 * `alpha` carries both OS attributes, and that is not decoration: `just`
 * EXCLUDES a recipe whose attributes do not match the host, so a bare
 * `[linux]` here made `alpha` vanish on macOS and took `beta: alpha` down with
 * it — "recipe `beta` has unknown dependency `alpha`", four failures, on the
 * darwin lane only. The test's subject is the `os` field, so it does need a
 * recipe that HAS one; naming both is what lets it have one without the
 * fixture becoming a fact about where the suite happens to be running.
 */
const GOOD = `[parallel]
[metadata("ci")]
default: alpha beta

[linux]
[macos]
alpha:
    echo alpha

beta: alpha
    echo beta
`;

describe("readPipeline", () => {
  it("resolves the ci-tagged DAG, its edges and its Mermaid rendering", () => {
    const outcome = readPipeline({ checkout: checkout(GOOD) });
    if (!outcome.ok) throw new Error(`expected a pipeline: ${outcome.message}`);
    // `default` is an empty-bodied fan-out marker, so it names the pipeline
    // rather than becoming a task — the engine's rule, carried unchanged.
    expect(outcome.facts.name).toBe("default");
    expect(outcome.facts.tasks.map((t) => t.id).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    const beta = outcome.facts.tasks.find((t) => t.id === "beta");
    expect(beta?.needs).toEqual(["alpha"]);
    // The engine renders the graph, so `odu graph` and a browser cannot drift.
    expect(outcome.facts.mermaid).toContain("flowchart TD");
    expect(outcome.facts.mermaid).toContain("alpha --> beta");
  });

  it("keeps absence and emptiness apart on every optional field", () => {
    const outcome = readPipeline({ checkout: checkout(GOOD) });
    if (!outcome.ok) throw new Error(outcome.message);
    const alpha = outcome.facts.tasks.find((t) => t.id === "alpha");
    const beta = outcome.facts.tasks.find((t) => t.id === "beta");
    // Ingest names every recipe after its namepath, so `name` arrives present
    // here; the null arm is for a producer that omits it, which is what the
    // port's `string | null` exists to express rather than an empty string.
    expect(alpha?.name).toBe("alpha");
    // No `[shards(n)]`: NOT KNOWN, so null — an unsharded recipe has no
    // maximum, which is a different fact from a maximum of zero.
    expect(alpha?.shards).toBeNull();
    // `[linux]` is knowledge; no attribute at all is knowledge too — "runs
    // everywhere" — so it is `[]` and never null.
    expect([...(alpha?.os ?? [])].sort()).toEqual(["linux", "macos"]);
    expect(beta?.os).toEqual([]);
  });

  it("refuses a checkout with no justfile instead of throwing", () => {
    const outcome = readPipeline({ checkout: checkout() });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("just");
  });

  it("refuses a justfile just cannot parse, carrying just's own complaint", () => {
    const outcome = readPipeline({ checkout: checkout("this is not ( a recipe\n") });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The engine's sentence, not a summary of it: it names the line.
    expect(outcome.message).toContain("just --dump failed");
  });

  it("refuses a justfile with no ci-tagged recipe, and says so", () => {
    const outcome = readPipeline({ checkout: checkout("alpha:\n    echo hi\n") });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("metadata");
  });

  it("refuses a --root that names no recipe, naming the recipe asked for", () => {
    const outcome = readPipeline({
      checkout: checkout(GOOD),
      root: "nosuchrecipe",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("nosuchrecipe");
  });

  it("honours a --root that DOES name one, slicing the DAG to it", () => {
    // The root is passed through as an absent key when unset, so this is also
    // the assertion that it is not being dropped on the floor.
    const outcome = readPipeline({ checkout: checkout(GOOD), root: "alpha" });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.facts.tasks.map((t) => t.id)).toEqual(["alpha"]);
  });

  it("refuses a path that is not a directory at all", () => {
    // The service accepts a checkout string from a browser; a typo must be a
    // refusal, not a spawn error escaping through the procedure.
    const dir = mkdtempSync(join(tmpdir(), "odu-pipeline-gone-"));
    trash.push(dir);
    expect(readPipeline({ checkout: join(dir, "nope") }).ok).toBe(false);
  });
});
