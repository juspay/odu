import { spawnSync } from "node:child_process";
import { shortSha } from "@odu/run-client/nodeId";

function git(args: string[]): string | null {
  const result = spawnSync("git", args, { encoding: "utf-8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

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

/** The branch `repoRoot` has checked out, or `null` for a detached HEAD. */
export function gitBranch(repoRoot: string): string | null {
  const ref = spawnSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  if (ref.status !== 0) return null;
  const name = ref.stdout.trim();
  return name === "" ? null : name;
}

/** The branch `origin` calls its default, read from the local
 *  `refs/remotes/origin/HEAD` ref, or `null` when this checkout has none. */
export function gitDefaultBranch(repoRoot: string): string | null {
  const ref = spawnSync(
    "git",
    ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"],
    { cwd: repoRoot, encoding: "utf-8" },
  );
  if (ref.status !== 0) return null;
  const name = ref.stdout.trim();
  const prefix = "refs/remotes/origin/";
  return name.startsWith(prefix) && name.length > prefix.length
    ? name.slice(prefix.length)
    : null;
}

/** The repo root and current short SHA; `null` outside a git checkout. */
export function gitRunContext(): { repoRoot: string; sha7: string } | null {
  const repoRoot = gitTopLevel();
  const sha7 = headSha7(repoRoot);
  if (repoRoot === null || sha7 === null) return null;
  return { repoRoot, sha7 };
}

/** A run-context resolver pinned to one NAMED checkout rather than the
 *  process's cwd; an unreadable HEAD resolves to `null`. */
export function gitRunContextFor(
  repoRoot: string,
): () => { repoRoot: string; sha7: string } | null {
  return () => {
    const sha7 = headSha7(repoRoot);
    return sha7 === null ? null : { repoRoot, sha7 };
  };
}
