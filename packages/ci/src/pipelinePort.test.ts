import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPipeline } from "./pipelinePort";

const trash: string[] = [];
afterEach(() => {
  for (const dir of trash.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function checkout(justfile?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-pipeline-port-"));
  trash.push(dir);
  if (justfile !== undefined) writeFileSync(join(dir, "justfile"), justfile);
  return dir;
}

/**
 * `alpha` carries both OS attributes, and that is not decoration: `just`
 * EXCLUDES a recipe whose attributes do not match the host, so a bare
 * `[linux]` here made `alpha` vanish on macOS and took `beta: alpha` down with
 * it — "recipe `beta` has unknown dependency `alpha`", four failures, on the
 * darwin lane only.
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
    expect(outcome.facts.name).toBe("default");
    expect(outcome.facts.tasks.map((t) => t.id).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    const beta = outcome.facts.tasks.find((t) => t.id === "beta");
    expect(beta?.needs).toEqual(["alpha"]);
    expect(outcome.facts.mermaid).toContain("flowchart TD");
    expect(outcome.facts.mermaid).toContain("alpha --> beta");
  });

  it("keeps absence and emptiness apart on every optional field", () => {
    const outcome = readPipeline({ checkout: checkout(GOOD) });
    if (!outcome.ok) throw new Error(outcome.message);
    const alpha = outcome.facts.tasks.find((t) => t.id === "alpha");
    const beta = outcome.facts.tasks.find((t) => t.id === "beta");
    expect(alpha?.name).toBe("alpha");
    expect(alpha?.shards).toBeNull();
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
    const outcome = readPipeline({ checkout: checkout(GOOD), root: "alpha" });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.facts.tasks.map((t) => t.id)).toEqual(["alpha"]);
  });

  it("refuses a path that is not a directory at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-pipeline-gone-"));
    trash.push(dir);
    expect(readPipeline({ checkout: join(dir, "nope") }).ok).toBe(false);
  });
});
