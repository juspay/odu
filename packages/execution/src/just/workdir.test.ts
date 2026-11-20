import { describe, expect, it } from "bun:test";
import { workdirOf } from "./ingest";

const ROOT = "/w/justfile";

const recipe = (attributes: readonly string[] = []): never =>
  ({
    name: "build",
    namepath: "build",
    attributes: [...attributes],
    body: [],
    dependencies: [],
  }) as never;

/** A module as `just --dump` writes it: `source` is its justfile's ABSOLUTE
 *  path, and `module_path` is the namepath that cannot say where it lives. */
const module = (over: Record<string, unknown> = {}): never =>
  ({ recipes: {}, modules: {}, ...over }) as never;

describe("a recipe's working directory", () => {
  it("is the workspace root for a root justfile", () => {
    expect(workdirOf(module({ source: ROOT }), recipe(), ROOT)).toBeNull();
    expect(workdirOf(module(), recipe(), ROOT)).toBeNull();
    expect(workdirOf(module({ source: ROOT }), recipe(), undefined)).toBeNull();
  });

  it("is the module's DIRECTORY, which is not its name", () => {
    expect(
      workdirOf(
        module({ source: "/w/tooling/mod.just", module_path: "ci" }),
        recipe(),
        ROOT,
      ),
    ).toBe("tooling");
  });

  it("is the NESTED module's directory, where module_path is never a path", () => {
    expect(
      workdirOf(
        module({ source: "/w/a/b/mod.just", module_path: "a::b" }),
        recipe(),
        ROOT,
      ),
    ).toBe("a/b");
    expect(
      workdirOf(
        module({ source: "/w/tooling/deep/mod.just", module_path: "ci::deep" }),
        recipe(),
        ROOT,
      ),
    ).toBe("tooling/deep");
  });

  it("follows `set working-directory`, relative to the module's directory", () => {
    expect(
      workdirOf(
        module({ source: "/w/ci/mod.just", settings: { working_directory: ".." } }),
        recipe(),
        ROOT,
      ),
    ).toBeNull();
    expect(
      workdirOf(
        module({ source: "/w/ci/mod.just", settings: { working_directory: "sub" } }),
        recipe(),
        ROOT,
      ),
    ).toBe("ci/sub");
  });

  it("answers an ABSOLUTE working-directory as itself, outside the workspace", () => {
    expect(
      workdirOf(
        module({ source: "/w/ci/mod.just", settings: { working_directory: "/tmp" } }),
        recipe(),
        ROOT,
      ),
    ).toBe("/tmp");
    expect(
      workdirOf(
        module({ source: "/w/ci/mod.just", settings: { working_directory: "../.." } }),
        recipe(),
        ROOT,
      ),
    ).toBe("/");
    expect(
      workdirOf(
        module({
          source: "/w/ci/mod.just",
          settings: { working_directory: "../..config" },
        }),
        recipe(),
        ROOT,
      ),
    ).toBe("..config");
  });

  it("is cancelled by `[no-cd]` on the recipe and by `set no-cd` on the module", () => {
    expect(
      workdirOf(module({ source: "/w/ci/mod.just" }), recipe(["no-cd"]), ROOT),
    ).toBeNull();
    expect(
      workdirOf(
        module({ source: "/w/ci/mod.just", settings: { no_cd: true } }),
        recipe(),
        ROOT,
      ),
    ).toBeNull();
    expect(
      workdirOf(
        module({ source: "/w/ci/mod.just", settings: { working_directory: "/tmp" } }),
        recipe(["no-cd"]),
        ROOT,
      ),
    ).toBeNull();
  });
});
