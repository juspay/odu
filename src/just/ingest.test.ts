import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arch, platform as osPlatform } from "node:process";
import { afterAll, describe, expect, it } from "vitest";
import {
  laneTasks,
  loadJustPipeline,
  mermaidGraph,
  parseSelector,
  pipelineFromDump,
  recipeRunsOn,
} from "./ingest";

const hasJust =
  spawnSync("just", ["--version"], { encoding: "utf-8" }).status === 0;

/** A `just --dump` recipe node in module `ci` (namepath `ci::<name>`), shaped
 *  like real `just --dump --dump-format json` output. Shared by the synthetic
 *  fixtures below. */
function ciRecipe(
  name: string,
  deps: string[],
  opts: { attributes?: unknown[]; body?: unknown[] } = {},
): unknown {
  return {
    name,
    namepath: `ci::${name}`,
    attributes: opts.attributes ?? [],
    body: opts.body ?? [["echo hi"]],
    dependencies: deps.map((d) => ({ arguments: [], recipe: d })),
  };
}

/** A synthetic `just --dump --dump-format json` tree shaped like kolu's:
 *  an empty-bodied `[metadata("ci")]` root in module `ci`, an `install`
 *  funnel, and coordinator-side recipes that must never schedule. */
function dump(): unknown {
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
          default: ciRecipe("default", ["nix", "e2e", "unit", "smoke"], {
            attributes: ["linux", "macos", { metadata: ["ci"] }, "parallel"],
            body: [],
          }),
          install: ciRecipe("install", []),
          nix: ciRecipe("nix", []),
          smoke: ciRecipe("smoke", []),
          e2e: ciRecipe("e2e", ["install"]),
          unit: ciRecipe("unit", ["install"]),
          "pool-ensure": ciRecipe("pool-ensure", []),
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

/** A *synthetic* dump exercising the pure filtering logic — both a `[linux]`
 *  and a `[macos]` recipe present at once, which real `just --dump` never emits
 *  from a single coordinator (see the "real just --dump" suite for the actual
 *  contract). `deployer` (no OS attribute) depends on the linux-only recipe so
 *  the cascade is observable; `everywhere` is `[parallel]` to prove a non-OS
 *  attribute imposes no platform restriction. */
function osDump(): unknown {
  const tagged = (name: string, attr: string): unknown =>
    ciRecipe(name, [], { attributes: [attr] });
  return {
    recipes: {},
    modules: {
      ci: {
        recipes: {
          default: ciRecipe(
            "default",
            ["everywhere", "linuxOnly", "macOnly", "unixOnly", "deployer"],
            { attributes: [{ metadata: ["ci"] }], body: [] },
          ),
          everywhere: tagged("everywhere", "parallel"),
          linuxOnly: tagged("linuxOnly", "linux"),
          macOnly: tagged("macOnly", "macos"),
          unixOnly: tagged("unixOnly", "unix"),
          deployer: ciRecipe("deployer", ["linuxOnly"]),
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

  it("covers just's other built-in OS attributes", () => {
    // Every OS-enabling attribute just 1.50 accepts beyond linux/macos/unix.
    expect(recipeRunsOn(["windows"], "x86_64-windows")).toBe(true);
    expect(recipeRunsOn(["openbsd"], "x86_64-openbsd")).toBe(true);
    expect(recipeRunsOn(["freebsd"], "x86_64-freebsd")).toBe(true);
    expect(recipeRunsOn(["netbsd"], "x86_64-netbsd")).toBe(true);
    expect(recipeRunsOn(["dragonfly"], "x86_64-dragonfly")).toBe(true);
    expect(recipeRunsOn(["android"], "aarch64-android")).toBe(true);
    // each restricts to its own OS, not "runs everywhere"
    expect(recipeRunsOn(["freebsd"], "x86_64-linux")).toBe(false);
    expect(recipeRunsOn(["android"], "aarch64-darwin")).toBe(false);
    // [unix] excludes windows but includes the BSDs and android
    expect(recipeRunsOn(["unix"], "x86_64-freebsd")).toBe(true);
    expect(recipeRunsOn(["unix"], "x86_64-windows")).toBe(false);
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

/**
 * The real-`just` dump path. The synthetic `osDump()` above feeds both a
 * `[linux]` and a `[macos]` recipe through `pipelineFromDump`, but a single
 * coordinator's `just --dump --dump-format json` *never* yields that input:
 * `just` resolves OS attributes before emitting JSON, so a recipe whose OS
 * doesn't match the coordinator is absent from the dump entirely. These tests
 * pin the resulting contract — OS attributes reliably *prune* same-OS recipes
 * off foreign lanes, but cannot *introduce* a foreign-OS recipe — so a future
 * change can't silently regress (or over-promise) it.
 */
describe.skipIf(!hasJust)("loadJustPipeline (real just --dump)", () => {
  const coordinatorOs = osPlatform === "darwin" ? "macos" : "linux";
  const sameOsPlatform =
    osPlatform === "darwin" ? `${arch}-darwin` : `${arch}-linux`;
  const foreignOsPlatform =
    osPlatform === "darwin" ? `${arch}-linux` : `${arch}-darwin`;
  const foreignOsAttr = osPlatform === "darwin" ? "linux" : "macos";

  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const justfileDir = (contents: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "odu-just-"));
    dirs.push(dir);
    writeFileSync(join(dir, "justfile"), contents);
    return dir;
  };

  it("prunes a coordinator-OS recipe off the foreign lane (the working case)", () => {
    const dir = justfileDir(
      [
        '[metadata("ci")]',
        "default: same-os portable",
        "",
        `[${coordinatorOs}]`,
        "same-os:",
        "    echo same",
        "",
        "portable:",
        "    echo portable",
        "",
      ].join("\n"),
    );
    const spec = loadJustPipeline(dir);
    // The coordinator-OS recipe is in the dump, tagged with its OS.
    expect(spec.tasks.find((t) => t.id === "same-os")?.os).toEqual([
      coordinatorOs,
    ]);
    const same = laneTasks(spec, sameOsPlatform, [], false).map((t) => t.id);
    const foreign = laneTasks(spec, foreignOsPlatform, [], false).map(
      (t) => t.id,
    );
    expect(same).toContain("same-os");
    expect(same).toContain("portable");
    expect(foreign).not.toContain("same-os"); // pruned off the foreign lane
    expect(foreign).toContain("portable"); // untagged still fans out
  });

  it("cannot see a foreign-OS recipe — just drops it from the JSON dump (the limitation)", () => {
    const dir = justfileDir(
      [
        '[metadata("ci")]',
        "default: portable",
        "",
        `[${foreignOsAttr}]`,
        "foreign-os:",
        "    echo foreign",
        "",
        "portable:",
        "    echo portable",
        "",
      ].join("\n"),
    );
    const spec = loadJustPipeline(dir);
    // The foreign-OS recipe is absent from the coordinator's dump entirely, so
    // it never schedules on *any* lane, including its own target OS.
    expect(spec.tasks.find((t) => t.id === "foreign-os")).toBeUndefined();
    const foreign = laneTasks(spec, foreignOsPlatform, [], false).map(
      (t) => t.id,
    );
    expect(foreign).not.toContain("foreign-os");
  });
});
