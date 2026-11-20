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

    expect(spec.name).toBe("default");
    const byId = new Map(spec.tasks.map((task) => [task.id, task]));
    expect([...byId.keys()].sort()).toEqual([
      "build",
      "docs",
      "e2e",
      "lint",
      "test",
    ]);

    expect(byId.get("test")?.needs).toEqual(["build"]);
    expect(byId.get("e2e")?.needs).toEqual(["build"]);
    expect(byId.get("build")?.needs).toEqual([]);
    expect(byId.get("docs")?.needs).toEqual([]);
    expect(byId.get("lint")?.needs).toEqual([]);

    for (const task of spec.tasks) {
      expect(task.os ?? [], `${task.id} carries an OS attribute`).toEqual([]);
    }

    expect(byId.get("e2e")?.shards).toBe(2);
    expect(byId.get("test")?.shards).toBeUndefined();

    expect(byId.get("build")?.pin).toEqual([null]);
    expect(byId.get("docs")?.pin).toBeUndefined();
  },
);

it(
  "declares ONE substituter in flake.nix, and trusts that bucket's own key",
  async () => {
    const read = await readFlakeNixConfig(
      EXAMPLE,
      nixEvalFlakeConfig(process.env),
    );
    expect(read).toMatchObject({ ok: true });
    if (!read.ok) return;

    expect(read.config.substituters).toHaveLength(1);
    const substituter = read.config.substituters[0] ?? "";
    const bucket = new URL(substituter).pathname.split("/").filter(Boolean).pop();
    expect(bucket).toBeTruthy();

    expect(
      read.config.trustedPublicKeys.map((key) => key.split(":")[0]),
    ).toEqual([`${bucket}-1`]);
  },
  120_000,
);

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
    if (indent <= headerIndent) break;
    if (depth === null) depth = indent;
    if (indent !== depth) continue;
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

  const stepIndex = workflow.findIndex((line) =>
    /^\s*-\s+uses:\s*\S*\/\.github\/actions\/push@/.test(line),
  );
  expect(stepIndex).toBeGreaterThanOrEqual(0);
  const uses = /^\s*-\s+uses:\s*(\S+)/.exec(workflow[stepIndex] ?? "")?.[1] ?? "";
  expect(uses.startsWith("juspay/odu/.github/actions/push@")).toBe(true);

  const withIndex =
    keysUnder(workflow, stepIndex).find((key) => key.name === "with")?.index ?? -1;
  expect(withIndex).toBeGreaterThanOrEqual(0);
  const given = keysUnder(workflow, withIndex).map((key) => key.name);

  const action = readFileSync(
    join(REPO, ".github", "actions", "push", "action.yml"),
    "utf-8",
  ).split("\n");
  const inputsIndex = action.findIndex((line) => line.trimEnd() === "inputs:");
  expect(inputsIndex).toBeGreaterThanOrEqual(0);
  const declared = keysUnder(action, inputsIndex).map((key) => key.name);
  expect(declared).toContain("cache");
  expect(given.filter((key) => !declared.includes(key))).toEqual([]);

  expect(given).toEqual(["token"]);
});
