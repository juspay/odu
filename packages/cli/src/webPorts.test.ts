/**
 * WHAT THE SERVICE SEES WHEN IT LOOKS AT A CHECKOUT.
 *
 * One property, and it is the one that only shows up on somebody else's
 * machine: a path is not a directory's identity. macOS resolves `/tmp` to
 * `/private/tmp`, so the string a caller types and the string a run records for
 * the same directory routinely differ — and comparing them as given made a busy
 * checkout look free, launched a second coordinator into it, and turned "that
 * run is already there" into `launch_failed`.
 *
 * It cost two CI cycles to find because Linux has no such symlink, which is
 * exactly why the test builds one rather than trusting the platform to provide
 * it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRun } from "@odu/run-history/store";
import { probeCheckout } from "./webPorts";

const trash: string[] = [];
afterEach(() => {
  for (const dir of trash.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A git repo at a REAL path, plus a symlink that names the same directory. */
function checkout(): { real: string; linked: string; sha: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "odu-probe-")));
  trash.push(root);
  const real = join(root, "repo");
  mkdirSync(real);
  writeFileSync(join(real, "justfile"), "default:\n    true\n");
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: real, encoding: "utf-8" });
  };
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@odu.test", "-c", "user.name=t", "commit", "-q", "-m", "x");
  const linked = join(root, "link");
  symlinkSync(real, linked);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: real,
    encoding: "utf-8",
  }).trim();
  return { real, linked, sha };
}

/** A registered, still-owned run in a throwaway catalog. */
function liveRun(repoRoot: string, sha: string): { root: string; runId: string } {
  const root = mkdtempSync(join(tmpdir(), "odu-probe-catalog-"));
  trash.push(root);
  const runId = "0aaaaaaaa-aaaaaaaa";
  const registered = registerRun(
    {
      runId,
      repo: null,
      sha,
      seq: 1,
      pipeline: "default",
      repoRoot,
      createdAt: Date.now(),
      scope: { selectors: [], platforms: [], noDeps: false },
      snapshot: { mode: "strict", expectedSha: sha, dirty: false, retryable: true },
      build: { oduVersion: "0.0.0", self: null, runnerFlake: null },
      parentRunId: null,
      requestId: null,
    },
    { root, endpoint: join(repoRoot, ".ci", "odu.sock"), now: Date.now() },
  );
  if (!registered.ok) throw new Error("could not register the fixture run");
  return { root, runId };
}

describe("probeCheckout", () => {
  it("finds the live run when the caller names the checkout by a SYMLINK", () => {
    // The run recorded git's resolved toplevel. The caller typed the link.
    // Same directory, two strings.
    const repo = checkout();
    const catalog = liveRun(repo.real, repo.sha);
    const facts = probeCheckout(repo.linked, { root: catalog.root });
    expect(facts.isRepo).toBe(true);
    expect(facts.head).toBe(repo.sha);
    expect(facts.liveRunId).toBe(catalog.runId);
  });

  it("finds it by the real path too, which was never the broken case", () => {
    const repo = checkout();
    const catalog = liveRun(repo.real, repo.sha);
    expect(probeCheckout(repo.real, { root: catalog.root }).liveRunId).toBe(
      catalog.runId,
    );
  });

  it("says a checkout with no run in it is free", () => {
    const repo = checkout();
    const empty = mkdtempSync(join(tmpdir(), "odu-probe-empty-"));
    trash.push(empty);
    expect(probeCheckout(repo.linked, { root: empty }).liveRunId).toBeNull();
  });

  it("refuses a path that is not a repository, and one that is not there", () => {
    const bare = mkdtempSync(join(tmpdir(), "odu-probe-bare-"));
    trash.push(bare);
    expect(probeCheckout(bare).isRepo).toBe(false);
    expect(probeCheckout(join(bare, "nope")).isRepo).toBe(false);
  });
});
