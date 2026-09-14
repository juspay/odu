/**
 * End-to-end: odu over a THOUSAND-RUN catalog, through the nix-built binary.
 *
 * juspay/odu#113: on a host with 710 runs, `odu attach` sat blank for minutes.
 * Two costs compounded — the daemon's poller parsed every run's whole journal
 * on every 250 ms tick, keeping its event loop busy full-time, and the client
 * read the board one row per round trip, each landing behind a tick. Neither
 * shows up on a catalog of the handful of runs every other suite here makes,
 * which is exactly how it shipped.
 *
 * So this suite makes the catalog big. It runs the `pass` fixture ONCE for a
 * real settled run directory, clones that directory a thousand times across
 * three checkouts (one of them real), and then asks the questions the report
 * was about — each under a bound generous enough for a loaded CI runner and
 * far below the minutes the bug cost. The wall time of each is printed, so a
 * slow-but-passing runner is visible in the log rather than only a red one.
 *
 * Black-box, like the rest of this directory: the catalog is seeded by copying
 * files the binary wrote, and every assertion reads the binary's output.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  BIG,
  buildOduBinary,
  cleanup,
  makeFixture,
  privateWorld,
  suitePortFor,
} from "./harness";

const CLONES = 1_000;
/** Far above any healthy answer, far below the minutes #113 cost. */
const BOUND_MS = 10_000;

let odu: string;
const world = privateWorld(suitePortFor("catalogScale"));
const catalog = join(world.env.ODU_STATE_DIR as string, "runs");
const fixtures: string[] = [];
let seeded: { checkout: string; runId: string };

function cli(
  dir: string,
  args: string[],
  timeout = 300_000,
): { status: number | null; stdout: string; stderr: string; ms: number } {
  const began = Date.now();
  const res = spawnSync(odu, args, {
    cwd: dir,
    env: world.env,
    encoding: "utf-8",
    maxBuffer: BIG,
    timeout,
  });
  const ms = Date.now() - began;
  console.log(`catalog-scale: odu ${args.join(" ")} → ${res.status} in ${ms}ms`);
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, ms };
}

function fixture(name: string): string {
  const dir = realpathSync(makeFixture(name));
  fixtures.push(dir);
  return dir;
}

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** A run id `mintRunId` could have produced, `i + 1` seconds older than `from`. */
function olderId(from: string, i: number): string {
  const ts = Number.parseInt(from.split("-")[0] as string, 36) - (i + 1) * 1_000;
  return `${ts.toString(36).padStart(9, "0")}-${i.toString(36).padStart(8, "0")}`;
}

/**
 * Clone one real run directory `CLONES` times, rewriting the run id in every
 * file and the checkout in the manifest. A third of the clones land in the
 * real checkout, so "this checkout's newest run" has to be found among them.
 */
function seedCatalog(source: string, checkout: string): void {
  const roots = [checkout, "/nonexistent/odu-scale-b", "/nonexistent/odu-scale-c"];
  const from = join(catalog, source);
  for (let i = 0; i < CLONES; i += 1) {
    const id = olderId(source, i);
    const to = join(catalog, id);
    cpSync(from, to, { recursive: true });
    for (const file of filesUnder(to)) {
      const text = readFileSync(file, "utf-8");
      let next = text.split(source).join(id);
      if (file.endsWith("manifest.json")) {
        const manifest = JSON.parse(next) as { repoRoot: string };
        manifest.repoRoot = roots[i % roots.length] as string;
        next = `${JSON.stringify(manifest, null, 2)}\n`;
      }
      if (next !== text) writeFileSync(file, next);
    }
  }
}

beforeAll(async () => {
  odu = buildOduBinary();
  const checkout = fixture("pass");
  const run = cli(checkout, ["run", "--no-strict", "--no-post", "-o", "json"]);
  if (run.status !== 0) {
    throw new Error(`seed run exited ${run.status}: ${run.stdout}\n${run.stderr}`);
  }
  const runId = (JSON.parse(run.stdout) as { runId: string }).runId;
  seeded = { checkout, runId };
  seedCatalog(runId, checkout);
  // The daemon discovers the clones on its own; wait for the board to hold them
  // rather than sleeping on a guess about how long a cold projection takes.
  const deadline = Date.now() + 120_000;
  for (;;) {
    const listed = cli(checkout, ["history", "list", "--all", "-o", "json"]);
    if (listed.status === 0 && (JSON.parse(listed.stdout) as unknown[]).length > CLONES) {
      break;
    }
    if (Date.now() > deadline) throw new Error("the daemon never listed the seeded catalog");
    await new Promise((r) => setTimeout(r, 500));
  }
}, 900_000);

afterAll(() => {
  const cell = cli(world.root, ["surface", "get", "service"], 30_000);
  if (cell.status === 0) {
    try {
      const service = JSON.parse(cell.stdout) as { identity: { pid: number } };
      process.kill(service.identity.pid, "SIGTERM");
    } catch {
      /* already stopped */
    }
  }
  cleanup(world.root);
  for (const dir of fixtures) cleanup(dir);
  // Removing a thousand run directories outlasts bun's default hook budget.
}, 120_000);

describe("a thousand-run catalog", () => {
  it("answers `odu status` in a checkout with no run", () => {
    const empty = fixture("pass");
    const res = cli(empty, ["status"]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe("no run in flight for this checkout\n");
    expect(res.ms).toBeLessThan(BOUND_MS);
  });

  it("names the seeded checkout's newest run among hundreds of its own", () => {
    const res = cli(seeded.checkout, ["status", "-o", "json"]);
    expect(res.status, res.stderr).toBe(0);
    expect((JSON.parse(res.stdout) as { run: { id: string } }).run.id).toBe(seeded.runId);
    expect(res.ms).toBeLessThan(BOUND_MS);
  });

  it("lists every run in one call", () => {
    const res = cli(seeded.checkout, ["history", "list", "--all", "-o", "json"]);
    expect(res.status, res.stderr).toBe(0);
    expect((JSON.parse(res.stdout) as unknown[]).length).toBeGreaterThanOrEqual(CLONES + 1);
    expect(res.ms).toBeLessThan(BOUND_MS);
  });

  it("resolves `--run latest`", () => {
    const res = cli(seeded.checkout, ["wait", "--run", "latest", "-o", "json"]);
    expect(res.status, res.stderr).toBe(0);
    expect((JSON.parse(res.stdout) as { runId: string }).runId).toBe(seeded.runId);
    expect(res.ms).toBeLessThan(BOUND_MS);
  });

  it("keeps answering RPCs while it holds the catalog", () => {
    // The identity cell does no catalog work at all, so its latency is the
    // daemon loop's: a poller hogging the loop is what this would see.
    const res = cli(world.root, ["surface", "get", "service"]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.ms).toBeLessThan(BOUND_MS);
  });

  it("shows `odu attach` on a live run before it settles", async () => {
    const dir = fixture("sleep");
    const runner = spawn(odu, ["run", "--no-strict", "--no-post"], {
      cwd: dir,
      env: world.env,
      stdio: "ignore",
    });
    try {
      // Up when `status` names it — asked, not slept on.
      const deadline = Date.now() + 120_000;
      let runId: string | null = null;
      while (runId === null) {
        const res = cli(dir, ["status", "-o", "json"]);
        if (res.status === 0) {
          runId = (JSON.parse(res.stdout) as { run: { id: string } | null }).run?.id ?? null;
        }
        if (runId === null) {
          if (Date.now() > deadline) throw new Error("the sleep run never appeared");
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      const began = Date.now();
      const attach = spawn(odu, ["attach", "-o", "json"], {
        cwd: dir,
        env: world.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      const first = await new Promise<{ run: string; done: boolean }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`attach showed nothing within ${BOUND_MS}ms: ${buffer}`)),
          BOUND_MS,
        );
        attach.stdout?.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          // One pretty-printed object per frame; the first complete one is enough.
          const end = buffer.indexOf("\n}\n");
          if (end < 0) return;
          clearTimeout(timer);
          resolve(JSON.parse(buffer.slice(0, end + 2)) as { run: string; done: boolean });
        });
      }).finally(() => attach.kill("SIGTERM"));
      console.log(`catalog-scale: attach's first frame in ${Date.now() - began}ms`);
      expect(first.run).toBe(runId);
      expect(first.done).toBe(false);
    } finally {
      cli(dir, ["cancel", "--run", "latest", "-o", "json"], 60_000);
      runner.kill("SIGTERM");
    }
  }, 300_000);
});
