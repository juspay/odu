/**
 * WHERE `just` RUNS A RECIPE — the fact PLAN 4.1's push depends on.
 *
 * A node's command is `just --no-deps <namepath>` from the workspace and
 * `just` does the chdir itself, so nothing about EXECUTION needs this. What
 * needs it is the `result*` glob: a recipe's out-links land in the directory
 * it ran in, and for a MODULE recipe that is the module's own directory. A
 * wrong answer globs a directory that is not there, finds nothing, and leaves
 * a green run that pushed nothing — the one silent failure mode in 4.1.
 *
 * The values below are `just`'s, checked against a real dump rather than
 * imagined: the first shape of this derived the directory from `module_path`
 * and every case passed, because every fixture was written as
 * `mod ci 'ci/mod.just'` where the module's NAME happens to equal its
 * directory. `module_path` is the namepath — `ci`, and `a::b` for anything
 * nested — so the only field that says where a module lives is `source`.
 */

import { describe, expect, it } from "bun:test";
import { workdirOf } from "./ingest";

/** The root justfile's `source`, which is what every module's directory is
 *  expressed against. */
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
    // A dump from a `just` too old to emit `source` answers the same rather
    // than guessing: the root is what a single-file justfile has.
    expect(workdirOf(module(), recipe(), ROOT)).toBeNull();
    expect(workdirOf(module({ source: ROOT }), recipe(), undefined)).toBeNull();
  });

  it("is the module's DIRECTORY, which is not its name", () => {
    // `mod ci 'tooling/mod.just'` — `module_path` is `ci` and the recipe runs
    // in `tooling`. The two differ whenever a repository puts its CI module
    // somewhere other than a directory of the same name, and `module_path`
    // sent the glob to `w/ci`, which does not exist.
    expect(
      workdirOf(
        module({ source: "/w/tooling/mod.just", module_path: "ci" }),
        recipe(),
        ROOT,
      ),
    ).toBe("tooling");
  });

  it("is the NESTED module's directory, where module_path is never a path", () => {
    // `mod a 'a/mod.just'` → `mod b 'b/mod.just'` dumps `module_path: "a::b"`
    // for the inner one — not a path in any layout, so the old derivation
    // globbed `w/a::b` for EVERY nested module, including the conventional
    // name-equals-directory one.
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
    // odu's own `ci/mod.just` is exactly this: a module that pins itself back
    // to the repository root.
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
    // `just` honours an absolute `set working-directory` verbatim — checked
    // against a real one — so the recipe did not run in the workspace at all.
    // The answer says so rather than pretending it did: the caller refuses to
    // glob it and prints why, because a `result` link in a shared directory
    // belongs to whoever left it there.
    expect(
      workdirOf(
        module({ source: "/w/ci/mod.just", settings: { working_directory: "/tmp" } }),
        recipe(),
        ROOT,
      ),
    ).toBe("/tmp");
    // A RELATIVE PATH THAT CLIMBS PAST THE ROOT is the same thing in
    // different clothing, and is answered the same way.
    expect(
      workdirOf(
        module({ source: "/w/ci/mod.just", settings: { working_directory: "../.." } }),
        recipe(),
        ROOT,
      ),
    ).toBe("/");
    // AND A DIRECTORY HONESTLY NAMED `..config` is inside the workspace: the
    // escape test is the first SEGMENT, not a string prefix.
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
    // Both leave the recipe in the directory `just` was INVOKED from, which
    // for every node odu runs is the workspace root.
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
    // AND IT BEATS `working-directory`, which is `just`'s own order — the
    // absolute one included.
    expect(
      workdirOf(
        module({ source: "/w/ci/mod.just", settings: { working_directory: "/tmp" } }),
        recipe(["no-cd"]),
        ROOT,
      ),
    ).toBeNull();
  });
});
