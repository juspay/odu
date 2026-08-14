/**
 * End-to-end: the nix-built `odu` binary driven from a *second* process, the way
 * an agent (or a human in another terminal) drives it — cancelled, superseded,
 * lingered, and read through `status`. Exercises the seams the in-process suites
 * stub: the live coordinator's `run.cancel` teardown, the one-run lock,
 * `--linger` keeping the socket alive past settle, and the run environment
 * `status` reports off the header cell. Black-box: we only drive the binary and
 * read its sockets + exit codes.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { buildOduBinary, cleanup, hermeticEnv, makeFixture } from "./harness";

let oduBin: string;
// Pin every spawned run to a localhost lane regardless of the machine's ambient
// `~/.config/odu/hosts.json` — the shared empty-`ODU_HOSTS` env (see harness).
const env = hermeticEnv;

beforeAll(() => {
  oduBin = buildOduBinary();
}, 600_000);

const live: ChildProcess[] = [];
// Fixture dirs are swept by the same hook, after the children that hold them
// open are killed — bun:test has no per-test `onTestFinished`, so the creating
// helper registers here instead.
const created: string[] = [];
afterEach(() => {
  for (const child of live.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  for (const dir of created.splice(0)) cleanup(dir);
});

function fixture(name: string): string {
  const dir = makeFixture(name);
  created.push(dir);
  return dir;
}

/** Spawn `odu <args>` in `dir`, detached from this test's stdio, and track it
 *  for teardown. Returns the child plus a promise of its exit code. */
function spawnOdu(dir: string, args: string[]): {
  child: ChildProcess;
  exited: Promise<number>;
} {
  const child = spawn(oduBin, args, { cwd: dir, stdio: "ignore", env });
  live.push(child);
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? -1));
    child.on("error", () => resolve(-1));
  });
  return { child, exited };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function waitUntil(
  pred: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(200);
  }
}

function statusExit(dir: string): number {
  try {
    execFileSync(oduBin, ["status"], { cwd: dir, stdio: "ignore", env });
    return 0;
  } catch {
    return 1;
  }
}

/** `.ci/odu.sock` exists *and* `odu status` dials it (a run is serving). */
function runIsLive(dir: string): boolean {
  if (!existsSync(join(dir, ".ci", "odu.sock"))) return false;
  return statusExit(dir) === 0;
}

describe("odu cancel / supersede / linger (black-box)", () => {
  it("cancels a live run from a second process and drops the socket", async () => {
    const dir = fixture("sleep");
    const { exited } = spawnOdu(dir, ["run", "--no-strict"]);
    await waitUntil(() => runIsLive(dir), 120_000, "the run to come up");

    // The cancel is a different process dialing the live socket.
    const out = execFileSync(oduBin, ["cancel"], { cwd: dir, encoding: "utf-8", env });
    expect(out).toMatch(/run cancelled/);

    // The coordinator tore down: its process exits and the socket is gone, so a
    // following run could re-bind the lock.
    const code = await Promise.race([
      exited,
      sleep(15_000).then(() => "timeout" as const),
    ]);
    expect(code).not.toBe("timeout");
    await waitUntil(() => statusExit(dir) !== 0, 10_000, "the socket to vanish");
  }, 180_000);

  it("a second run is refused, but --supersede takes over", async () => {
    const dir = fixture("sleep");
    const first = spawnOdu(dir, ["run", "--no-strict"]);
    await waitUntil(() => runIsLive(dir), 120_000, "the first run to come up");

    // Without supersede, the one-run lock refuses the second start.
    let refusedStderr = "";
    try {
      execFileSync(oduBin, ["run", "--no-strict"], { cwd: dir, encoding: "utf-8", env });
      throw new Error("expected the second run to be refused");
    } catch (err) {
      refusedStderr = String((err as { stderr?: string }).stderr ?? err);
    }
    expect(refusedStderr).toMatch(/already in progress/);

    // With supersede, the new run cancels the first and binds the lock itself.
    spawnOdu(dir, ["run", "--no-strict", "--supersede"]);
    const firstCode = await Promise.race([
      first.exited,
      sleep(30_000).then(() => "timeout" as const),
    ]);
    expect(firstCode).not.toBe("timeout"); // the superseded run exited
    await waitUntil(() => runIsLive(dir), 120_000, "the superseding run to serve");

    execFileSync(oduBin, ["cancel"], { cwd: dir, env }); // clean up the live run
  }, 240_000);

  it("--linger keeps the coordinator serving past settle", async () => {
    const dir = fixture("pass");
    spawnOdu(dir, ["run", "--no-strict", "--linger"]);
    await waitUntil(() => runIsLive(dir), 120_000, "the run to come up");

    // The `pass` DAG drains in seconds; a non-linger run would exit and drop the
    // socket. With --linger the coordinator stays up, so `status` keeps dialing.
    await waitUntil(() => {
      try {
        const out = execFileSync(oduBin, ["status", "-o", "json"], {
          cwd: dir,
          encoding: "utf-8",
          env,
        });
        const parsed = JSON.parse(out) as
          | { nodes: Array<{ status: string }> }
          | Array<{ status: string }>;
        const rows = Array.isArray(parsed) ? parsed : parsed.nodes;
        return rows.length > 0 && rows.every((r) => r.status === "ok");
      } catch {
        return false;
      }
    }, 60_000, "the run to drain green");

    // Several seconds after settle the socket is *still* live — the linger.
    await sleep(3_000);
    expect(statusExit(dir)).toBe(0);

    execFileSync(oduBin, ["cancel"], { cwd: dir, env });
    await waitUntil(() => statusExit(dir) !== 0, 15_000, "cancel to drop the socket");
  }, 180_000);
});

/**
 * The run *environment* on `odu status`, read from a second process
 * (juspay/odu#84). A localhost lane claims nothing, so these fixtures can never
 * sit in the `provisioning` phase — what the shipped binary proves here is the
 * contract's other half: the `run` key exists, and a run that reached its lanes
 * reports them and keeps the output it always had. The provisioning phase itself
 * is covered over the socket in `src/cli/introspect.provisioning.test.ts`,
 * which does not need an ssh host to reach it.
 */
describe("odu status reports the run environment (black-box)", () => {
  it("carries phase + lanes on a live localhost run", async () => {
    const dir = fixture("sleep");
    spawnOdu(dir, ["run", "--no-strict"]);
    await waitUntil(() => runIsLive(dir), 120_000, "the run to come up");

    const out = execFileSync(oduBin, ["status", "-o", "json"], {
      cwd: dir,
      encoding: "utf-8",
      env,
    });
    const parsed = JSON.parse(out) as {
      nodes: unknown[];
      run: {
        phase: string;
        elapsed_ms: number | null;
        lanes: { state: string; platform: string; host?: string }[];
      };
    };
    expect(parsed.run.phase).toBe("lanes");
    expect(parsed.run.lanes.length).toBeGreaterThan(0);
    expect(parsed.run.lanes.every((l) => l.state === "leased")).toBe(true);
    expect(parsed.run.lanes[0]?.host).toBe("localhost");
    expect(parsed.run.elapsed_ms).toBeGreaterThanOrEqual(0);
    // The keys that predate the `run` block are untouched.
    expect(parsed.nodes.length).toBeGreaterThan(0);

    // The plain face says nothing extra once a run has its lanes.
    const plain = execFileSync(oduBin, ["status"], {
      cwd: dir,
      encoding: "utf-8",
      env,
    });
    expect(plain).not.toContain("provisioning");

    execFileSync(oduBin, ["cancel"], { cwd: dir, env });
  }, 180_000);
});
