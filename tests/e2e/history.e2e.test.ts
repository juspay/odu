/**
 * End-to-end: the durable run catalog, through the real nix-built binary.
 *
 * This suite exists because the promises the catalog makes are all promises
 * about a run NOBODY IS SERVING, and none of them can be measured in-process:
 * they are about what a second command, in a second terminal, can find out —
 * after the coordinator exited, after the checkout was deleted, without
 * attaching to anything.
 *
 * Four claims are asserted here and nowhere else:
 *
 *   1. A bounded wait returns a red node's diagnostics BEFORE its sibling
 *      settles. The `fast-red` fixture pairs a lane that fails at once with a
 *      lane that sleeps for two minutes; a wait that reported the failure only
 *      after settlement would take those two minutes, so the assertion is
 *      about the CLOCK as well as the payload.
 *   2. A cursor suppresses repeats without resolving anything, and two callers
 *      hold their own. Each resumes where it left off; both still see the red.
 *   3. The exits are a contract. Passed, a failure to act on, still-going,
 *      no-such-run and a refused cursor are five different exits, and a script
 *      that cannot tell them apart takes the wrong next step.
 *   4. Evidence outlives its checkout. The catalog is per-user, so deleting the
 *      worktree — which used to delete the logs with it — leaves it readable.
 *
 * Black-box like the rest of this directory: nothing is imported from `src/`,
 * and the JSON shapes below are what the binary is asserted to emit rather
 * than a type shared with the code that emits them.
 *
 * ## A LOG IS ADDRESSED BY THE KEY ODU ISSUED
 *
 * Not by `--run R <node>`, and this suite must not reassemble one either. The
 * key is `<runId>/<encoded node>/<attempt>` and the encoding is odu's, so the
 * only supported way to hold one is to have been given it. This suite takes
 * every key from a FAILURE's `logKey`, which is the route that still works
 * once the run is over — `odu status` hands out keys too, but only for a run
 * that has not finished, so reading one from there is a race against a fixture
 * that settles in seconds. That is why the big-log fixture is red. A test that
 * built a key by hand would pass against an encoding the product does not
 * have.
 */

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
}, 600_000); // nix build, cold cache

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

/** One reported failure, as this suite asserts it. A local shape on purpose —
 *  see the header: sharing the type with the producer would hide exactly the
 *  wire-shape regressions a black-box suite exists to catch. */
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

/** The attention payload `odu wait -o json` and `odu history show -o json`
 *  both answer with. */
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

/** One `odu logs <key> -o json` read, parsed. */
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
  const res = oduCli(oduBin, dir, ["wait", "-o", "json", ...argv]);
  const line = res.stdout.trim();
  expect(
    line,
    `expected one JSON line on stdout; stderr was:\n${res.stderr}`,
  ).not.toBe("");
  return { status: res.status, attention: JSON.parse(line) as Attention };
}

function logJson(dir: string, key: string, extra: string[] = []): LogPage {
  const res = oduCli(oduBin, dir, ["logs", ...extra, "-o", "json", key]);
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
    // A deadline far shorter than the sibling's sleep: if this only answered on
    // settlement it could not answer inside it at all.
    const { status, attention } = waitJson(dir, [
      "--run",
      "latest",
      "--deadline-ms",
      "60000",
    ]);
    const elapsed = Date.now() - started;

    // ORDERING, not a latency threshold: the sibling sleeps 120s, so returning
    // at all means returning before it settled. The generous bound below only
    // catches a wait that has stopped returning early altogether.
    expect(elapsed).toBeLessThan(90_000);
    expect(attention.settled).toBe(false);
    expect(attention.reason).toBe("failure");

    const failure = attention.failures.find((f) => f.node.startsWith("quick@"));
    expect(failure, "the quick lane's failure should be reported").toBeDefined();
    expect(failure!.exitCode).toBe(1);
    // The log BARRIER: a failure is only reported once its output is complete,
    // so the excerpt carries the reason rather than a half-written line.
    expect(failure!.logComplete).toBe(true);
    expect(failure!.excerpt).toContain("BOOM: the quick lane failed");
    expect(failure!.excerptSource).toBe("attempt_log");
    // The address to read it again, echoed rather than reassembled.
    expect(failure!.logKey).toContain(attention.runId);

    // A failure to act on, whether or not every lane has finished.
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

    // A SECOND caller with no cursor sees the run from the beginning — one
    // caller acknowledging events does not consume them for anybody else.
    const second = waitJson(dir, ["--run", runId, "--deadline-ms", "5000"]);
    expect(second.attention.cursor).toContain(runId);
    expect(
      second.attention.failures.some((f) => f.node.startsWith("quick@")),
    ).toBe(true);

    // The FIRST caller, resuming: its cursor never goes backwards…
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
    // …and the failure is STILL there. Acknowledging a cursor suppresses
    // repeats; it does not resolve anything, and this is the assertion that
    // says so out loud.
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

    // Nothing red, nothing settled: still going.
    const pending = waitJson(dir, ["--run", "latest", "--deadline-ms", "1500"]);
    expect(pending.status).toBe(2);
    expect(pending.attention.reason).toBe("still_running");
    expect(pending.attention.passed).toBe(false);

    // A run that does not exist is not a failure of the run — it is a failure
    // of the question.
    const unknown = oduCli(oduBin, dir, [
      "wait",
      "--run",
      "0zzzzzzzz-zzzzzzzz",
      "-o",
      "json",
    ]);
    expect(unknown.status).toBe(4);

    // A cursor for another run is refused WITH a resync route, never silently
    // restarted from zero.
    const refused = oduCli(oduBin, dir, [
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
    // A refusal WITH A ROUTE: the exact command that resyncs, so a caller that
    // has lost its place is told where to stand rather than left to guess.
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
    // No coordinator is serving anything by now — this is read off disk.
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
    // Two checkouts, two runs, and the second one is newer. A `latest` that
    // meant "newest in the catalog" would answer the first with the second's
    // verdict — green where the caller is red — which is the failure this
    // grammar has to not have.
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
    // RED on purpose. The key has to be one odu issued (see the header), and a
    // failure is the route that still works once the run is over — reading it
    // off a live node is a race against a fixture that settles in seconds.
    const dir = fixture("noisy-red");
    expect(oduRun(oduBin, dir).status).not.toBe(0);
    const { attention } = waitJson(dir, ["--run", "latest"]);
    const failure = attention.failures.find((f) => f.node.startsWith("noisy-red@"));
    expect(failure, "the noisy lane's failure should carry a log key").toBeDefined();
    const key = failure!.logKey;

    // BY RANGE, and the range is the point twice over. It is the API a caller
    // resuming a long log uses — and it is also the only way to ask this
    // question through a pipe: the fixture's log is megabytes, which is more
    // than a `spawnSync` capture will comfortably carry, so a test that
    // demanded the whole thing in one answer would be testing the harness.
    const head = logJson(dir, key, ["--limit", "4096"]);
    expect(head.offset).toBe(0);
    expect(head.size).toBeGreaterThan(1_000_000);
    expect(head.eof).toBe(false);
    // The continuation offset is a FACT ABOUT THE READ, not something a
    // consumer may recompute from the text: the decode is non-fatal, so a
    // range that split a multibyte character has more characters in the string
    // than were taken off the file.
    expect(head.nextOffset).toBeGreaterThan(head.offset);
    expect(head.nextOffset - head.offset).toBeLessThanOrEqual(4096);

    // A negative offset is a tail. The END is the part that used to go missing
    // (juspay/odu#87): a log that stops early is still "a log", and only its
    // last line says otherwise.
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

    // The address comes from the failure that reported it, which is how a
    // person or an agent actually comes to hold one.
    const { attention } = waitJson(dir, ["--run", "latest"]);
    const failure = attention.failures[0];
    expect(failure, "the failing node should have reported a log key").toBeDefined();
    const key = failure!.logKey;

    // The move the old layout could not survive: the worktree goes away, and
    // with it `.ci/` and every byte of the run's output.
    rmSync(dir, { recursive: true, force: true });
    created.splice(created.indexOf(dir), 1);

    // Asked from somewhere else entirely — the catalog is per user, not per
    // checkout, so the key is still an address.
    const page = logJson(process.cwd(), key);
    expect(page.complete).toBe(true);
    expect(page.text.length).toBeGreaterThan(0);
  }, 300_000);

  it("refuses an attempt that was never recorded", () => {
    const dir = fixture("fail");
    expect(oduRun(oduBin, dir).status).not.toBe(0);
    const { attention } = waitJson(dir, ["--run", "latest"]);
    const key = attention.failures[0]!.logKey;
    // The SAME key with a different attempt — an address odu's grammar accepts
    // and its catalog cannot answer, which is a different thing from a
    // malformed key and gets a different exit.
    const never = key.replace(/\/\d+$/, "/7");

    const res = oduCli(oduBin, dir, ["logs", never]);
    expect(res.status).toBe(4);
    expect(res.stderr).toContain("attempt 7");
  }, 300_000);
});
