import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { buildOduBinary, hermeticEnv, makeFixture, removeNow } from "./harness";

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

interface Proc {
  pid: number;
  ppid: number;
  args: string;
}

function processTable(): Proc[] {
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
    encoding: "utf-8",
  });
  const rows: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m === null || m[1] === undefined || m[2] === undefined || m[3] === undefined) {
      continue;
    }
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] });
  }
  return rows;
}

function descendants(root: number): Proc[] {
  const kids = new Map<number, Proc[]>();
  for (const row of processTable()) {
    const list = kids.get(row.ppid) ?? [];
    list.push(row);
    kids.set(row.ppid, list);
  }
  const out: Proc[] = [];
  const walk = (pid: number): void => {
    for (const child of kids.get(pid) ?? []) {
      out.push(child);
      walk(child.pid);
    }
  };
  walk(root);
  return out;
}

function isRunner(args: string): boolean {
  return (
    args.includes("runner-main.ts") || /(^|[/\s])odu-runner(\s|$)/.test(args)
  );
}

function runIdOf(stderr: string): string {
  const said = /odu · started (\S+)/.exec(stderr);
  if (said === null) {
    throw new Error(`e2e: odu never said which run it started:\n${stderr}`);
  }
  return said[1] as string;
}

function findRunnerPid(runId: string): number {
  const coordinator = processTable().find(
    (p) => p.args.includes("run-coordinator") && p.args.includes(runId),
  );
  if (coordinator === undefined) {
    throw new Error(`e2e: no coordinator in the process table for run ${runId}`);
  }
  const tree = descendants(coordinator.pid);
  const runner = tree.find((p) => isRunner(p.args));
  if (runner === undefined) {
    throw new Error(
      `no odu-runner under coordinator ${coordinator.pid} (run ${runId}): ${tree.map((p) => `${p.pid} ${p.args}`).join("; ") || "(empty tree)"}`,
    );
  }
  return runner.pid;
}

function killIfAlive(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
  }
}

interface LaneRun {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number>;
  closed: Promise<void>;
}

function streamClosed(
  stream: NodeJS.ReadableStream | null | undefined,
): Promise<void> {
  if (stream === null || stream === undefined) return Promise.resolve();
  const done = Promise.withResolvers<void>();
  stream.on("close", () => done.resolve());
  return done.promise;
}

function startCiRun(
  dir: string,
  argv: string[],
  runEnv: NodeJS.ProcessEnv,
): LaneRun {
  const child = spawn(oduBin, ["ci", "run", ...argv], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    env: runEnv,
  });
  live.push(child);
  let out = "";
  let err = "";
  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");
  child.stdout?.on("data", (c: string) => {
    out += c;
  });
  child.stderr?.on("data", (c: string) => {
    err += c;
  });
  const closed = Promise.all([
    streamClosed(child.stdout),
    streamClosed(child.stderr),
  ]).then(() => undefined);
  const ending = Promise.withResolvers<number>();
  child.on("exit", (code) => ending.resolve(code ?? -1));
  child.on("error", () => ending.resolve(-1));
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    exited: ending.promise,
    closed,
  };
}

function jsonEvents(stdout: string): { recipe: string; status: string }[] {
  const events: { recipe: string; status: string }[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const ev = JSON.parse(line) as { recipe?: unknown; status?: unknown };
      if (typeof ev.recipe === "string" && typeof ev.status === "string") {
        events.push({ recipe: ev.recipe, status: ev.status });
      }
    } catch {
    }
  }
  return events;
}

function lastStatuses(stdout: string): Map<string, string> {
  const last = new Map<string, string>();
  for (const e of jsonEvents(stdout)) last.set(e.recipe, e.status);
  return last;
}

function findRecipeLog(dir: string, recipe: string): string {
  const ci = join(dir, ".ci");
  if (!existsSync(ci)) throw new Error(`no .ci in ${dir}`);
  for (const sha of readdirSync(ci).filter(
    (n) => n !== "odu.sock" && n !== "odu.run.lock",
  )) {
    const shaDir = join(ci, sha);
    if (!existsSync(shaDir)) continue;
    for (const plat of readdirSync(shaDir)) {
      const log = join(shaDir, plat, `${recipe}.log`);
      if (existsSync(log)) return log;
    }
  }
  throw new Error(`no ${recipe}.log under ${ci}`);
}

describe("odu lane transport death (black-box)", () => {
  it(
    "killing the runner after eight finished nodes errors the live one — no sealed-log crash",
    async () => {
      const dir = makeFixture("fast-slow");
      created.push(dir);
      const run = startCiRun(dir, ["--no-strict", "--progress", "json"], env);

      const finished = ["a", "b", "c", "d", "e", "f", "g", "h"];
      await waitUntil(
        () => {
          const ev = jsonEvents(run.stdout());
          return (
            finished.every((r) =>
              ev.some((e) => e.recipe === r && e.status === "success"),
            ) && ev.some((e) => e.recipe === "slow" && e.status === "running")
          );
        },
        600_000,
        "eight recipes to succeed while slow is still running",
      );

      const runnerPid = findRunnerPid(runIdOf(run.stderr()));
      const recipeTree = descendants(runnerPid);
      killIfAlive(runnerPid);

      const code = await run.exited;
      for (const p of recipeTree) killIfAlive(p.pid);
      killIfAlive(runnerPid);

      expect(code).toBeGreaterThan(0);
      expect(run.stderr()).not.toContain("after its log ended");
      expect(run.stderr()).toContain("ci run summary");
      expect(
        jsonEvents(run.stdout()).some(
          (e) => e.recipe === "slow" && e.status === "errored",
        ),
      ).toBe(true);

      const ci = join(dir, ".ci");
      const shaDirs = existsSync(ci)
        ? readdirSync(ci).filter((n) => n !== "odu.sock" && n !== "odu.run.lock")
        : [];
      expect(shaDirs.length).toBeGreaterThan(0);
      const recordDir = join(ci, shaDirs[0] ?? "", "runs");
      const records = existsSync(recordDir)
        ? readdirSync(recordDir).filter((n) => n.endsWith(".json"))
        : [];
      expect(records.length).toBeGreaterThan(0);
      const record = JSON.parse(
        readFileSync(join(recordDir, records[0] ?? ""), "utf-8"),
      ) as { reserved?: unknown; outcome?: unknown };
      expect(record.reserved).not.toBe(true);
      expect(record.outcome).toBe("failed");
    },
    900_000,
  );

  it(
    "killing the runner after every node succeeded still exits 0",
    async () => {
      const dir = makeFixture("pass");
      created.push(dir);
      const lingerEnv: NodeJS.ProcessEnv = {
        ...env,
        ODU_LINGER_IDLE_MS: "30000",
      };

      const run = startCiRun(
        dir,
        ["--no-strict", "--linger", "--progress", "json"],
        lingerEnv,
      );

      const recipes = ["_ci-setup", "alpha", "beta"];
      await waitUntil(
        () => recipes.every((r) => lastStatuses(run.stdout()).get(r) === "success"),
        600_000,
        "every recipe of the pass fixture to succeed",
      );

      const runnerPid = findRunnerPid(runIdOf(run.stderr()));
      const recipeTree = descendants(runnerPid);
      killIfAlive(runnerPid);

      const code = await run.exited;
      await run.closed;
      for (const p of recipeTree) killIfAlive(p.pid);
      killIfAlive(runnerPid);

      await waitUntil(
        () =>
          /\[odu\] lane \S+ died:/.test(
            readFileSync(findRecipeLog(dir, "_ci-setup"), "utf-8"),
          ),
        60_000,
        "the coordinator to record the lane's death",
      );
      expect(code).toBe(0);
      expect(run.stderr()).not.toContain("write EPIPE");
      expect(run.stderr()).not.toContain("after its log ended");
      expect(
        jsonEvents(run.stdout()).some((e) => e.status === "errored"),
      ).toBe(false);
    },
    900_000,
  );
});
