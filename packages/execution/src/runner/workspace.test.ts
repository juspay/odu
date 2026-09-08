import { afterEach, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  snapshotWorkingTree,
  type WorkingTreeSnapshot,
} from "../coordinator/workingTree";
import {
  hasSnapshot,
  narrateSnapshot,
  objectCacheFor,
  prepareWorkspace,
  type WorkspaceResult,
} from "./workspace";
const dirs: string[] = [];
const snapshots: WorkingTreeSnapshot[] = [];
const results: WorkspaceResult[] = [];
const caches: string[] = [];
afterEach(() => {
  for (const r of results.splice(0)) r.cleanup();
  for (const s of snapshots.splice(0)) s.cleanup();
  for (const d of [...dirs.splice(0), ...caches.splice(0)])
    rmSync(d, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "odu-workspace-test-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "a@b");
  writeFileSync(join(dir, "marker"), "base");
  git("add", "-A");
  git("commit", "-qm", "base");
  const origin = `file://${dir}/origin-${dir.split("/").at(-1)}.git`;
  git("clone", "--bare", ".", origin.slice(7));
  git("remote", "add", "origin", origin);
  git("fetch", "origin");
  writeFileSync(join(dir, ".gitignore"), "origin-*.git/\n");
  git("add", ".gitignore");
  git("commit", "-qm", "unpushed");
  writeFileSync(join(dir, "marker"), "dirty");
  const snapshot = snapshotWorkingTree(dir);
  snapshots.push(snapshot);
  caches.push(objectCacheFor(origin));
  const req = (bundlePath: string | null) => ({
    origin,
    sha: snapshot.base,
    snapshot: {
      commit: snapshot.contentSha,
      requires: snapshot.requires,
      bundlePath,
    },
  });
  const prepare = async (bundlePath: string | null, lines: string[]) => {
    const r = await prepareWorkspace(req(bundlePath), (l) => lines.push(l));
    results.push(r);
    return r;
  };
  return { dir, origin, snapshot, prepare };
}
it("imports unpushed history and edits, then reuses the identical contentSha without a bundle", async () => {
  const f = fixture();
  const lines: string[] = [];
  expect(hasSnapshot(f.origin, f.snapshot.contentSha)).toBe(false);
  const result = await f.prepare(f.snapshot.bundle!.path, lines);
  expect(result.ok).toBe(true);
  expect(readFileSync(join(result.workspace!, "marker"), "utf8")).toBe("dirty");
  expect(lines.join("\n")).toContain("fetching snapshot prerequisite");
  expect(lines.join("\n")).toContain("fetched from bundle");
  expect(lines.join("\n")).toContain(
    `snapshot ${f.snapshot.contentSha.slice(0, 7)} = HEAD ${f.snapshot.base.slice(0, 7)}`,
  );
  expect(existsSync(f.snapshot.bundle!.path)).toBe(false);
  expect(hasSnapshot(f.origin, f.snapshot.contentSha)).toBe(true);
  const cached: string[] = [];
  expect((await f.prepare(null, cached)).ok).toBe(true);
  expect(cached.join("\n")).toContain("already in object cache");
  expect(
    narrateSnapshot(
      result.workspace!,
      f.snapshot.base,
      "a".repeat(40),
      () => {},
    ),
  ).toBe(false);
});
it("refuses a missing bundle and invalid commits", async () => {
  const f = fixture();
  const lines: string[] = [];
  expect((await f.prepare(null, lines)).ok).toBe(false);
  expect(lines.join("\n")).toContain("no bundle was uploaded");
  expect(hasSnapshot(f.origin, "../../bad")).toBe(false);
});
it("serializes concurrent imports of the same snapshot", async () => {
  const f = fixture();
  const second = join(f.dir, "second.bundle");
  copyFileSync(f.snapshot.bundle!.path, second);
  const logs: string[] = [];
  const pair = await Promise.all([
    f.prepare(f.snapshot.bundle!.path, logs),
    f.prepare(second, logs),
  ]);
  expect(
    pair.map((r) => r.ok),
    logs.join("\n"),
  ).toEqual([true, true]);
  expect(pair[0]!.workspace).not.toBe(pair[1]!.workspace);
});
