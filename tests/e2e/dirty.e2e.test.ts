/** Real packaged coordinator/runner wire, including the bundle arm, without sshd. */
import { afterAll, beforeAll, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { formatLogKey } from "@odu/service-client/logKey";
import type { AttentionAnswer, RunRow } from "@odu/service-client/surface";
import {
  BIG,
  buildOduBinary,
  cleanup,
  currentNixSystem,
  makeFixture,
  privateWorld,
  suitePortFor,
} from "./harness";

let odu: string;
const local = privateWorld(suitePortFor("dirtyLocal"));
local.env.ODU_SNAPSHOT_MAX_BYTES = "1";
const remote = privateWorld(suitePortFor("dirtyTransport"));
remote.env.ODU_SNAPSHOT_TRANSPORT = "always";
const worlds = [local, remote];
const fixtures: string[] = [];
for (const world of worlds) {
  const gh = join(world.root, "gh");
  const calls = join(world.root, "gh-calls");
  writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`);
  chmodSync(gh, 0o755);
  world.env.ODU_GH_BIN = gh;
}
const cli = (world: typeof local, dir: string, args: string[]) =>
  spawnSync(odu, args, {
    cwd: dir,
    env: world.env,
    encoding: "utf8",
    maxBuffer: BIG,
    timeout: 300_000,
  });
beforeAll(() => {
  odu = buildOduBinary();
}, 600_000);
afterAll(() => {
  for (const world of worlds) {
    const cell = cli(world, world.root, ["surface", "get", "service"]);
    if (cell.status === 0) {
      const service = JSON.parse(cell.stdout) as { identity: { pid: number } };
      try {
        process.kill(service.identity.pid, "SIGTERM");
      } catch {
        /* already stopped */
      }
    }
    cleanup(world.root);
  }
  for (const dir of fixtures) cleanup(dir);
});

it("pins edits locally and over stdio, changes red to green, then proves cache reuse for unchanged content", () => {
  const dir = makeFixture("dirty");
  fixtures.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const originDir = join(remote.root, `origin-${dir.split("/").at(-1)}.git`);
  git("clone", "--bare", ".", originDir);
  git("remote", "add", "origin", `file://${originDir}`);
  git("fetch", "origin");
  const base = git("rev-parse", "HEAD");
  const reflog = git("reflog");
  writeFileSync(join(dir, "marker.txt"), "red\n");
  writeFileSync(join(dir, "new.txt"), "new\n");
  rmSync(join(dir, "gone.txt"));
  const strict = cli(local, dir, ["run", "--no-post", "-o", "json"]);
  expect(strict.status).not.toBe(0);
  expect(strict.stdout + strict.stderr).toContain("dirty");
  const run = (world: typeof local, expectedStatus: number) => {
    const result = cli(world, dir, ["run", "--no-strict", "-o", "json"]);
    if (result.status !== expectedStatus)
      throw new Error(
        `run exited ${result.status}: ${result.stdout}\n${result.stderr}`,
      );
    const answer = JSON.parse(result.stdout) as AttentionAnswer;
    const coordinatorLog = readFileSync(join(world.env.ODU_STATE_DIR!, "runs", answer.runId, "coordinator.log"), "utf8");
    console.log(coordinatorLog.split("\n").find(line => line.includes("captured in")));

    expect(answer.sha).toBe(base);
    expect(answer.dirty).toBe(true);
    expect(answer.contentSha).toMatch(/^[0-9a-f]{40}$/);
    expect(answer.contentSha).not.toBe(base);
    const log = cli(world, dir, [
      "logs",
      formatLogKey({
        runId: answer.runId,
        node: `_ci-setup@${currentNixSystem()}`,
        attempt: 1,
      }),
    ]);
    expect(log.status, log.stdout + log.stderr).toBe(0);
    expect(log.stdout).toContain(
      `snapshot ${answer.contentSha!.slice(0, 7)} = HEAD ${base.slice(0, 7)} + 3 paths`,
    );
    for (const path of ["marker.txt", "gone.txt", "new.txt"])
      expect(log.stdout).toContain(path);
    const rows = JSON.parse(
      cli(world, dir, ["history", "list", "-o", "json"]).stdout,
    ) as RunRow[];
    expect(rows.find((r) => r.runId === answer.runId)?.contentSha).toBe(
      answer.contentSha,
    );
    const read = JSON.parse(
      cli(world, dir, ["history", "show", "--run", answer.runId, "-o", "json"])
        .stdout,
    ) as AttentionAnswer;
    expect(read.contentSha).toBe(answer.contentSha);
    expect(cli(world, dir, ["history", "list"]).stdout).toContain(
      `+dirty→${answer.contentSha!.slice(0, 7)}`,
    );
    return { answer, log: log.stdout };
  };
  const red = run(remote, 1);
  expect(red.log).toContain("uploading snapshot");
  expect(red.log).toContain("fetched from bundle");
  writeFileSync(join(dir, "marker.txt"), "green\n");
  const localGreen = run(local, 0);
  const green = run(remote, 0);
  expect(green.answer.contentSha).not.toBe(red.answer.contentSha);
  expect(green.answer.contentSha).toBe(localGreen.answer.contentSha);
  expect(green.log).toContain("uploading snapshot");
  const again = run(remote, 0);
  expect(again.answer.contentSha).toBe(green.answer.contentSha);
  expect(again.log).toContain("already in object cache");
  expect(again.log).not.toContain("uploading snapshot");
  expect(git("rev-parse", "HEAD")).toBe(base);
  expect(git("reflog")).toBe(reflog);
  expect(git("diff", "--cached", "--name-only")).toBe("");
  for (const world of worlds) {
    const calls = join(world.root, "gh-calls");
    expect(existsSync(calls) ? readFileSync(calls, "utf8") : "").not.toContain(
      "statuses",
    );
  }
}, 300_000);
