/**
 * THE EXAMPLE THE DOCS PAGE SHOWS, read back by odu's OWN readers.
 *
 * `examples/consumer/` is not a sample: it is the four files the consumer page
 * quotes line for line — a justfile, a `flake.nix`, a push workflow and a
 * `plugin.json`. A page whose snippets no longer parse under the code they
 * describe is worse than no page, because a reader copies it and finds out
 * from their own CI. So every claim the page makes is asserted here against
 * the reader that will actually read it: `loadJustPipeline` for the DAG and
 * its metadata, `readFlakeNixConfig` for the one cache declaration, and the
 * push action's own `inputs:` for the workflow step.
 *
 * No network and no service: a `just --dump` and a restricted `nix eval`.
 */

import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadJustPipeline } from "@odu/execution/just/ingest";
import { nixEvalFlakeConfig, readFlakeNixConfig } from "@odu/cache/push";

const REPO = join(import.meta.dir, "..");
const EXAMPLE = join(REPO, "examples", "consumer");

it(
  "resolves to the pipeline the page describes, metadata and all",
  () => {
    const spec = loadJustPipeline(EXAMPLE);

    // THE ROOT IS THE TAGGED RECIPE — `[metadata("ci")]` on `default` — and
    // the PIPELINE is what it depends on: the root names the run, the five it
    // lists are the nodes.
    expect(spec.name).toBe("default");
    const byId = new Map(spec.tasks.map((task) => [task.id, task]));
    expect([...byId.keys()].sort()).toEqual([
      "build",
      "docs",
      "e2e",
      "lint",
      "test",
    ]);

    // The edges the page draws: two recipes wait for `build`, three do not —
    // and `test-slice`, being `[private]` and unreachable from the root, is
    // not a node at all.
    expect(byId.get("test")?.needs).toEqual(["build"]);
    expect(byId.get("e2e")?.needs).toEqual(["build"]);
    expect(byId.get("build")?.needs).toEqual([]);
    expect(byId.get("docs")?.needs).toEqual([]);
    expect(byId.get("lint")?.needs).toEqual([]);

    // NO OS ATTRIBUTE ANYWHERE, and that is the assertion: `just` hides an
    // OS-mismatched recipe from the machine that reads the file, so a
    // `[linux]` recipe on a dependency of the root makes `just --dump` refuse
    // this justfile on a Mac — odu's own `ci/mod.just` carries the same note
    // around `nixos-module` (lines 36–47). An example a reader COPIES must
    // load on every OS, so the page explains `[linux]` and this file wears
    // none.
    for (const task of spec.tasks) {
      expect(task.os ?? [], `${task.id} carries an OS attribute`).toEqual([]);
    }

    // `odu:shard=2` IS THE SHARD CEILING, and only a leaf may carry it.
    expect(byId.get("e2e")?.shards).toBe(2);
    expect(byId.get("test")?.shards).toBeUndefined();

    // A BARE `odu:pin` IS THE DEFAULT BRANCH, and the page's table says so:
    // the field is the list of refs this recipe pins on, `null` meaning the
    // repository's default branch, which the coordinator resolves. A run on
    // another ref pushes this closure and pins nothing. It sits on `build`,
    // which two recipes depend on — a pin, unlike a shard, has no leaf rule.
    expect(byId.get("build")?.pin).toEqual([null]);
    expect(byId.get("docs")?.pin).toBeUndefined();
  },
);

it(
  "declares ONE substituter in flake.nix, and trusts that bucket's own key",
  async () => {
    // The real reader against a real `nix` — the same restricted evaluation
    // `odu cache push` and `odu cache target` run over a checkout.
    const read = await readFlakeNixConfig(
      EXAMPLE,
      nixEvalFlakeConfig(process.env),
    );
    expect(read).toMatchObject({ ok: true });
    if (!read.ok) return;

    // ONE odu cache: two is refused at the start of a run, so the example must
    // never grow a second line.
    expect(read.config.substituters).toHaveLength(1);
    const substituter = read.config.substituters[0] ?? "";
    const bucket = new URL(substituter).pathname.split("/").filter(Boolean).pop();
    expect(bucket).toBeTruthy();

    // THE TWO LINES ARE ONE FACT. A bucket signs with the key named
    // `<bucket>-1` (`generateKeypair`, and every bucket page prints the pair
    // together), so a key named anything else is some other bucket's — the
    // paste error that leaves every path this repository substitutes
    // untrusted and silently rebuilt.
    expect(
      read.config.trustedPublicKeys.map((key) => key.split(":")[0]),
    ).toEqual([`${bucket}-1`]);
  },
  120_000,
);

/** The keys spelled directly under the mapping opened at `headerIndex`, with
 *  the line each sits on: the first deeper indent is the mapping's own depth,
 *  and only lines at exactly that depth are its keys. A NARROW reader on
 *  purpose — this repo depends on no YAML parser (`yaml` is in the lockfile
 *  only as cucumber's transitive dependency), and three facts out of two
 *  files do not buy one. The INDEX is what lets a nested mapping be found by
 *  the same walk that reads a flat one, instead of a second copy of this
 *  rule. */
function keysUnder(
  lines: readonly string[],
  headerIndex: number,
): { name: string; index: number }[] {
  const header = lines[headerIndex] ?? "";
  const headerIndent = header.length - header.trimStart().length;
  const keys: { name: string; index: number }[] = [];
  let depth: number | null = null;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= headerIndent) break; // dedent: the mapping ended
    if (depth === null) depth = indent;
    if (indent !== depth) continue; // a value's own lines, not a key here
    const key = /^([A-Za-z][A-Za-z0-9_-]*):/.exec(line.trim());
    if (key?.[1] !== undefined) keys.push({ name: key[1], index: i });
  }
  return keys;
}

it("pushes with THIS repository's action, and only inputs it declares", () => {
  const workflow = readFileSync(
    join(EXAMPLE, ".github", "workflows", "cache.yml"),
    "utf-8",
  ).split("\n");

  // The step under test, found by the action it names rather than by position.
  const stepIndex = workflow.findIndex((line) =>
    /^\s*-\s+uses:\s*\S*\/\.github\/actions\/push@/.test(line),
  );
  expect(stepIndex).toBeGreaterThanOrEqual(0);
  const uses = /^\s*-\s+uses:\s*(\S+)/.exec(workflow[stepIndex] ?? "")?.[1] ?? "";
  // THIS repository's action, not a fork's and not a copy: the example is
  // pinned to odu, and the `@<rev>` is the one line a consumer bumps.
  expect(uses.startsWith("juspay/odu/.github/actions/push@")).toBe(true);

  // The step's own `with:`, found by the same walk that then reads its keys.
  const withIndex =
    keysUnder(workflow, stepIndex).find((key) => key.name === "with")?.index ?? -1;
  expect(withIndex).toBeGreaterThanOrEqual(0);
  const given = keysUnder(workflow, withIndex).map((key) => key.name);

  // THE EXAMPLE CANNOT DRIFT FROM THE ACTION'S REAL INPUT NAMES: every key it
  // passes is one `action.yml` declares, so renaming an input breaks this
  // before it breaks a reader's workflow.
  const action = readFileSync(
    join(REPO, ".github", "actions", "push", "action.yml"),
    "utf-8",
  ).split("\n");
  const inputsIndex = action.findIndex((line) => line.trimEnd() === "inputs:");
  expect(inputsIndex).toBeGreaterThanOrEqual(0);
  const declared = keysUnder(action, inputsIndex).map((key) => key.name);
  // Non-vacuity, and the one input this example's thesis needs to EXIST:
  // `cache:` is declared and deliberately not passed. What else the action
  // declares is the action's business and may grow without touching a page.
  expect(declared).toContain("cache");
  expect(given.filter((key) => !declared.includes(key))).toEqual([]);

  // AND IT PASSES EXACTLY ONE, which is the page's claim about this step. No
  // `cache:` — the whole point is that `./flake.nix` already named it and the
  // step asks `odu cache target` for it. No `paths:` — the default pushes the
  // whole flake for this runner's system. No `pin:` either — the action pins
  // on the default branch by default. Any of them appearing here makes the
  // page say one thing and the example do another.
  expect(given).toEqual(["token"]);
});
