/**
 * Black-box e2e harness: drive the real, nix-built `odu` binary against a
 * throwaway fixture repo and read back its `--progress json` stream.
 *
 * No imports from `src/` on purpose — the contract under test is the binary's
 * observable behavior (NDJSON shape + exit code), not its internals. See
 * tests/e2e/README.md for the design tradeoffs this harness commits to.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BIG = 256 * 1024 * 1024; // nix output / NDJSON can be chunky

/** The odu checkout under test — the worktree this test file lives in. */
export const repoRoot = execFileSync(
  "git",
  ["rev-parse", "--show-toplevel"],
  { cwd: here, encoding: "utf-8" },
).trim();

/** `path:` flake ref the fixture re-exports `odu-runner` from. */
export const oduFlakeRef = `path:${repoRoot}`;

/** One line of `odu run --progress json` output (src/coordinator/display.ts). */
export interface ProgressEvent {
  node: string; // fanId, e.g. "alpha@x86_64-linux"
  recipe: string; // just namepath, e.g. "alpha"
  platform: string; // e.g. "x86_64-linux"
  status: "running" | "success" | "failed" | "skipped" | "errored";
  exit_code?: number;
  log: string;
}

export interface RunResult {
  status: number | null;
  events: ProgressEvent[];
  stdout: string;
  stderr: string;
}

/**
 * Build `odu` (and warm `odu-runner`) from the worktree and return the path to
 * the `odu` executable. Prebuilding the runner means the fixture's in-flight
 * `nix eval …odu-runner.drvPath` resolves to an already-realised store path.
 */
export function buildOduBinary(): string {
  const build = (attr: string): string =>
    execFileSync(
      "nix",
      [
        "build",
        attr,
        "--no-link",
        "--print-out-paths",
        "--accept-flake-config",
      ],
      { cwd: repoRoot, encoding: "utf-8", maxBuffer: BIG },
    ).trim();

  const oduOut = build(".#odu");
  build(".#odu-runner"); // warm the store path the fixture will realise
  return join(oduOut, "bin", "odu");
}

/**
 * Materialize a fixture into a fresh temp git repo: the named fixture's
 * `justfile` plus a `flake.nix` re-exporting `odu-runner` from the checkout
 * under test. Flakes only see git-tracked files, so we commit before returning.
 */
export function makeFixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `odu-e2e-${name}-`));
  cpSync(join(here, "fixtures", name), dir, { recursive: true });

  const template = readFileSync(
    join(here, "fixtures", "_flake.nix.in"),
    "utf-8",
  );
  writeFileSync(
    join(dir, "flake.nix"),
    template.replaceAll("__ODU_FLAKE__", oduFlakeRef),
  );

  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
  };
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.email=e2e@odu.test",
    "-c",
    "user.name=odu e2e",
    "commit",
    "-q",
    "-m",
    "fixture",
  );
  return dir;
}

/** Run `odu run --no-strict --progress json` in `dir` and parse the stream. */
export function oduRun(
  oduBin: string,
  dir: string,
  selectors: string[] = [],
): RunResult {
  const res = spawnSync(
    oduBin,
    ["run", "--no-strict", "--progress", "json", ...selectors],
    { cwd: dir, encoding: "utf-8", maxBuffer: BIG },
  );
  const events: ProgressEvent[] = [];
  for (const line of res.stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as ProgressEvent);
    } catch {
      // non-JSON noise on stdout would be a contract violation; the test
      // asserts on `events`, so a stray line simply won't satisfy it.
    }
  }
  return { status: res.status, events, stdout: res.stdout, stderr: res.stderr };
}

/** The terminal (last-seen) status for each recipe across the event stream. */
export function terminalStatuses(
  events: ProgressEvent[],
): Map<string, ProgressEvent> {
  const last = new Map<string, ProgressEvent>();
  for (const e of events) last.set(e.recipe, e);
  return last;
}

/** Best-effort temp-dir cleanup; never throws (a left-behind tmp is harmless). */
export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
