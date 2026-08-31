/**
 * Black-box: kill the localhost runner (the stdio pipe) after MANY nodes have
 * finished and one is still running. The incident was eight sealed-log throws
 * in one burst; N=1 survived on master (throw printed, record still written).
 * The coordinator must error the live node and settle — not die on
 * `logTail: append to <finished> after its log ended`.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { buildOduBinary, cleanup, hermeticEnv, makeFixture } from "./harness";

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
  for (const dir of created.splice(0)) cleanup(dir);
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
  return args.includes("runner/main.ts") || /(^|[/\s])odu-runner(\s|$)/.test(args);
}

function findRunnerPid(oduPid: number): number {
  const tree = descendants(oduPid);
  const runner = tree.find((p) => isRunner(p.args));
  if (runner === undefined) {
    throw new Error(
      `no odu-runner under pid ${oduPid}: ${tree.map((p) => `${p.pid} ${p.args}`).join("; ") || "(empty tree)"}`,
    );
  }
  return runner.pid;
}

function killIfAlive(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
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
      // non-JSON on stdout is noise; the assertions below look at recipes.
    }
  }
  return events;
}

/** Last-seen status per recipe. Empty until the first progress line. */
function lastStatuses(stdout: string): Map<string, string> {
  const last = new Map<string, string>();
  for (const e of jsonEvents(stdout)) last.set(e.recipe, e.status);
  return last;
}

/** Durable per-recipe log under `.ci/<sha>/<plat>/<recipe>.log`. */
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

      const child = spawn(oduBin, ["run", "--no-strict", "--progress", "json"], {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      live.push(child);
      const oduPid = child.pid;
      if (oduPid === undefined) throw new Error("odu spawn produced no pid");

      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");
      child.stdout?.on("data", (c: string) => {
        stdout += c;
      });
      child.stderr?.on("data", (c: string) => {
        stderr += c;
      });
      const exited = new Promise<number>((resolve) => {
        child.on("exit", (code) => resolve(code ?? -1));
        child.on("error", () => resolve(-1));
      });

      const finished = ["a", "b", "c", "d", "e", "f", "g", "h"];
      await waitUntil(
        () => {
          const ev = jsonEvents(stdout);
          return (
            finished.every((r) =>
              ev.some((e) => e.recipe === r && e.status === "success"),
            ) && ev.some((e) => e.recipe === "slow" && e.status === "running")
          );
        },
        600_000,
        "eight recipes to succeed while slow is still running",
      );

      const runnerPid = findRunnerPid(oduPid);
      // Snapshot recipe children now: SIGKILL of the runner cannot reap them.
      const recipeTree = descendants(runnerPid);
      killIfAlive(runnerPid);

      const code = await exited;
      for (const p of recipeTree) killIfAlive(p.pid);
      killIfAlive(runnerPid);

      // Errored node → non-zero. A crash also exits non-zero, so the rest of
      // the assertions tell them apart: no sealed-log throw, a verdict block,
      // a real run record, slow errored.
      expect(code).toBeGreaterThan(0);
      expect(stderr).not.toContain("after its log ended");
      expect(stderr).toContain("ci run summary");
      expect(
        jsonEvents(stdout).some((e) => e.recipe === "slow" && e.status === "errored"),
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
      // Dual of the test above, and the shape juspay/odu#18 named: the
      // verdict is already green, THEN the lane pipe dies. `--linger` keeps
      // the runner attached past settle so the kill is not a race with
      // natural `lane.close()`; idle-reap then exits via `verdictCode`.
      // An `ok` node is immune to `onDead`'s overlay; a still-running one
      // is not. A crash on EPIPE / a sealed-log throw would pick a
      // non-zero code here even though the projection is already 0.
      const dir = makeFixture("pass");
      created.push(dir);
      const lingerEnv: NodeJS.ProcessEnv = {
        ...env,
        ODU_LINGER_IDLE_MS: "3000",
      };

      const child = spawn(
        oduBin,
        ["run", "--no-strict", "--linger", "--progress", "json"],
        {
          cwd: dir,
          stdio: ["ignore", "pipe", "pipe"],
          env: lingerEnv,
        },
      );
      live.push(child);
      const oduPid = child.pid;
      if (oduPid === undefined) throw new Error("odu spawn produced no pid");

      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");
      child.stdout?.on("data", (c: string) => {
        stdout += c;
      });
      child.stderr?.on("data", (c: string) => {
        stderr += c;
      });
      const exited = new Promise<number>((resolve) => {
        child.on("exit", (code) => resolve(code ?? -1));
        child.on("error", () => resolve(-1));
      });

      await waitUntil(
        () => {
          const last = lastStatuses(stdout);
          return (
            last.size > 0 && [...last.values()].every((s) => s === "success")
          );
        },
        600_000,
        "every seen recipe's last status to be success",
      );

      const runnerPid = findRunnerPid(oduPid);
      const recipeTree = descendants(runnerPid);
      killIfAlive(runnerPid);

      const code = await exited;
      for (const p of recipeTree) killIfAlive(p.pid);
      killIfAlive(runnerPid);

      // Positive evidence the coordinator observed the death — otherwise a
      // linger that idle-reaped without noticing the kill would also exit 0
      // and satisfy the negative greps. `die()` writes this line onto
      // `_ci-setup` via `onSetupLine`.
      expect(readFileSync(findRecipeLog(dir, "_ci-setup"), "utf-8")).toMatch(
        /\[odu\] lane \S+ died:/,
      );
      expect(code).toBe(0);
      expect(stderr).not.toContain("write EPIPE");
      expect(stderr).not.toContain("after its log ended");
      expect(
        jsonEvents(stdout).some((e) => e.status === "errored"),
      ).toBe(false);
    },
    900_000,
  );
});
