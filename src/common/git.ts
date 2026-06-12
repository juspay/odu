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

/** The 7-char short form of a commit sha — the one place the prefix rule
 *  lives, so every reader derives the short sha mechanically rather than
 *  trusting a stored copy. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
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
  return sha.status === 0 ? shortSha(sha.stdout.trim()) : null;
}

/** The durable-log identity from the process's real git: the repo root and the
 *  current short SHA. Returns `null` outside a git checkout (→ "missing" for
 *  any durable-log read). Used by both `mcpCommand` and the test harness. */
export function gitRunContext(): { repoRoot: string; sha7: string } | null {
  const repoRoot = gitTopLevel();
  const sha7 = headSha7(repoRoot);
  if (repoRoot === null || sha7 === null) return null;
  return { repoRoot, sha7 };
}
