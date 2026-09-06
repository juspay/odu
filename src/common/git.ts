/**
 * Minimal git probes for the MCP face's durable-log fallback: when no run is
 * live, a log read resolves `.ci/<sha7>/<platform>/<node>.log` directly, which
 * needs the repo root and the current short SHA. Best-effort — a non-git cwd
 * or a missing HEAD returns `null`, and the caller reports "missing".
 */

import { spawnSync } from "node:child_process";
import { shortSha } from "@odu/run-history/ids";

function git(args: string[]): string | null {
  const result = spawnSync("git", args, { encoding: "utf-8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Re-exported, not re-defined: the prefix rule lives with the other identity
 *  spellings in `@odu/run-history/ids`, because `<sha7>#<seq>` is a run's
 *  display ref and the two halves of it must not fork per consumer. Kept
 *  reachable from here so the many call sites that already ask this module for
 *  git facts do not each learn a second import path. */
export { shortSha };

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

/** A run-context resolver pinned to one NAMED checkout (an absolute repo
 *  root — the `mcp/agentSurface.ResolveRunContext` shape) rather than the
 *  process's cwd: the per-call form `wait_for_settle`'s `checkout` argument
 *  needs. The root is taken as given (the tool's contract is "the checkout
 *  root"); only the SHA is probed, and an unreadable HEAD still resolves to
 *  `null`, same as the cwd probe. */
export function gitRunContextFor(
  repoRoot: string,
): () => { repoRoot: string; sha7: string } | null {
  return () => {
    const sha7 = headSha7(repoRoot);
    return sha7 === null ? null : { repoRoot, sha7 };
  };
}
