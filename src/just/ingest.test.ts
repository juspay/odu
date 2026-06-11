import { describe, expect, it } from "vitest";
import {
  laneTasks,
  mermaidGraph,
  parseSelector,
  pipelineFromDump,
  recipeRunsOn,
} from "./ingest";

/** A synthetic `just --dump --dump-format json` tree shaped like kolu's:
 *  an empty-bodied `[metadata("ci")]` root in module `ci`, an `install`
 *  funnel, and coordinator-side recipes that must never schedule. */
function dump(): unknown {
  const recipe = (
    name: string,
    deps: string[],
    opts: { attributes?: unknown[]; body?: unknown[] } = {},
  ): unknown => ({
    name,
    namepath: `ci::${name}`,
    attributes: opts.attributes ?? [],
    body: opts.body ?? [["echo hi"]],
    dependencies: deps.map((d) => ({ arguments: [], recipe: d })),
  });
  return {
    recipes: {
      fmt: {
        name: "fmt",
        namepath: "fmt",
        attributes: [],
        body: [["biome format"]],
        dependencies: [],
      },
    },
    modules: {
      ci: {
        recipes: {
          default: recipe("default", ["nix", "e2e", "unit", "smoke"], {
            attributes: ["linux", "macos", { metadata: ["ci"] }, "parallel"],
            body: [],
          }),
          install: recipe("install", []),
          nix: recipe("nix", []),
          smoke: recipe("smoke", []),
          e2e: recipe("e2e", ["install"]),
          unit: recipe("unit", ["install"]),
          "pool-ensure": recipe("pool-ensure", []),
        },
        modules: {},
      },
    },
  };
}

describe("pipelineFromDump", () => {
  it("discovers the [metadata('ci')] root and expands only its reachable subgraph", () => {
    const spec = pipelineFromDump(dump());
    expect(spec.name).toBe("ci::default");
    expect(spec.tasks.map((t) => t.id).sort()).toEqual([
      "ci::e2e",
      "ci::install",
      "ci::nix",
      "ci::smoke",
      "ci::unit",
    ]);
    // pool-ensure lives in the module but is not reachable from the root
    expect(spec.tasks.find((t) => t.id === "ci::pool-ensure")).toBeUndefined();
  });

  it("excludes the empty-bodied root as a node and runs leaves via --no-deps", () => {
    const spec = pipelineFromDump(dump());
    expect(spec.tasks.find((t) => t.id === "ci::default")).toBeUndefined();
    const e2e = spec.tasks.find((t) => t.id === "ci::e2e");
    expect(e2e?.command).toBe("just --no-deps ci::e2e");
    expect(e2e?.needs).toEqual(["ci::install"]);
  });

  it("orders dependencies before dependents", () => {
    const spec = pipelineFromDump(dump());
    const ids = spec.tasks.map((t) => t.id);
    expect(ids.indexOf("ci::install")).toBeLessThan(ids.indexOf("ci::e2e"));
    expect(ids.indexOf("ci::install")).toBeLessThan(ids.indexOf("ci::unit"));
  });

  it("includes a --root override's own body-bearing recipe as a node", () => {
    const spec = pipelineFromDump(dump(), { root: "ci::e2e" });
    expect(spec.tasks.map((t) => t.id).sort()).toEqual([
      "ci::e2e",
      "ci::install",
    ]);
  });

  it("rejects an unknown --root and a missing ci tag", () => {
    expect(() => pipelineFromDump(dump(), { root: "nope" })).toThrow(
      /no recipe named/,
    );
    expect(() => pipelineFromDump({ recipes: {}, modules: {} })).toThrow(
      /expected exactly one/,
    );
  });
});

describe("selectors", () => {
  const spec = pipelineFromDump(dump());

  it("parses recipe and recipe@platform forms", () => {
    expect(parseSelector("e2e")).toEqual({ recipe: "e2e" });
    expect(parseSelector("ci::e2e@x86_64-linux")).toEqual({
      recipe: "ci::e2e",
      platform: "x86_64-linux",
    });
  });

  it("matches bare leaf names against namepaths", () => {
    const tasks = laneTasks(spec, "x86_64-linux", [{ recipe: "e2e" }], false);
    expect(tasks.map((t) => t.id).sort()).toEqual(["ci::e2e", "ci::install"]);
  });

  it("--no-deps skips the dependency closure", () => {
    const tasks = laneTasks(spec, "x86_64-linux", [{ recipe: "e2e" }], true);
    expect(tasks.map((t) => t.id)).toEqual(["ci::e2e"]);
    expect(tasks[0]?.needs).toEqual([]); // pruned: install is not in the lane
  });

  it("platform-pinned selectors slice other lanes to nothing", () => {
    const pinned = [{ recipe: "ci::e2e", platform: "aarch64-darwin" }];
    expect(laneTasks(spec, "aarch64-darwin", pinned, false)).not.toHaveLength(
      0,
    );
    expect(laneTasks(spec, "x86_64-linux", pinned, false)).toHaveLength(0);
  });

  it("no selectors means the whole pipeline", () => {
    expect(laneTasks(spec, "x86_64-linux", [], false)).toHaveLength(5);
  });

  it("rejects unknown recipes", () => {
    expect(() =>
      laneTasks(spec, "x86_64-linux", [{ recipe: "nopenope" }], false),
    ).toThrow(/matches no pipeline recipe/);
  });
});

/** A dump whose leaves carry OS-family attributes, plus `deployer` (no OS
 *  attribute of its own) depending on the linux-only recipe — so the cascade
 *  is observable. `everywhere` is tagged `[parallel]` to prove a non-OS
 *  attribute imposes no platform restriction. */
function osDump(): unknown {
  const r = (
    name: string,
    deps: string[],
    attributes: unknown[] = [],
  ): unknown => ({
    name,
    namepath: `ci::${name}`,
    attributes,
    body: [["echo hi"]],
    dependencies: deps.map((d) => ({ arguments: [], recipe: d })),
  });
  return {
    recipes: {},
    modules: {
      ci: {
        recipes: {
          default: {
            name: "default",
            namepath: "ci::default",
            attributes: [{ metadata: ["ci"] }],
            body: [],
            dependencies: [
              "everywhere",
              "linuxOnly",
              "macOnly",
              "unixOnly",
              "deployer",
            ].map((d) => ({ arguments: [], recipe: d })),
          },
          everywhere: r("everywhere", [], ["parallel"]),
          linuxOnly: r("linuxOnly", [], ["linux"]),
          macOnly: r("macOnly", [], ["macos"]),
          unixOnly: r("unixOnly", [], ["unix"]),
          deployer: r("deployer", ["linuxOnly"]),
        },
        modules: {},
      },
    },
  };
}

describe("recipeRunsOn", () => {
  it("no OS attributes ⇒ every platform", () => {
    expect(recipeRunsOn([], "x86_64-linux")).toBe(true);
    expect(recipeRunsOn([], "aarch64-darwin")).toBe(true);
  });

  it("[linux] / [macos] match their own OS only", () => {
    expect(recipeRunsOn(["linux"], "x86_64-linux")).toBe(true);
    expect(recipeRunsOn(["linux"], "aarch64-darwin")).toBe(false);
    expect(recipeRunsOn(["macos"], "aarch64-darwin")).toBe(true);
    expect(recipeRunsOn(["macos"], "x86_64-linux")).toBe(false);
  });

  it("[unix] matches linux and darwin but not windows", () => {
    expect(recipeRunsOn(["unix"], "x86_64-linux")).toBe(true);
    expect(recipeRunsOn(["unix"], "aarch64-darwin")).toBe(true);
    expect(recipeRunsOn(["unix"], "x86_64-windows")).toBe(false);
  });

  it("multiple OS attributes are OR-ed", () => {
    expect(recipeRunsOn(["linux", "macos"], "aarch64-darwin")).toBe(true);
    expect(recipeRunsOn(["linux", "macos"], "x86_64-linux")).toBe(true);
  });
});

describe("platform filtering", () => {
  const spec = pipelineFromDump(osDump());

  it("records each recipe's OS-family attributes on the task", () => {
    const os = (id: string) => spec.tasks.find((t) => t.id === id)?.os;
    expect(os("ci::linuxOnly")).toEqual(["linux"]);
    expect(os("ci::macOnly")).toEqual(["macos"]);
    expect(os("ci::unixOnly")).toEqual(["unix"]);
    expect(os("ci::everywhere")).toEqual([]); // [parallel] is not an OS attr
  });

  it("a [linux] recipe schedules on linux, not on darwin", () => {
    const linux = laneTasks(spec, "x86_64-linux", [], false).map((t) => t.id);
    const darwin = laneTasks(spec, "aarch64-darwin", [], false).map((t) => t.id);
    expect(linux).toContain("ci::linuxOnly");
    expect(darwin).not.toContain("ci::linuxOnly");
  });

  it("a [macos] recipe schedules on darwin, not on linux", () => {
    const linux = laneTasks(spec, "x86_64-linux", [], false).map((t) => t.id);
    const darwin = laneTasks(spec, "aarch64-darwin", [], false).map((t) => t.id);
    expect(darwin).toContain("ci::macOnly");
    expect(linux).not.toContain("ci::macOnly");
  });

  it("[unix] and untagged recipes schedule on every platform", () => {
    for (const platform of ["x86_64-linux", "aarch64-darwin"]) {
      const ids = laneTasks(spec, platform, [], false).map((t) => t.id);
      expect(ids).toContain("ci::unixOnly");
      expect(ids).toContain("ci::everywhere");
    }
  });

  it("cascades: a dependent of a pruned recipe is pruned on that platform too", () => {
    // deployer needs linuxOnly; on darwin linuxOnly is gone, so deployer is too.
    const darwin = laneTasks(spec, "aarch64-darwin", [], false).map((t) => t.id);
    expect(darwin).not.toContain("ci::deployer");
    const linux = laneTasks(spec, "x86_64-linux", [], false).map((t) => t.id);
    expect(linux).toContain("ci::deployer");
  });

  it("a selector for a recipe absent on a lane yields no tasks there", () => {
    const darwin = laneTasks(
      spec,
      "aarch64-darwin",
      [{ recipe: "linuxOnly" }],
      false,
    );
    expect(darwin).toHaveLength(0);
    const linux = laneTasks(
      spec,
      "x86_64-linux",
      [{ recipe: "linuxOnly" }],
      false,
    );
    expect(linux.map((t) => t.id)).toEqual(["ci::linuxOnly"]);
  });
});

describe("mermaidGraph", () => {
  it("emits one node per task and one edge per dependency", () => {
    const graph = mermaidGraph(pipelineFromDump(dump()));
    expect(graph).toContain("flowchart TD");
    expect(graph).toContain('ci__e2e["ci::e2e"]');
    expect(graph).toContain("ci__install --> ci__e2e");
  });
});
