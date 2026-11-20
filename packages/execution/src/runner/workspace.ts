import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SNAPSHOT_IMPORT_SCRIPT = `set -eu
cache=$ODU_SNAPSHOT_CACHE; origin=$ODU_SNAPSHOT_ORIGIN; commit=$ODU_SNAPSHOT_COMMIT; bundle=$ODU_SNAPSHOT_BUNDLE
if ! git -C "$cache" rev-parse --git-dir >/dev/null 2>&1; then git init --bare "$cache"; fi
has() { git -C "$cache" cat-file -e "$1^{commit}" 2>/dev/null; }
if has "$commit"; then
  echo "[odu] snapshot $commit: already in object cache"
else
  for required in $ODU_SNAPSHOT_REQUIRES; do
    if ! has "$required"; then
      echo "[odu] fetching snapshot prerequisite $required from $origin (if stale, git fetch --prune origin)"
      git -C "$cache" fetch --no-tags "$origin" "$required"
    fi
  done
  if ! has "$commit"; then
    test -n "$bundle" || { echo "snapshot $commit is not in the object cache and no bundle was uploaded"; exit 1; }
    git -C "$cache" bundle verify "$bundle"
    git -C "$cache" fetch --no-tags "$bundle" HEAD
    has "$commit" || { echo "bundle did not deliver $commit"; exit 1; }
    echo "[odu] snapshot $commit: fetched from bundle ($(wc -c < "$bundle") bytes)"
  fi
fi
`;

export interface WorkspaceRequest {
  origin: string;
  sha: string;
  snapshot?: {
    commit: string;
    requires: readonly string[];
    bundlePath: string | null;
  };
}

export interface WorkspaceResult {
  ok: boolean;
  workspace: string | null;
  cleanup: () => void;
}

export function slugFor(origin: string): string {
  const tail =
    origin
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .at(-1) ?? "repo";
  return tail.replace(/[^A-Za-z0-9._-]/g, "_") || "repo";
}

export function objectCacheFor(origin: string): string {
  return join(
    process.env.HOME ?? tmpdir(),
    ".cache",
    "odu",
    "repos",
    `${slugFor(origin)}.git`,
  );
}
export function hasSnapshot(origin: string, commit: string): boolean {
  if (!/^[0-9a-f]{40}$/.test(commit)) return false;
  try {
    execFileSync(
      "git",
      ["-C", objectCacheFor(origin), "cat-file", "-e", `${commit}^{commit}`],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}
export function narrateSnapshot(
  workspace: string,
  base: string,
  commit: string,
  output: (line: string) => void,
): boolean {
  try {
    const git = (args: string[]) =>
      execFileSync("git", ["-C", workspace, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    if (git(["rev-parse", "HEAD"]) !== commit)
      throw new Error("snapshot HEAD mismatch");
    const paths = git(["diff-tree", "-r", "--name-status", base, commit])
      .split("\n")
      .filter(Boolean);
    output(
      `[odu] snapshot ${commit.slice(0, 7)} = HEAD ${base.slice(0, 7)} + ${paths.length} paths`,
    );
    for (const path of paths.slice(0, 100)) output(`  ${path}`);
    return true;
  } catch (error) {
    output(`[odu] snapshot verification failed: ${String(error)}`);
    return false;
  }
}

function drainChildOutput(
  child: ChildProcess,
  label: string,
  onOutput: (line: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const forward = (chunk: Buffer): void => {
      for (const line of chunk.toString("utf-8").split("\n")) {
        if (line.trim().length > 0) onOutput(line);
      }
    };
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
    child.on("error", (err) => {
      onOutput(`spawn ${label} failed: ${err.message}`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string },
  onOutput: (line: string) => void,
): Promise<number> {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return drainChildOutput(child, cmd, onOutput);
}

// A fresh, unique worktree name per invocation — pid alone collides when the
// same runner process prepares the same SHA twice (a `rerun(_ci-setup)` or a
// same-SHA retry), and `git worktree add` refuses an existing directory.
function freshWorktreePath(slug: string, sha: string): string {
  return join(
    process.env.ODU_WORK_DIR ?? join(tmpdir(), "odu"),
    slug,
    `${sha.slice(0, 7)}-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
}

export async function prepareWorkspace(
  req: WorkspaceRequest,
  onOutput: (line: string) => void,
): Promise<WorkspaceResult> {
  const slug = slugFor(req.origin);
  const cache = objectCacheFor(req.origin);
  const commit = req.snapshot?.commit ?? req.sha;
  const workdir = freshWorktreePath(slug, req.sha);
  const fail = (msg: string): WorkspaceResult => {
    onOutput(`[odu] _ci-setup failed: ${msg}`);
    return { ok: false, workspace: null, cleanup: () => {} };
  };

  mkdirSync(cache, { recursive: true });
  onOutput(`[odu] object cache: ${cache}`);
  if (
    req.snapshot === undefined &&
    (await run(
      "git",
      ["-C", cache, "rev-parse", "--git-dir"],
      {},
      () => {},
    )) !== 0
  ) {
    const code = await run("git", ["init", "--bare", cache], {}, onOutput);
    if (code !== 0) return fail(`git init --bare exited ${code}`);
  }

  // Serialize fetches per slug: rasam is shared between concurrent runs and
  // git ref/odb locks are not concurrency-friendly. flock(1) is ubiquitous on
  // the NixOS pool boxes; on hosts without it (macOS), fall back to a bare
  // fetch — fetching an explicit SHA touches no refs, which dodges the
  // common lock contention anyway.
  let code: number;
  if (req.snapshot !== undefined) {
    const snap = req.snapshot;
    if (
      ![snap.commit, ...snap.requires].every((id) => /^[0-9a-f]{40}$/.test(id))
    )
      return fail("invalid snapshot commit");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ODU_SNAPSHOT_CACHE: cache,
      ODU_SNAPSHOT_ORIGIN: req.origin,
      ODU_SNAPSHOT_COMMIT: snap.commit,
      ODU_SNAPSHOT_BUNDLE: snap.bundlePath ?? "",
      ODU_SNAPSHOT_REQUIRES: snap.requires.join(" "),
    };
    code = await drainChildOutput(
      spawn(
        "flock",
        [join(cache, "odu-fetch.lock"), "sh", "-c", SNAPSHOT_IMPORT_SCRIPT],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      ),
      "flock",
      onOutput,
    );
    if (code === 127) {
      code = await drainChildOutput(
        spawn("sh", ["-c", SNAPSHOT_IMPORT_SCRIPT], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        }),
        "sh",
        onOutput,
      );
    }
    if (snap.bundlePath !== null) {
      try {
        rmSync(snap.bundlePath, { force: true });
      } catch {
      }
    }
    if (code !== 0) return fail(`snapshot import exited ${code}`);
  } else {
    onOutput(`[odu] fetching ${req.sha} from ${req.origin}`);
    const fetchArgs = ["-C", cache, "fetch", "--no-tags", req.origin, req.sha];
    code = await run(
      "flock",
      [join(cache, "odu-fetch.lock"), "git", ...fetchArgs],
      {},
      onOutput,
    );
    if (code === 127) code = await run("git", fetchArgs, {}, onOutput);
    if (code !== 0) {
      return fail(
        `git fetch exited ${code} — is ${req.sha} pushed to ${req.origin}? ` +
          "(strict mode fetches pushed SHAs; use --no-strict to ship a working-tree snapshot)",
      );
    }
  }

  mkdirSync(join(workdir, ".."), { recursive: true });
  await run("git", ["-C", cache, "worktree", "prune"], {}, () => {});
  onOutput(`[odu] worktree: ${workdir}`);
  code = await run(
    "git",
    ["-C", cache, "worktree", "add", "--detach", workdir, commit],
    {},
    onOutput,
  );
  if (code !== 0) return fail(`git worktree add exited ${code}`);

  if (
    req.snapshot !== undefined &&
    !narrateSnapshot(workdir, req.sha, commit, onOutput)
  ) {
    rmSync(workdir, { recursive: true, force: true });
    return fail("snapshot verification failed");
  }

  return {
    ok: true,
    workspace: workdir,
    cleanup: () => {
      try {
        rmSync(workdir, { recursive: true, force: true });
      } catch {
      }
    },
  };
}
