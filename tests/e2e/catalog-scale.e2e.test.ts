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
  appendFileSync,
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
/** Journal lines per clone. The `pass` fixture writes about twenty, and the
 *  daemon-side half of #113 — a poller that parsed every journal every tick —
 *  costs in proportion to this; at twenty lines the base build's tick is cheap
 *  and the responsiveness check below would pass against it. Same figure as
 *  `tests/evidence/big-catalog-demo.sh`. */
const JOURNAL = 1_500;
/** Far above any healthy answer, far below the minutes #113 cost. */
const BOUND_MS = 10_000;
/** A test's own budget, above `BOUND_MS`, so a slow answer fails the bound —
 *  with its measured time — rather than bun's 5 s default killing the call. */
const TEST_MS = 3 * BOUND_MS;

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
 * file and the checkout in the manifest, and padding each journal to `JOURNAL`
 * lines of well-formed `phase` events. A third of the clones land in the real
 * checkout, so "this checkout's newest run" has to be found among them.
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
    const events = join(to, "events");
    const lines = readFileSync(events, "utf-8").trimEnd().split("\n");
    const last = JSON.parse(lines.at(-1) as string) as { seq: number; at: number };
    const pad: string[] = [];
    for (let k = 1; lines.length + pad.length < JOURNAL; k += 1) {
      pad.push(
        JSON.stringify({ seq: last.seq + k, at: last.at, event: { kind: "phase", phase: "lanes" } }),
      );
    }
    appendFileSync(events, `${pad.join("\n")}\n`);
  }
}

/** One read of the identity cell over the HTTP MCP door, timed from THIS
 *  process — no `odu` process start in the measurement, so a sub-second bound
 *  is about the daemon's loop and nothing else. */
async function identityReadMs(): Promise<number> {
  const began = performance.now();
  const response = await fetch(`${world.origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "surface://cells/service" },
    }),
  });
  const answer = (await response.json()) as { result?: { contents: { text: string }[] } };
  const took = performance.now() - began;
  const cell = JSON.parse(answer.result?.contents[0]?.text ?? "{}") as { identity?: unknown };
  if (cell.identity === undefined) throw new Error(`no identity cell: ${JSON.stringify(answer)}`);
  return took;
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
  // Seeded with NO daemon running, then a fresh one started: `odu web
  // --background` returns only once the service says `ready`, which it says
  // after its first full projection of the catalog — so every assertion below
  // meets a daemon that already holds all of it, and a slow cold start is the
  // setup's cost rather than a test's.
  stopDaemon();
  seedCatalog(runId, checkout);
  const up = cli(checkout, ["web", "--background"], 600_000);
  if (up.status !== 0) throw new Error(`odu web --background exited ${up.status}: ${up.stderr}`);
}, 900_000);

/** Stop this world's daemon, if one answers, and wait for it to be gone. */
function stopDaemon(): void {
  const cell = cli(world.root, ["surface", "get", "service"], 30_000);
  if (cell.status !== 0) return;
  const pid = (JSON.parse(cell.stdout) as { identity: { pid: number } }).identity.pid;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error(`daemon ${pid} did not stop`);
    Bun.sleepSync(100);
  }
}

afterAll(() => {
  stopDaemon();
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
  }, TEST_MS);

  it("names the seeded checkout's newest run among hundreds of its own", () => {
    const res = cli(seeded.checkout, ["status", "-o", "json"]);
    expect(res.status, res.stderr).toBe(0);
    expect((JSON.parse(res.stdout) as { run: { id: string } }).run.id).toBe(seeded.runId);
    expect(res.ms).toBeLessThan(BOUND_MS);
  }, TEST_MS);

  it("lists every run in one call", () => {
    const res = cli(seeded.checkout, ["history", "list", "--all", "-o", "json"]);
    expect(res.status, res.stderr).toBe(0);
    expect((JSON.parse(res.stdout) as unknown[]).length).toBeGreaterThanOrEqual(CLONES + 1);
    expect(res.ms).toBeLessThan(BOUND_MS);
  }, TEST_MS);

  it("resolves `--run latest`", () => {
    const res = cli(seeded.checkout, ["wait", "--run", "latest", "-o", "json"]);
    expect(res.status, res.stderr).toBe(0);
    expect((JSON.parse(res.stdout) as { runId: string }).runId).toBe(seeded.runId);
    expect(res.ms).toBeLessThan(BOUND_MS);
  }, TEST_MS);

  it("keeps answering RPCs while it holds the catalog", async () => {
    // The identity cell does no catalog work at all, so its latency is the
    // daemon loop's. Sampled across a couple of seconds, because one read can
    // land in the gap between two ticks: the worst of them is what a poller
    // hogging the loop would show. On the base build a tick over this catalog
    // takes seconds, so the bound discriminates by an order of magnitude.
    const samples: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      samples.push(await identityReadMs());
      await new Promise((r) => setTimeout(r, 250));
    }
    const worst = Math.max(...samples);
    console.log(`catalog-scale: identity cell over HTTP, worst of 8: ${Math.round(worst)}ms`);
    expect(worst).toBeLessThan(1_000);
  }, TEST_MS);

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
