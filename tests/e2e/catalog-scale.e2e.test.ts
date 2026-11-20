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
const BOUND_MS = 10_000;
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

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

function olderId(from: string, i: number): string {
  const ts = Number.parseInt(from.split("-")[0] as string, 36) - (i + 1) * 1_000;
  return `${ts.toString(36).padStart(9, "0")}-${i.toString(36).padStart(8, "0")}`;
}

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
  const run = cli(checkout, ["ci", "run", "--no-strict", "--no-post", "-o", "json"]);
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
}, 120_000);

describe("a thousand-run catalog", () => {
  it("answers `odu ci status` in a checkout with no run", () => {
    const empty = fixture("pass");
    const res = cli(empty, ["ci", "status"]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe("no run in flight for this checkout\n");
    expect(res.ms).toBeLessThan(BOUND_MS);
  }, TEST_MS);

  it("names the seeded checkout's newest run among hundreds of its own", () => {
    const res = cli(seeded.checkout, ["ci", "status", "-o", "json"]);
    expect(res.status, res.stderr).toBe(0);
    expect((JSON.parse(res.stdout) as { run: { id: string } }).run.id).toBe(seeded.runId);
    expect(res.ms).toBeLessThan(BOUND_MS);
  }, TEST_MS);

  it("lists every run in one call", () => {
    const res = cli(seeded.checkout, ["ci", "history", "list", "--all", "-o", "json"]);
    expect(res.status, res.stderr).toBe(0);
    expect((JSON.parse(res.stdout) as unknown[]).length).toBeGreaterThanOrEqual(CLONES + 1);
    expect(res.ms).toBeLessThan(BOUND_MS);
  }, TEST_MS);

  it("resolves `--run latest`", () => {
    const res = cli(seeded.checkout, ["ci", "wait", "--run", "latest", "-o", "json"]);
    expect(res.status, res.stderr).toBe(0);
    expect((JSON.parse(res.stdout) as { runId: string }).runId).toBe(seeded.runId);
    expect(res.ms).toBeLessThan(BOUND_MS);
  }, TEST_MS);

  it("keeps answering RPCs while it holds the catalog", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      samples.push(await identityReadMs());
      await new Promise((r) => setTimeout(r, 250));
    }
    const worst = Math.max(...samples);
    console.log(`catalog-scale: identity cell over HTTP, worst of 8: ${Math.round(worst)}ms`);
    expect(worst).toBeLessThan(1_000);
  }, TEST_MS);

  it("shows `odu ci attach` on a live run before it settles", async () => {
    const dir = fixture("sleep");
    const runner = spawn(odu, ["ci", "run", "--no-strict", "--no-post"], {
      cwd: dir,
      env: world.env,
      stdio: "ignore",
    });
    try {
      const deadline = Date.now() + 120_000;
      let runId: string | null = null;
      while (runId === null) {
        const res = cli(dir, ["ci", "status", "-o", "json"]);
        if (res.status === 0) {
          runId = (JSON.parse(res.stdout) as { run: { id: string } | null }).run?.id ?? null;
        }
        if (runId === null) {
          if (Date.now() > deadline) throw new Error("the sleep run never appeared");
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      const began = Date.now();
      const attach = spawn(odu, ["ci", "attach", "-o", "json"], {
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
      cli(dir, ["ci", "cancel", "--run", "latest", "-o", "json"], 60_000);
      runner.kill("SIGTERM");
    }
  }, 300_000);
});
