import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  snapshotWorkingTree,
  treeModeFor,
  type WorkingTreeSnapshot,
} from "./workingTree";

const dirs: string[] = [];
const snapshots: WorkingTreeSnapshot[] = [];
afterEach(() => {
  for (const s of snapshots.splice(0)) s.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "odu-capture-test-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (name: string, content: string) =>
    writeFileSync(join(dir, name), content);
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "test@localhost");
  write("marker", "original");
  write("gone", "delete me");
  write(".gitignore", "ignored\n.ci/\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const snap = (maxBytes?: number) => {
    const s = snapshotWorkingTree(dir, { maxBytes });
    snapshots.push(s);
    return s;
  };
  return { dir, git, write, snap };
}
describe("working-tree capture", () => {
  it("selects all modes, with no-snapshot taking precedence", () => {
    expect(treeModeFor({ noStrict: false, noSnapshot: false })).toBe("strict");
    expect(treeModeFor({ noStrict: true, noSnapshot: false })).toBe(
      "working-tree",
    );
    for (const noStrict of [true, false])
      expect(treeModeFor({ noStrict, noSnapshot: true })).toBe("in-place");
  });
  it("is deterministic and captures worktree content without changing HEAD/index/reflog", () => {
    const f = fixture();
    f.write("marker", "staged");
    f.git("add", "marker");
    f.write("marker", "working tree wins");
    f.write("new", "new");
    f.write("ignored", "not shipped");
    mkdirSync(join(f.dir, ".ci"));
    f.write(".ci/log", "not shipped");
    mkdirSync(join(f.dir, "empty"));
    rmSync(join(f.dir, "gone"));
    chmodSync(join(f.dir, "marker"), 0o755);
    symlinkSync("marker", join(f.dir, "link"));
    const before = [
      f.git("status", "--porcelain"),
      f.git("rev-parse", "HEAD"),
      f.git("reflog"),
    ];
    const index = readFileSync(join(f.dir, ".git/index"));
    const first = f.snap();
    const second = f.snap();
    expect(second.contentSha).toBe(first.contentSha);
    expect(readFileSync(join(first.worktreeDir, "marker"), "utf8")).toBe(
      "working tree wins",
    );
    expect(f.git("ls-tree", "-r", first.contentSha)).toContain("100755 blob");
    expect(f.git("ls-tree", "-r", first.contentSha)).toContain("120000 blob");
    expect(
      f.git("ls-tree", "-r", "--name-only", first.contentSha).split("\n"),
    ).toEqual([".gitignore", "link", "marker", "new"]);
    expect([
      f.git("status", "--porcelain"),
      f.git("rev-parse", "HEAD"),
      f.git("reflog"),
    ]).toEqual(before);
    expect(readFileSync(join(f.dir, ".git/index"))).toEqual(index);
    expect(f.git("for-each-ref", "refs/odu")).toBe("");
    f.write("marker", "different");
    expect(f.snap().contentSha).not.toBe(first.contentSha);
    f.write("marker", "working tree wins");
    expect(f.snap().contentSha).toBe(first.contentSha);
  });
  it("uses base for clean trees; ships unpushed history above an origin boundary", () => {
    const f = fixture();
    const base = f.git("rev-parse", "HEAD");
    f.git("update-ref", "refs/remotes/origin/main", base);
    const clean = f.snap();
    expect(clean.contentSha).toBe(base);
    expect(clean.dirty).toBe(false);
    expect(clean.bundle).toBeNull();
    f.write("marker", "unpushed");
    f.git("commit", "-qam", "local");
    f.write("new", "dirty");
    const s = f.snap();
    expect(s.requires).toEqual([base]);
    expect(s.bundle).not.toBeNull();
    expect(f.git("bundle", "list-heads", s.bundle!.path)).toContain(
      `${s.contentSha} HEAD`,
    );
  });
  it("force-excludes even tracked .ci content", () => {
    const f = fixture();
    mkdirSync(join(f.dir, ".ci"));
    f.write(".ci/tracked", "log");
    f.git("add", "-f", ".ci");
    f.git("commit", "-qm", "tracked log");
    expect(
      f.git("ls-tree", "-r", "--name-only", f.snap().contentSha),
    ).not.toContain(".ci");
  });
  it("refuses oversize bundles and names the overlay", () => {
    const f = fixture();
    f.write("large.bin", "large");
    expect(() => f.snap(1)).toThrow("large.bin");
  });
  it("refuses sparse checkouts and submodule pointer changes", () => {
    const f = fixture();
    f.git("config", "core.sparseCheckout", "true");
    expect(() => f.snap()).toThrow("sparse checkout");
    f.git("config", "core.sparseCheckout", "false");
    f.git(
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${f.git("rev-parse", "HEAD")},sub`,
    );
    f.git("commit", "-qm", "gitlink");
    expect(() => f.snap()).toThrow("submodule changes");
  });
  it("preserves literal filenames and does not execute checkout hooks", () => {
    const f = fixture();
    for (const name of [" space ", ":(glob)*", "line\nbreak"]) f.write(name, "literal");
    f.write(".git/hooks/post-checkout", `#!/bin/sh\ntouch '${f.dir}/HOOK-RAN'\n`);
    chmodSync(join(f.dir, ".git/hooks/post-checkout"), 0o755);
    const snap = f.snap();
    for (const name of [" space ", ":(glob)*", "line\nbreak"]) expect(readFileSync(join(snap.worktreeDir, name), "utf8")).toBe("literal");
    expect(existsSync(join(f.dir, "HOOK-RAN"))).toBe(false);
  });
  it("fails on git add errors rather than accepting a partial capture", () => {
    const f = fixture();
    f.write(".gitattributes", "marker filter=broken\n");
    f.git("config", "filter.broken.clean", "false");
    f.git("config", "filter.broken.required", "true");
    f.write("marker", "changed");
    const index = readFileSync(join(f.dir, ".git/index"));
    expect(() => f.snap()).toThrow("snapshot capture failed");
    expect(readFileSync(join(f.dir, ".git/index"))).toEqual(index);
  });
});
