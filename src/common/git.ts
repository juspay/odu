/**
 * Minimal git probes for the MCP face's durable-log fallback: when no run is
 * live, a log read resolves `.ci/<sha7>/<platform>/<node>.log` directly, which
 * needs the repo root and the current short SHA. Best-effort — a non-git cwd
 * or a missing HEAD returns `null`, and the caller reports "missing".
 */

import { spawnSync } from "node:child_process";

function git(args: string[]): string | null {
  const result = spawnSync("git", args, { encoding: "utf-8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function gitTopLevel(): string | null {
  return git(["rev-parse", "--show-toplevel"]);
}

export function headSha7(repoRoot: string | null): string | null {
  if (repoRoot === null) return null;
  const sha = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  return sha.status === 0 ? sha.stdout.trim().slice(0, 7) : null;
}
