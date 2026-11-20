import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dirname;
const REPO = join(HERE, "..", "..");

const declared: string = (
  JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
  }
).devDependencies.playwright as string;

test("PIN (playwright): the npm side is an exact version, never a range", () => {
  expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
});

const haveNix = spawnSync("sh", ["-c", "command -v nix"], { encoding: "utf-8" }).status === 0;

test.skipIf(!haveNix)(
  "PIN (playwright): the npm pin is the version the pinned nixpkgs carries",
  () => {
    const inNixpkgs = execFileSync(
      "nix",
      [
        "eval",
        "--impure",
        "--raw",
        "--expr",
        "(import ./nix/nixpkgs.nix {}).playwright-driver.version",
      ],
      { cwd: REPO, encoding: "utf-8" },
    ).trim();
    expect(declared).toBe(inNixpkgs);
  },
  120_000,
);
