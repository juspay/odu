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

/** The keys spelled directly under the mapping opened at `headerIndex`: the
 *  first deeper indent is the mapping's own depth, and only lines at exactly
 *  that depth are its keys. A NARROW reader on purpose — this repo depends on
 *  no YAML parser (`yaml` is in the lockfile only as cucumber's transitive
 *  dependency), and two facts out of two files do not buy one. */
function keysUnder(lines: readonly string[], headerIndex: number): string[] {
  const header = lines[headerIndex] ?? "";
  const headerIndent = header.length - header.trimStart().length;
  const keys: string[] = [];
  let depth: number | null = null;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= headerIndent) break; // dedent: the mapping ended
    if (depth === null) depth = indent;
    if (indent !== depth) continue; // a value's own lines, not a key here
    const key = /^([A-Za-z][A-Za-z0-9_-]*):/.exec(line.trim());
    if (key?.[1] !== undefined) keys.push(key[1]);
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

  const stepIndent = (workflow[stepIndex] ?? "").indexOf("-");
  let withIndex = -1;
  for (let i = stepIndex + 1; i < workflow.length; i += 1) {
    const line = workflow[i] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (line.length - line.trimStart().length <= stepIndent) break;
    if (line.trim() === "with:") {
      withIndex = i;
      break;
    }
  }
  expect(withIndex).toBeGreaterThanOrEqual(0);
  const given = keysUnder(workflow, withIndex);

  // THE EXAMPLE CANNOT DRIFT FROM THE ACTION'S REAL INPUT NAMES: every key it
  // passes is one `action.yml` declares, so renaming an input breaks this
  // before it breaks a reader's workflow.
  const action = readFileSync(
    join(REPO, ".github", "actions", "push", "action.yml"),
    "utf-8",
  ).split("\n");
  const inputsIndex = action.findIndex((line) => line.trimEnd() === "inputs:");
  expect(inputsIndex).toBeGreaterThanOrEqual(0);
  const declared = keysUnder(action, inputsIndex);
  expect(declared.sort()).toEqual(["cache", "paths", "pin", "token"]);
  expect(given.filter((key) => !declared.includes(key))).toEqual([]);

  // AND IT PASSES EXACTLY TWO, which is the page's claim about this step. No
  // `cache:` — the whole point is that `./flake.nix` already named it and the
  // step asks `odu cache target` for it. No `paths:` — the default pushes the
  // whole flake for this runner's system. Either one appearing here makes the
  // page say one thing and the example do another.
  expect(given).toEqual(["token", "pin"]);
});
