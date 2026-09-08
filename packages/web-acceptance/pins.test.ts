/**
 * The npm/nixpkgs playwright pin, asserted rather than commented.
 *
 * The browsers come from `pkgs.playwright-driver.browsers` and the driver JS
 * comes from npm, and the driver refuses a browser build it was not compiled
 * against. When they drift, nothing fails at install time and nothing fails at
 * typecheck: the whole suite dies at `chromium.launch()` with `Executable
 * doesn't exist` naming a store path that IS there. That is minutes into a lane,
 * with nothing in the message pointing at a version number.
 *
 * Three things stand between this repo and that morning, and each catches a
 * different mistake:
 *
 *   1. THIS FILE — the npm side is spelled as an EXACT version, so a caret can
 *      never float it away from nixpkgs on its own.
 *   2. …and that it is the version the pinned nixpkgs actually carries, asked of
 *      Nix rather than copied into a comment.
 *   3. `support/hooks.ts` — the INSTALLED version matches the driver the running
 *      shell supplies. That is the runtime half, and it is what catches a stale
 *      `node_modules` or a shell entered from another checkout.
 *
 * Test 2 evaluates Nix, which is slow and needs the pins fetched, so it is
 * skipped where `nix` is not on PATH — a machine with no Nix cannot be running
 * this suite's browsers either, and the acceptance leg's own gate is the one
 * that has to be unskippable. Test 1 runs everywhere and is the one that fails
 * on a bad edit.
 */

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
  // `^1.61.1` installs 1.62 the day it ships and says nothing. The nixpkgs
  // driver does not move on the same day, and the failure lands on whoever next
  // runs the suite rather than on whoever widened the range.
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
