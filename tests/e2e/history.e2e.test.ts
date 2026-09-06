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
 *      hold their own. Each gets what it has not seen; both still see the red.
 *   3. The exits are a contract. Passed, a failure to act on, still-going,
 *      no-such-run and a refused cursor are five different exits, and a script
 *      that cannot tell them apart takes the wrong next step.
 *   4. Evidence outlives its checkout. The catalog is per-user, so deleting the
 *      worktree — which used to delete the logs with it — leaves them readable.
 *
 * Black-box like the rest of this directory: nothing is imported from `src/`,
 * and the JSON shapes below are what the binary is asserted to emit rather
 * than a type shared with the code that emits them.
 */

import { rmSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  awaitRunSocket,
  buildOduBinary,
  cleanup,
  currentNixSystem,
  makeFixture,
  oduCli,
  oduRun,
  oduRunBackground,
} from "./harness";

/** This machine's platform, as the node ids in a run of these fixtures spell
 *  it — a node id is `<recipe>@<platform>`. Asked of Nix once, like the rest
 *  of the suite does. */
const PLATFORM = currentNixSystem();

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

/** The attention payload, as this suite asserts it. A local shape on purpose
 *  — see the header: sharing the type with the producer would hide exactly the
 *  wire-shape regressions a black-box suite exists to catch. */
interface Attention {
  run: { id: string; sha7: string | null };
  state: "still_running" | "settled" | "owner_lost" | "expired" | "unknown_run";
  settled: boolean;
  passed: boolean;
  outcome: "passed" | "failed" | "incomplete" | null;
  actionable: boolean;
  cursor: string;
  events: { seq: number }[];
  has_more: boolean;
  unresolved_failures: {
    node: string;
    attempt: number;
    exit_code: number | null;
    log_complete: boolean;
    log_key: string;
    excerpt: string;
    excerpt_source: string;
  }[];
}

/** One `odu logs --run latest -o json` read of the noisy node, parsed. */
function logJson(
  dir: string,
  extra: string[],
): {
  attempt: number;
  attempts: number[];
  offset: number;
  bytes_read: number;
  next_offset: number;
  size: number;
  eof: boolean;
  complete: boolean;
  text: string;
} {
  const res = oduCli(oduBin, dir, [
    "logs",
    "--run",
    "latest",
    "-o",
    "json",
    ...extra,
    `noisy@${PLATFORM}`,
  ]);
  expect(res.status, `stderr was:\n${res.stderr}`).toBe(0);
  return JSON.parse(res.stdout.trim());
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
    expect(attention.state).toBe("still_running");

    const failure = attention.unresolved_failures.find((f) =>
      f.node.startsWith("quick@"),
    );
    expect(failure, "the quick lane's failure should be reported").toBeDefined();
    expect(failure!.exit_code).toBe(1);
    // The log BARRIER: a failure is only reported once its output is complete,
    // so the excerpt carries the reason rather than a half-written line.
    expect(failure!.log_complete).toBe(true);
    expect(failure!.excerpt).toContain("BOOM: the quick lane failed");
    expect(failure!.excerpt_source).toBe("attempt_log");
    // The address to read it again, echoed rather than reassembled.
    expect(failure!.log_key).toContain(attention.run.id);

    // A failure to act on, whether or not every lane has finished.
    expect(status).toBe(1);
  }, 300_000);

  it("gives two callers their own cursor, and keeps the red for both", async () => {
    const dir = fixture("fast-red");
    const bg = oduRunBackground(oduBin, dir, ["--no-strict", "--progress", "json"]);
    running.push({ kill: () => bg.child.kill("SIGTERM"), exited: bg.exited });
    await awaitRunSocket(dir);

    const first = waitJson(dir, ["--run", "latest", "--deadline-ms", "60000"]);
    const runId = first.attention.run.id;

    // A SECOND caller with no cursor sees the run from the beginning — one
    // caller acknowledging events does not consume them for anybody else.
    const second = waitJson(dir, ["--run", runId, "--deadline-ms", "5000"]);
    expect(second.attention.events.length).toBeGreaterThan(0);

    // The FIRST caller, resuming: it is not shown what it already had…
    const resumed = waitJson(dir, [
      "--run",
      runId,
      "--after",
      first.attention.cursor,
      "--deadline-ms",
      "3000",
    ]);
    for (const event of resumed.attention.events) {
      expect(event.seq).toBeGreaterThan(
        Number(first.attention.cursor.split("@")[1]),
      );
    }
    // …and the failure is STILL there. Acknowledging a cursor suppresses
    // repeats; it does not resolve anything, and this is the assertion that
    // says so out loud.
    expect(
      resumed.attention.unresolved_failures.some((f) =>
        f.node.startsWith("quick@"),
      ),
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
    expect(pending.attention.state).toBe("still_running");
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
      pending.attention.run.id,
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
    expect(payload.error).toBe("cursor_refused");
    expect(payload.resync).toContain(pending.attention.run.id);
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
    expect(attention.state).toBe("settled");
  }, 300_000);

  it("exits 1 for a run that failed, with the failing node named", () => {
    const dir = fixture("fail");
    expect(oduRun(oduBin, dir).status).not.toBe(0);

    const { status, attention } = waitJson(dir, ["--run", "latest"]);
    expect(status).toBe(1);
    expect(attention.outcome).toBe("failed");
    expect(
      attention.unresolved_failures.some((f) => f.node.startsWith("boom@")),
    ).toBe(true);
  }, 300_000);
});

describe("evidence is addressed, complete, and outlives its checkout", () => {
  it("reads a noisy node's log back by byte range, and says it is complete", () => {
    const dir = fixture("noisy");
    expect(oduRun(oduBin, dir).status).toBe(0);

    // BY RANGE, and the range is the point twice over. It is the API a caller
    // resuming a long log uses — and it is also the only way to ask this
    // question through a pipe: the fixture's log is ~14 MB, which is more than
    // a `spawnSync` capture will carry, so a test that demanded the whole
    // thing in one answer would be testing the harness.
    const head = logJson(dir, ["--limit", "4096"]);
    expect(head.attempts).toEqual([1]);
    expect(head.offset).toBe(0);
    expect(head.size).toBeGreaterThan(1_000_000);
    expect(head.eof).toBe(false);
    // The continuation offset is a FACT ABOUT THE READ, not something a
    // consumer may recompute from the text: the decode is non-fatal, so a
    // range that split a multibyte character has more bytes in the string than
    // were taken off the file.
    expect(head.next_offset).toBe(head.offset + head.bytes_read);
    expect(head.bytes_read).toBeLessThanOrEqual(4096);

    // A negative offset is a tail. The END is the part that used to go missing
    // (juspay/odu#87): a log that stops early is still "a log", and only its
    // last line says otherwise.
    // `--offset=-N`, joined: `parseArgs` refuses a bare `--offset -4096`
    // because a leading dash is ambiguous with the next flag. The joined form
    // is the one the usage text shows for exactly this reason.
    const tail = logJson(dir, ["--offset=-4096"]);
    expect(tail.eof).toBe(true);
    expect(tail.complete).toBe(true);
    expect(tail.text).toContain("__ODU_NOISY_END__");
    expect(tail.size).toBe(head.size);
  }, 600_000);

  it("still serves a run's logs after its checkout has been deleted", () => {
    const dir = fixture("pass");
    expect(oduRun(oduBin, dir).status).toBe(0);

    const listed = oduCli(oduBin, dir, ["history", "list", "-o", "json"]);
    const rows = JSON.parse(listed.stdout.trim()) as { runId: string }[];
    expect(rows.length).toBeGreaterThan(0);
    const runId = rows[0]!.runId;
    const node = `alpha@${PLATFORM}`;

    // The move the old layout could not survive: the worktree goes away, and
    // with it `.ci/` and every byte of the run's output.
    rmSync(dir, { recursive: true, force: true });
    created.splice(created.indexOf(dir), 1);

    // Asked from somewhere else entirely — the catalog is per user, not per
    // checkout, so the run id is still an address.
    const logs = oduCli(oduBin, process.cwd(), [
      "logs",
      "--run",
      runId,
      "-o",
      "json",
      node,
    ]);
    expect(logs.status).toBe(0);
    const payload = JSON.parse(logs.stdout.trim()) as {
      text: string;
      complete: boolean;
    };
    expect(payload.text).toContain("alpha ran");
    expect(payload.complete).toBe(true);
  }, 300_000);

  it("refuses an attempt that was never recorded, and lists the ones that were", () => {
    const dir = fixture("pass");
    expect(oduRun(oduBin, dir).status).toBe(0);
    const res = oduCli(oduBin, dir, [
      "logs",
      "--run",
      "latest",
      "--attempt",
      "7",
      `alpha@${PLATFORM}`,
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no attempt 7");
    expect(res.stderr).toContain("recorded: 1");
  }, 300_000);
});
