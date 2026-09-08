/** Content-addressed working-tree capture. Only the temporary index is staged. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WorkingTreeSnapshot {
  captureMs: number;
  base: string;
  contentSha: string;
  dirty: boolean;
  overlay: { count: number; paths: string[] };
  worktreeDir: string;
  requires: string[];
  bundle: { path: string; bytes: number } | null;
  /** Build transport bytes only after a run has resolved a pool that needs them. */
  prepareBundle(): void;
  cleanup(): void;
}
export function treeModeFor(args: {
  noStrict: boolean;
  noSnapshot: boolean;
}): "strict" | "working-tree" | "in-place" {
  return args.noSnapshot
    ? "in-place"
    : args.noStrict
      ? "working-tree"
      : "strict";
}

export function snapshotWorkingTree(
  repoRoot: string,
  opts: { maxBytes?: number; bundle?: boolean } = {},
): WorkingTreeSnapshot {
  const captureStarted = performance.now();
  const git = (
    args: string[],
    env: NodeJS.ProcessEnv = {},
    raw = false,
  ): string => {
    try {
      const output = execFileSync("git", ["-C", repoRoot, ...args], {
        env: { ...process.env, ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      });
      return raw ? output : output.trim();
    } catch (error) {
      throw new Error(`odu: snapshot capture failed: ${String(error)}`);
    }
  };
  // --get exits 1 for an unset key; --default makes absence a successful false.
  if (
    git([
      "config",
      "--type=bool",
      "--default=false",
      "--get",
      "core.sparseCheckout",
    ]) === "true"
  ) {
    throw new Error(
      "odu: sparse checkout cannot be snapshotted: missing files could become deletions",
    );
  }
  const maxBytes =
    opts.maxBytes ??
    Number(process.env.ODU_SNAPSHOT_MAX_BYTES ?? 64 * 1024 * 1024);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error("odu: ODU_SNAPSHOT_MAX_BYTES must be a positive integer");
  const base = git(["rev-parse", "HEAD"]);
  const temp = mkdtempSync(join(tmpdir(), `odu-${base.slice(0, 7)}-`));
  const worktreeDir = join(temp, "tree");
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      git(["worktree", "remove", "--force", worktreeDir]);
    } catch {
      /* may not have been created */
    }
    rmSync(temp, { recursive: true, force: true });
  };
  try {
    const env = { GIT_INDEX_FILE: join(temp, "index") };
    git(["read-tree", base], env);
    // A negative pathspec naming an ignored .ci directory makes git add
    // exit 1 on supported Git versions. Enumerate the exact candidate set
    // instead: changed tracked paths (including deletions) plus non-ignored
    // new paths. Avoid one literal pathspec per unchanged file in a large repo.
    // NUL-delimited literal pathspecs also preserve whitespace and magic names.
    const candidates = [
      ...new Set([
        ...git(
          [
            "diff",
            "--name-only",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "-z",
            base,
            "--",
          ],
          env,
          true,
        ).split("\0"),
        ...git(
          ["ls-files", "-z", "--others", "--exclude-standard"],
          env,
          true,
        ).split("\0"),
      ]),
    ].filter(
      (path) => path !== "" && path !== ".ci" && !path.startsWith(".ci/"),
    );
    if (candidates.length > 0) {
      const pathspec = join(temp, "paths");
      writeFileSync(
        pathspec,
        candidates.map((path) => `:(literal)${path}\0`).join(""),
      );
      git(
        [
          "add",
          "-A",
          `--pathspec-from-file=${pathspec}`,
          "--pathspec-file-nul",
        ],
        env,
      );
    }
    // Excluding add alone leaves tracked .ci entries inherited from HEAD.
    git(["rm", "-r", "--cached", "--ignore-unmatch", "--", ".ci"], env);
    const tree = git(["write-tree"], env);
    for (const entry of git(["ls-tree", "-r", "-z", tree]).split("\0")) {
      if (
        entry.startsWith("160000 ") &&
        git([
          "status",
          "--porcelain",
          "--ignore-submodules=none",
          "--",
          entry.slice(entry.indexOf("\t") + 1),
        ]) !== ""
      ) {
        throw new Error(
          "odu: submodule changes cannot be shipped in a working-tree snapshot",
        );
      }
    }
    const dirty = tree !== git(["rev-parse", `${base}^{tree}`]);
    const changes = git(["diff-tree", "-r", "--raw", base, tree]);
    if (
      changes
        .split("\n")
        .some((line) => /^:(?:160000 \d+|\d+ 160000) /.test(line))
    ) {
      throw new Error(
        "odu: submodule changes cannot be shipped in a working-tree snapshot",
      );
    }
    const contentSha = dirty
      ? git(
          [
            "commit-tree",
            tree,
            "-p",
            base,
            "-m",
            `odu: working tree of ${base.slice(0, 7)}`,
          ],
          {
            GIT_AUTHOR_NAME: "odu",
            GIT_AUTHOR_EMAIL: "odu@localhost",
            GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
            GIT_COMMITTER_NAME: "odu",
            GIT_COMMITTER_EMAIL: "odu@localhost",
            GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
          },
        )
      : base;
    const paths = git(["diff-tree", "-r", "--name-status", base, contentSha])
      .split("\n")
      .filter(Boolean);
    const overlay = { count: paths.length, paths: paths.slice(0, 100) };
    git([
      "-c",
      "core.hooksPath=/dev/null",
      "worktree",
      "add",
      "--detach",
      worktreeDir,
      contentSha,
    ]);
    let prepared = false;
    const prepareBundle = (): void => {
      if (prepared) return;
      const boundary = git([
        "rev-list",
        "--boundary",
        contentSha,
        "--not",
        "--remotes=origin",
      ])
        .split("\n")
        .filter(Boolean);
      const requires = boundary
        .filter((line) => line.startsWith("-"))
        .map((line) => line.slice(1));
      let bundle: WorkingTreeSnapshot["bundle"] = null;
      if (boundary.some((line) => !line.startsWith("-"))) {
        const path = join(temp, "snapshot.bundle");
        git([
          "-C",
          worktreeDir,
          "bundle",
          "create",
          path,
          "HEAD",
          "--not",
          ...requires,
        ]);
        const bytes = statSync(path).size;
        if (bytes > maxBytes) {
          if (overlay.count === 0)
            throw new Error(
              `odu: snapshot bundle ${bytes} bytes exceeds ODU_SNAPSHOT_MAX_BYTES=${maxBytes}; the overlay is empty, so these bytes are repository history. Push the history to origin before remote execution, or use localhost.`,
            );
          const names = git([
            "diff-tree",
            "-r",
            "--name-only",
            "-z",
            base,
            contentSha,
          ])
            .split("\0")
            .filter(Boolean);
          const largest = git([
            "ls-tree",
            "-r",
            "-l",
            contentSha,
            "--",
            ...names,
          ])
            .split("\n")
            .sort(
              (a, b) => Number(b.split(/\s+/)[3]) - Number(a.split(/\s+/)[3]),
            )
            .slice(0, 10);
          throw new Error(
            `odu: snapshot bundle ${bytes} bytes exceeds ODU_SNAPSHOT_MAX_BYTES=${maxBytes}; largest overlay paths:\n${largest.join("\n")}\nUse .gitignore, --no-snapshot on localhost, or commit and push.`,
          );
        }
        bundle = { path, bytes };
      } else requires.push(base);
      snapshot.requires = requires;
      snapshot.bundle = bundle;
      prepared = true;
    };
    const snapshot: WorkingTreeSnapshot = {
      captureMs: Math.round(performance.now() - captureStarted),
      base,
      contentSha,
      dirty,
      overlay,
      worktreeDir,
      requires: [],
      bundle: null,
      prepareBundle,
      cleanup,
    };
    if (opts.bundle !== false) prepareBundle();
    return snapshot;
  } catch (error) {
    cleanup();
    throw error;
  }
}
