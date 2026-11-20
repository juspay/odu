import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  buildOduBinary,
  removeNow,
  currentNixSystem,
  hermeticEnv,
  makeFixture,
} from "./harness";

let oduBin: string;
const env = hermeticEnv;

beforeAll(() => {
  oduBin = buildOduBinary();
}, 600_000);

const live: ChildProcess[] = [];
const created: string[] = [];
afterEach(() => {
  for (const child of live.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  for (const dir of created.splice(0)) removeNow(dir);
});

function fixture(name: string): string {
  const dir = makeFixture(name);
  created.push(dir);
  return dir;
}

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

function sha7Of(dir: string): string {
  return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
    cwd: dir,
    encoding: "utf-8",
  }).trim();
}

function runIsLive(dir: string): boolean {
  return existsSync(join(dir, ".ci", "odu.sock"));
}

describe("odu ci cancel / supersede / linger (black-box)", () => {
  it(
    "drops one lane and still settles cleanly — no crash, no invented notice",
    async () => {
      const dir = fixture("sleep");
      const child = spawn(oduBin, ["ci", "run", "--no-strict", "--progress", "json"], {
        cwd: dir,
        stdio: ["ignore", "ignore", "pipe"],
        env,
      });
      live.push(child);
      let stderr = "";
      child.stderr?.setEncoding("utf-8");
      child.stderr?.on("data", (c: string) => {
        stderr += c;
      });
      const exited = new Promise<number>((resolve) => {
        child.on("exit", (code) => resolve(code ?? -1));
        child.on("error", () => resolve(-1));
      });
      await waitUntil(() => runIsLive(dir), 600_000, "the run to serve its socket");

      const platform = currentNixSystem();
      const slowLog = (): string =>
        join(dir, ".ci", sha7Of(dir), platform, "slow.log");
      await waitUntil(
        () => existsSync(slowLog()) && readFileSync(slowLog(), "utf-8") !== "",
        600_000,
        "the slow node to start producing output",
      );

      execFileSync(oduBin, ["ci", "cancel", `@${platform}`], { cwd: dir, env });

      expect(await exited).toBeGreaterThan(0);

      expect(stderr).not.toContain("after its log ended");
      expect(stderr).toContain("ci run summary");

      const log = readFileSync(slowLog(), "utf-8");
      expect(log).toContain("[odu] cancelled by operator (lane)");
      expect(log).not.toContain("[odu] log truncated");
    },
    900_000,
  );

  it("cancels a live run from a second process and drops the socket", async () => {
    const dir = fixture("sleep");
    const { exited } = spawnOdu(dir, ["ci", "run", "--no-strict"]);
    await waitUntil(() => runIsLive(dir), 120_000, "the run to come up");

    const out = execFileSync(oduBin, ["ci", "cancel"], { cwd: dir, encoding: "utf-8", env });
    expect(out).toMatch(/run cancelled/);

    const code = await Promise.race([
      exited,
      sleep(15_000).then(() => "timeout" as const),
    ]);
    expect(code).not.toBe("timeout");
    await waitUntil(() => !runIsLive(dir), 10_000, "the socket to vanish");
  }, 180_000);

  it("a second run does not start one, but --supersede takes over", async () => {
    const dir = fixture("sleep");
    const first = spawnOdu(dir, ["ci", "run", "--no-strict"]);
    await waitUntil(() => runIsLive(dir), 120_000, "the first run to come up");
    const firstRun = execFileSync(oduBin, ["ci", "history", "list", "-o", "json"], {
      cwd: dir,
      encoding: "utf-8",
      env,
    });
    const before = (JSON.parse(firstRun) as { runId: string }[]).length;

    const second = spawnSync(oduBin, ["ci", "run", "--no-strict", "--no-wait"], {
      cwd: dir,
      encoding: "utf-8",
      env,
    });
    expect(second.stderr).toMatch(/a run is already going in this checkout/);
    const after = (
      JSON.parse(
        execFileSync(oduBin, ["ci", "history", "list", "-o", "json"], {
          cwd: dir,
          encoding: "utf-8",
          env,
        }),
      ) as { runId: string }[]
    ).length;
    expect(after).toBe(before);

    spawnOdu(dir, ["ci", "run", "--no-strict", "--supersede"]);
    const firstCode = await Promise.race([
      first.exited,
      sleep(30_000).then(() => "timeout" as const),
    ]);
    expect(firstCode).not.toBe("timeout");
    await waitUntil(() => runIsLive(dir), 120_000, "the superseding run to serve");

    execFileSync(oduBin, ["ci", "cancel"], { cwd: dir, env });
  }, 240_000);

  it("--linger keeps the coordinator serving past settle", async () => {
    const dir = fixture("pass");
    spawnOdu(dir, ["ci", "run", "--no-strict", "--linger"]);
    await waitUntil(() => runIsLive(dir), 120_000, "the run to come up");

    await waitUntil(() => {
      try {
        const out = execFileSync(oduBin, ["ci", "status", "-o", "json"], {
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

    await sleep(3_000);
    expect(runIsLive(dir)).toBe(true);

    execFileSync(oduBin, ["ci", "cancel"], { cwd: dir, env });
    await waitUntil(() => !runIsLive(dir), 15_000, "cancel to drop the socket");
  }, 180_000);
});

describe("odu ci status reports the run environment (black-box)", () => {
  it("carries phase + lanes on a live localhost run", async () => {
    const dir = fixture("sleep");
    spawnOdu(dir, ["ci", "run", "--no-strict"]);
    await waitUntil(() => runIsLive(dir), 120_000, "the run to come up");

    const out = execFileSync(oduBin, ["ci", "status", "-o", "json"], {
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
    expect(parsed.nodes.length).toBeGreaterThan(0);

    const plain = execFileSync(oduBin, ["ci", "status"], {
      cwd: dir,
      encoding: "utf-8",
      env,
    });
    expect(plain).not.toContain("provisioning");

    execFileSync(oduBin, ["ci", "cancel"], { cwd: dir, env });
  }, 180_000);
});
