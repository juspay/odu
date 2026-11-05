/**
 * WHERE `just` RUNS A RECIPE — the fact PLAN 4.1's push depends on.
 *
 * A node's command is `just --no-deps <namepath>` from the workspace and
 * `just` does the chdir itself, so nothing about EXECUTION needed this. What
 * needs it is the `result*` glob: a recipe's out-links land in the directory
 * it ran in, and for a MODULE recipe that is the module's own directory — the
 * shape `mod ci 'ci/mod.just'` gives, which is the shape odu itself ships and
 * the shape `[metadata("ci")]` encourages. A glob of the workspace root alone
 * finds nothing there and says nothing, which is the one silent failure mode
 * in the whole design.
 *
 * The three rules and `just`'s order between them, each checked against the
 * dump shape `just --dump --dump-format json` actually emits.
 */

import { describe, expect, it } from "bun:test";
import { workdirOf } from "./ingest";

const recipe = (attributes: readonly string[] = []): never =>
  ({
    name: "build",
    namepath: "build",
    attributes: [...attributes],
    body: [],
    dependencies: [],
  }) as never;

const module = (over: Record<string, unknown> = {}): never =>
  ({ recipes: {}, modules: {}, ...over }) as never;

describe("a recipe's working directory", () => {
  it("is the workspace root for a root justfile", () => {
    expect(workdirOf(module({ module_path: "" }), recipe())).toBeNull();
    // A dump from a `just` that does not emit `module_path` at all answers the
    // same: the root is what a single-file justfile has.
    expect(workdirOf(module(), recipe())).toBeNull();
  });

  it("is the MODULE's own directory for a module recipe", () => {
    expect(workdirOf(module({ module_path: "ci" }), recipe())).toBe("ci");
    expect(workdirOf(module({ module_path: "a/b" }), recipe())).toBe("a/b");
  });

  it("follows `set working-directory`, relative to the module", () => {
    // odu's own `ci/mod.just` is exactly this: a module that pins itself back
    // to the repository root.
    expect(
      workdirOf(
        module({ module_path: "ci", settings: { working_directory: ".." } }),
        recipe(),
      ),
    ).toBeNull();
    expect(
      workdirOf(
        module({ module_path: "ci", settings: { working_directory: "sub" } }),
        recipe(),
      ),
    ).toBe("ci/sub");
  });

  it("is cancelled by `[no-cd]` on the recipe and by `set no-cd` on the module", () => {
    // Both leave the recipe in the directory `just` was INVOKED from, which
    // for every node odu runs is the workspace root.
    expect(workdirOf(module({ module_path: "ci" }), recipe(["no-cd"]))).toBeNull();
    expect(
      workdirOf(module({ module_path: "ci", settings: { no_cd: true } }), recipe()),
    ).toBeNull();
    // AND IT BEATS `working-directory`, which is `just`'s own order.
    expect(
      workdirOf(
        module({ module_path: "ci", settings: { working_directory: "sub" } }),
        recipe(["no-cd"]),
      ),
    ).toBeNull();
  });
});
