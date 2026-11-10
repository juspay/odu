/**
 * A SERVICE-SIDE CLONE, MOVED TO THE COMMIT IT WAS ASKED FOR (PLAN 4.4).
 *
 * The case is the pod's: a workflow calls `run_start` with the commit it has
 * just pushed, against a clone under `/data/checkouts/<repo>` that has never
 * heard of it. Here that is a real `git clone` of a real repository, left one
 * commit behind, and a real daemon that fetches and moves it.
 *
 * Out-of-process and black-box, like the rest of this directory: the daemon is
 * the nix-built binary, the git is the machine's, and the assertions are made
 * by asking git what the clone is on afterwards. The unit suite
 * (`packages/service/src/start.test.ts`) states every refusal without git;
 * this states the one thing it cannot — that the commands actually move a
 * clone, and that the run is about the commit the caller named.
 */

import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildOduBinary, cleanup, scratchDir, suitePortFor } from "./harness";
import { daemonLog, startWebService, until, verb, type WebWorld } from "./webHarness";

/** A DAG that goes green in milliseconds — this suite is about the checkout,
 *  not about the pipeline. */
const PASS = `[metadata("ci")]
default: alpha

alpha:
    echo "alpha ran"
`;

let odu: string;
let world: WebWorld;
const dirs: string[] = [];

beforeAll(async () => {
  odu = buildOduBinary();
  world = await startWebService(odu, {}, suitePortFor("checkoutBranch"));
}, 900_000);

afterAll(() => {
  world?.dispose();
  for (const dir of dirs) cleanup(dir);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "odu e2e",
      GIT_AUTHOR_EMAIL: "e2e@odu.test",
      GIT_COMMITTER_NAME: "odu e2e",
      GIT_COMMITTER_EMAIL: "e2e@odu.test",
    },
  }).trim();
}

/**
 * An upstream on `main` with TWO commits, and a clone that stopped at the
 * first — the world the pod is in when a workflow calls it.
 *
 * `-b main` is named rather than inherited: `init.defaultBranch` is a
 * developer's own setting and the branch is the subject of this test.
 */
function upstreamAndClone(): { upstream: string; clone: string; second: string } {
  const upstream = realpathSync(scratchDir("odu-e2e-upstream-"));
  dirs.push(upstream);
  git(upstream, "init", "-q", "-b", "main");
  // `.ci/` ignored, so odu's own per-checkout ledger does not make the clone's
  // tree dirty — which the move refuses, correctly.
  writeFileSync(join(upstream, ".gitignore"), ".ci/\n");
  writeFileSync(join(upstream, "justfile"), PASS);
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "first");

  const clone = realpathSync(scratchDir("odu-e2e-clone-"));
  dirs.push(clone);
  git(clone, "clone", "-q", upstream, ".");

  // The commit the clone has never had.
  writeFileSync(join(upstream, "second.txt"), "pushed after the clone\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "second");
  return { upstream, clone, second: git(upstream, "rev-parse", "HEAD") };
}

describe("run_start with a branch", () => {
  it("fetches, moves the clone onto the branch, and runs that commit", async () => {
    const { clone, second } = upstreamAndClone();
    expect(git(clone, "rev-parse", "HEAD")).not.toBe(second);

    const start = verb(world, "run_start", {
      checkout: clone,
      expectedSha: second,
      branch: "main",
      requestId: "branch-move",
      noPost: true,
    });
    if (start.status !== 0) {
      throw new Error(
        `e2e: run_start refused (exit ${start.status})\n` +
          `${start.stderr}\n--- daemon log ---\n${daemonLog(world)}`,
      );
    }
    const receipt = start.json as { runId: string; accepted: boolean; sha: string };
    expect(receipt.accepted).toBe(true);
    // The run is about the commit the CALLER named, not the one the clone was
    // on when the call arrived.
    expect(receipt.sha).toBe(second);

    // THE CLONE ITSELF, asked of git: on that commit, and ON THE BRANCH. A
    // detached HEAD here would pin nothing, which is the other half of why
    // the branch travels at all.
    expect(git(clone, "rev-parse", "HEAD")).toBe(second);
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");

    const answer = await until(
      `run ${receipt.runId} to settle`,
      () => {
        const waited = verb(world, "run_wait", {
          runId: receipt.runId,
          deadlineMs: 20_000,
        });
        if (waited.status !== 0) return null;
        const value = waited.json as { settled: boolean; sha: string };
        return value.settled ? value : null;
      },
      300_000,
      0,
    );
    expect(answer.sha).toBe(second);
  }, 900_000);

  it("refuses a commit that is not on that branch, and leaves the clone alone", () => {
    const { clone, upstream } = upstreamAndClone();
    // A commit on a branch of its own, fetchable but not on `main`.
    git(upstream, "checkout", "-q", "-b", "sidetrack");
    writeFileSync(join(upstream, "side.txt"), "not on main\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-q", "-m", "sidetrack");
    const aside = git(upstream, "rev-parse", "HEAD");
    const before = git(clone, "rev-parse", "HEAD");

    const refused = verb(world, "run_start", {
      checkout: clone,
      expectedSha: aside,
      branch: "main",
      requestId: "branch-aside",
      noPost: true,
    });
    expect(refused.status).toBe(1);
    const said = refused.json as { code: string; message: string };
    expect(said.code).toBe("checkout_refused");
    expect(said.message).toContain("not on origin/main");
    // BOTH SHAS, and the clone exactly where it was.
    expect(said.message).toContain(aside);
    expect(git(clone, "rev-parse", "HEAD")).toBe(before);
  }, 300_000);
});
