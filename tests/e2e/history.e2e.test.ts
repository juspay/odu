import { rmSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  awaitRunSocket,
  buildOduBinary,
  cleanup,
  makeFixture,
  oduCli,
  oduRun,
  oduRunBackground,
} from "./harness";

let oduBin: string;

beforeAll(() => {
  oduBin = buildOduBinary();
}, 600_000);

const created: string[] = [];
const running: { kill: () => void; exited: Promise<void> }[] = [];
afterEach(async () => {
  for (const run of running.splice(0)) {
    run.kill();
    await run.exited;
  }
  for (const dir of created.splice(0)) cleanup(dir);
});

function fixture(name: string): string {
  const dir = makeFixture(name);
  created.push(dir);
  return dir;
}

interface Failure {
  node: string;
  attempt: number;
  status: "failed" | "errored";
  exitCode: number | null;
  platform: string;
  logKey: string;
  logComplete: boolean;
  excerpt: string;
  excerptSource: "attempt_log" | "none";
}

interface Attention {
  runId: string;
  reason: "failure" | "still_running" | "settled" | "owner_lost";
  settled: boolean;
  passed: boolean;
  outcome: "passed" | "failed" | "incomplete" | null;
  sha: string | null;
  failures: Failure[];
  failuresTotal: number;
  cursor: string;
  remaining: number;
  hasMore: boolean;
}

interface LogPage {
  key: string;
  text: string;
  offset: number;
  size: number;
  nextOffset: number;
  eof: boolean;
  complete: boolean;
  open: boolean;
}

function waitJson(
  dir: string,
  argv: string[],
): { status: number | null; attention: Attention } {
  const res = oduCli(oduBin, dir, ["ci", "wait", "-o", "json", ...argv]);
  const line = res.stdout.trim();
  expect(
    line,
    `expected one JSON line on stdout; stderr was:\n${res.stderr}`,
  ).not.toBe("");
  return { status: res.status, attention: JSON.parse(line) as Attention };
}

function logJson(dir: string, key: string, extra: string[] = []): LogPage {
  const res = oduCli(oduBin, dir, ["ci", "logs", ...extra, "-o", "json", key]);
  expect(res.status, `stderr was:\n${res.stderr}`).toBe(0);
  return JSON.parse(res.stdout.trim()) as LogPage;
}

describe("a bounded wait answers before the slow lane finishes", () => {
  it("returns the red lane's diagnostics while its 120s sibling is still running", async () => {
    const dir = fixture("fast-red");
    const bg = oduRunBackground(oduBin, dir, ["--no-strict", "--progress", "json"]);
    running.push({ kill: () => bg.child.kill("SIGTERM"), exited: bg.exited });
    await awaitRunSocket(dir);

    const started = Date.now();
    const { status, attention } = waitJson(dir, [
      "--run",
      "latest",
      "--deadline-ms",
      "60000",
    ]);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(90_000);
    expect(attention.settled).toBe(false);
    expect(attention.reason).toBe("failure");

    const failure = attention.failures.find((f) => f.node.startsWith("quick@"));
    expect(failure, "the quick lane's failure should be reported").toBeDefined();
    expect(failure!.exitCode).toBe(1);
    expect(failure!.logComplete).toBe(true);
    expect(failure!.excerpt).toContain("BOOM: the quick lane failed");
    expect(failure!.excerptSource).toBe("attempt_log");
    expect(failure!.logKey).toContain(attention.runId);

    expect(status).toBe(1);
  }, 300_000);

  it("gives two callers their own cursor, and keeps the red for both", async () => {
    const dir = fixture("fast-red");
    const bg = oduRunBackground(oduBin, dir, ["--no-strict", "--progress", "json"]);
    running.push({ kill: () => bg.child.kill("SIGTERM"), exited: bg.exited });
    await awaitRunSocket(dir);

    const first = waitJson(dir, ["--run", "latest", "--deadline-ms", "60000"]);
    const runId = first.attention.runId;
    expect(first.attention.cursor).toContain(runId);

    const second = waitJson(dir, ["--run", runId, "--deadline-ms", "5000"]);
    expect(second.attention.cursor).toContain(runId);
    expect(
      second.attention.failures.some((f) => f.node.startsWith("quick@")),
    ).toBe(true);

    const resumed = waitJson(dir, [
      "--run",
      runId,
      "--after",
      first.attention.cursor,
      "--deadline-ms",
      "3000",
    ]);
    const seq = (cursor: string): number => Number(cursor.split("@")[1]);
    expect(seq(resumed.attention.cursor)).toBeGreaterThanOrEqual(
      seq(first.attention.cursor),
    );
    expect(
      resumed.attention.failures.some((f) => f.node.startsWith("quick@")),
    ).toBe(true);
    expect(resumed.status).toBe(1);
  }, 300_000);
});

describe("the wait's exits are a contract", () => {
  it("says still-going, no-such-run and refused-cursor with three different codes", async () => {
    const dir = fixture("sleep");
    const bg = oduRunBackground(oduBin, dir, ["--no-strict", "--progress", "json"]);
    running.push({ kill: () => bg.child.kill("SIGTERM"), exited: bg.exited });
    await awaitRunSocket(dir);

    const pending = waitJson(dir, ["--run", "latest", "--deadline-ms", "1500"]);
    expect(pending.status).toBe(2);
    expect(pending.attention.reason).toBe("still_running");
    expect(pending.attention.passed).toBe(false);

    const unknown = oduCli(oduBin, dir, [
      "ci",
      "wait",
      "--run",
      "0zzzzzzzz-zzzzzzzz",
      "-o",
      "json",
    ]);
    expect(unknown.status).toBe(4);

    const refused = oduCli(oduBin, dir, [
      "ci",
      "wait",
      "--run",
      pending.attention.runId,
      "--after",
      "0zzzzzzzz-zzzzzzzz@3",
      "-o",
      "json",
    ]);
    expect(refused.status).toBe(5);
    const payload = JSON.parse(refused.stdout.trim()) as {
      error: string;
      resync: string;
    };
    expect(payload.error).toBe("bad_cursor");
    expect(payload.resync).toContain(pending.attention.runId);
  }, 300_000);

  it("exits 0 for a run that passed, and reports its verdict long after it ended", () => {
    const dir = fixture("pass");
    expect(oduRun(oduBin, dir).status).toBe(0);

    const { status, attention } = waitJson(dir, ["--run", "latest"]);
    expect(status).toBe(0);
    expect(attention.settled).toBe(true);
    expect(attention.passed).toBe(true);
    expect(attention.outcome).toBe("passed");
    expect(attention.reason).toBe("settled");
  }, 300_000);

  it("exits 1 for a run that failed, with the failing node named", () => {
    const dir = fixture("fail");
    expect(oduRun(oduBin, dir).status).not.toBe(0);

    const { status, attention } = waitJson(dir, ["--run", "latest"]);
    expect(status).toBe(1);
    expect(attention.outcome).toBe("failed");
    expect(attention.failures.some((f) => f.node.startsWith("boom@"))).toBe(true);
  }, 300_000);

  it("resolves `latest` to THIS checkout's newest run, not the catalog's", () => {
    const red = fixture("fail");
    expect(oduRun(oduBin, red).status).not.toBe(0);
    const green = fixture("pass");
    expect(oduRun(oduBin, green).status).toBe(0);

    expect(waitJson(red, ["--run", "latest"]).attention.outcome).toBe("failed");
    expect(waitJson(green, ["--run", "latest"]).attention.outcome).toBe("passed");
  }, 600_000);
});

describe("evidence is addressed, complete, and outlives its checkout", () => {
  it("reads a noisy node's log back by byte range, and says it is complete", () => {
    const dir = fixture("noisy-red");
    expect(oduRun(oduBin, dir).status).not.toBe(0);
    const { attention } = waitJson(dir, ["--run", "latest"]);
    const failure = attention.failures.find((f) => f.node.startsWith("noisy-red@"));
    expect(failure, "the noisy lane's failure should carry a log key").toBeDefined();
    const key = failure!.logKey;

    const head = logJson(dir, key, ["--limit", "4096"]);
    expect(head.offset).toBe(0);
    expect(head.size).toBeGreaterThan(1_000_000);
    expect(head.eof).toBe(false);
    expect(head.nextOffset).toBeGreaterThan(head.offset);
    expect(head.nextOffset - head.offset).toBeLessThanOrEqual(4096);

    // `--offset=-N`, joined: `parseArgs` refuses a bare `--offset -4096`
    // because a leading dash is ambiguous with the next flag. The joined form
    // is the one the usage text shows for exactly this reason.
    const tail = logJson(dir, key, ["--offset=-4096"]);
    expect(tail.eof).toBe(true);
    expect(tail.complete).toBe(true);
    expect(tail.text).toContain("__ODU_NOISY_END__");
    expect(tail.size).toBe(head.size);
  }, 600_000);

  it("still serves a run's logs after its checkout has been deleted", () => {
    const dir = fixture("fail");
    expect(oduRun(oduBin, dir).status).not.toBe(0);

    const { attention } = waitJson(dir, ["--run", "latest"]);
    const failure = attention.failures[0];
    expect(failure, "the failing node should have reported a log key").toBeDefined();
    const key = failure!.logKey;

    rmSync(dir, { recursive: true, force: true });
    created.splice(created.indexOf(dir), 1);

    const page = logJson(process.cwd(), key);
    expect(page.complete).toBe(true);
    expect(page.text.length).toBeGreaterThan(0);
  }, 300_000);

  it("refuses an attempt that was never recorded", () => {
    const dir = fixture("fail");
    expect(oduRun(oduBin, dir).status).not.toBe(0);
    const { attention } = waitJson(dir, ["--run", "latest"]);
    const key = attention.failures[0]!.logKey;
    const never = key.replace(/\/\d+$/, "/7");

    const res = oduCli(oduBin, dir, ["ci", "logs", never]);
    expect(res.status).toBe(4);
    expect(res.stderr).toContain("attempt 7");
  }, 300_000);
});
