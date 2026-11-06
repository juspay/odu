/**
 * The FOLLOW — `log.read` with a `waitMs`, and the third fact that lets it stop.
 *
 * A paged read and a follow are the same call here, which is the whole design:
 * the cursor is `nextOffset` and the caller holds it, so a follow that dies is
 * re-issued rather than resumed. That makes two rules load-bearing, and every
 * test below is about one of them:
 *
 *   - **A follower that is BEHIND is never delayed.** The wait fires only when
 *     the page came back empty. Waiting with bytes in hand would turn reading a
 *     finished log into one deadline per page.
 *   - **`open` is not inferable.** `eof` is about this read and `complete` is
 *     about the producer; a log whose writer was KILLED is at eof, is not
 *     complete, and is never getting another byte. A follower that guessed from
 *     the other two would block on that log until the heat death of its
 *     deadline, forever, on every call.
 *
 * Real files throughout, via the catalog's own writers — the thing being tested
 * is a disagreement between what a reader believes and what a writer left on
 * disk, and a stubbed store could not have one.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Fiber } from "effect";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { encodeNodeKey } from "@odu/run-history/ids";
import { attemptDir, attemptLogFile } from "@odu/run-history/paths";
import { formatLogKey } from "@odu/service-client/logKey";
import type { ServiceRefused } from "@odu/service-client/surface";
import {
  appendAttemptLog,
  sealAttempt,
  startAttempt,
  writeAttemptLog,
  writeVerdict,
} from "@odu/run-history/store";
import type { RunHandle } from "@odu/run-history/store";
import type { OwnershipToken } from "@odu/run-history/owner";
import {
  makeWorld,
  registerFixtureRun,
  type World,
  writeRoster,
} from "./fixture.testlib";
import { readLog, readTail } from "./logs";

let world: World | null = null;
const open = (): World => {
  world = makeWorld();
  return world;
};
afterEach(() => {
  world?.dispose();
  world = null;
});

const SHA = "b".repeat(40);
const NODE = "unit@x86_64-linux";
const PLACEMENT = { platform: "x86_64-linux", host: "builder-1" };

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.result(effect));

interface Fixture {
  handle: RunHandle;
  token: OwnershipToken;
  runId: string;
  key: string;
  catalog: { root: string };
}

/** A run with one node that has STARTED and is still writing — the state a
 *  follower waits on, and the only state in which `open` can be true. */
function writing(w: World, text = ""): Fixture {
  const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
  writeRoster(fixture.handle, fixture.token, [NODE]);
  startAttempt(fixture.handle, fixture.token, {
    node: NODE,
    attempt: 1,
    placement: PLACEMENT,
    startedAt: Date.now(),
  });
  writeAttemptLog(fixture.handle, NODE, 1, text);
  return {
    ...fixture,
    key: formatLogKey({ runId: fixture.runId, node: NODE, attempt: 1 }),
    catalog: { root: w.catalogRoot },
  };
}

/** Seal the attempt the way a lane does when it finishes — or the way the
 *  reaper does for one that did not. */
function seal(fixture: Fixture, logComplete: boolean): void {
  sealAttempt(fixture.handle, fixture.token, NODE, 1, {
    endedAt: Date.now(),
    status: logComplete ? "failed" : "errored",
    exitCode: logComplete ? 1 : null,
    signal: logComplete ? null : "SIGKILL",
    logComplete,
    logTruncationReason: logComplete ? null : "the writer never came back",
  });
}

function finalize(fixture: Fixture): void {
  writeVerdict(fixture.handle, fixture.token, {
    runId: fixture.runId,
    outcome: "incomplete",
    startedAt: Date.now() - 100,
    finishedAt: Date.now(),
    failed: [],
    errored: [NODE],
    cancelled: [],
    unposted: [],
  });
}

describe("log.read as a follow", () => {
  it("answers a caller that is BEHIND at once, deadline or no deadline", async () => {
    // The rule that keeps a follow of a large finished log fast: `waitMs` is a
    // deadline for an EMPTY page, never a delay applied to a full one.
    const w = open();
    const fixture = writing(w, "0123456789abcdefghij");

    const started = Date.now();
    const page = await run(
      readLog({ key: fixture.key, offset: 0, limit: 10, waitMs: 5_000 }, {
        catalog: fixture.catalog,
        pollMs: 10,
      }),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(page._tag).toBe("Success");
    if (page._tag !== "Success") return;
    expect(page.success.text).toBe("0123456789");
    expect(page.success.eof).toBe(false);
    expect(page.success.nextOffset).toBe(10);
  });

  it("returns the bytes that arrive during the wait, from the held cursor", async () => {
    const w = open();
    const fixture = writing(w, "compiling…\n");

    const first = await run(
      readLog({ key: fixture.key }, { catalog: fixture.catalog, pollMs: 10 }),
    );
    expect(first._tag).toBe("Success");
    if (first._tag !== "Success") return;
    expect(first.success.eof).toBe(true);
    expect(first.success.open).toBe(true);

    const later = setTimeout(() => {
      appendAttemptLog(fixture.handle, NODE, 1, "boom\n");
    }, 50);
    const second = await run(
      readLog(
        { key: fixture.key, offset: first.success.nextOffset, waitMs: 5_000 },
        { catalog: fixture.catalog, pollMs: 10 },
      ),
    );
    clearTimeout(later);
    expect(second._tag).toBe("Success");
    if (second._tag !== "Success") return;
    // The page picks up exactly where the last one stopped — no gap, no
    // re-delivery — which is the whole of the cursor's contract.
    expect(second.success.offset).toBe(first.success.nextOffset);
    expect(second.success.text).toBe("boom\n");
    expect(second.success.open).toBe(true);
  });

  it("stops waiting the moment the producer says its last word", async () => {
    const w = open();
    const fixture = writing(w, "all done\n");
    const later = setTimeout(() => {
      seal(fixture, true);
    }, 50);

    const page = await run(
      readLog({ key: fixture.key, offset: 9, waitMs: 5_000 }, {
        catalog: fixture.catalog,
        pollMs: 10,
      }),
    );
    clearTimeout(later);
    expect(page._tag).toBe("Success");
    if (page._tag !== "Success") return;
    expect(page.success.open).toBe(false);
    expect(page.success.complete).toBe(true);
    expect(page.success.text).toBe("");
    expect(page.success.eof).toBe(true);
  });

  it("stops waiting on the log of a writer that DIED — not complete, not open", async () => {
    // The case an inferred `open` gets wrong, and the reason there are three
    // fields. Nobody will ever seal this log complete, so a follower keyed on
    // `complete` waits forever on bytes that cannot come.
    const w = open();
    const fixture = writing(w, "cut off mid-");
    seal(fixture, false);
    finalize(fixture);

    const started = Date.now();
    const page = await run(
      readLog({ key: fixture.key, offset: 12, waitMs: 30_000 }, {
        catalog: fixture.catalog,
        pollMs: 10,
      }),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(page._tag).toBe("Success");
    if (page._tag !== "Success") return;
    expect(page.success.open).toBe(false);
    expect(page.success.complete).toBe(false);
    expect(page.success.eof).toBe(true);
  });

  it("comes back at its deadline with the cursor unmoved and the log still open", async () => {
    const w = open();
    const fixture = writing(w, "still working\n");

    const started = Date.now();
    const page = await run(
      readLog({ key: fixture.key, offset: 14, waitMs: 60 }, {
        catalog: fixture.catalog,
        pollMs: 10,
      }),
    );
    // The deadline is a FACT: nothing new, and the follow may ask again.
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(page._tag).toBe("Success");
    if (page._tag !== "Success") return;
    expect(page.success.text).toBe("");
    expect(page.success.nextOffset).toBe(14);
    expect(page.success.open).toBe(true);
  });

  it("shows a cursor that a REWRITE left stranded, rather than a quiet nothing", async () => {
    // A lane re-syncing an attempt replaces its bytes in place, and the file
    // can end up SHORTER than the offset a follower is holding. The read
    // clamps, so the page comes back addressed at the new end — `offset` behind
    // where the caller asked, and `size` smaller than it. That mismatch is the
    // only signal the follower gets, and it must be visible.
    const w = open();
    const fixture = writing(w, "0123456789abcdefghij");
    const held = 20;
    writeAttemptLog(fixture.handle, NODE, 1, "resync\n");

    const page = await run(
      readLog({ key: fixture.key, offset: held, waitMs: 200 }, {
        catalog: fixture.catalog,
        pollMs: 10,
      }),
    );
    expect(page._tag).toBe("Success");
    if (page._tag !== "Success") return;
    expect(page.success.size).toBe(7);
    expect(page.success.size).toBeLessThan(held);
    expect(page.success.offset).toBe(7);
    expect(page.success.text).toBe("");
  });

  it("settles promptly when the caller walks away mid-wait", async () => {
    // An HTTP client that disconnected, an MCP call that was cancelled, a
    // browser tab that closed. Interruption ends the OBSERVATION; the run is
    // untouched, and no timer is left behind holding the process open.
    const w = open();
    const fixture = writing(w, "quiet\n");

    const started = Date.now();
    const fiber = Effect.runFork(
      readLog({ key: fixture.key, offset: 6, waitMs: 60_000 }, {
        catalog: fixture.catalog,
        pollMs: 10,
      }),
    );
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses a malformed key IMMEDIATELY, even with a deadline on the call", async () => {
    // A typo must not buy a minute of silence followed by the same refusal.
    const w = open();
    const started = Date.now();
    const answer = await run(
      readLog({ key: "not-a-key", waitMs: 30_000 }, { catalog: { root: w.catalogRoot } }),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(answer._tag).toBe("Failure");
    if (answer._tag !== "Failure") return;
    expect((answer.failure as ServiceRefused).code).toBe("bad_input");
  });
});

describe("open on the tail", () => {
  it("says a running node's tail is open and a killed one's is not", () => {
    const w = open();
    const live = writing(w, "working\n");
    expect(readTail(live.key, live.catalog)?.open).toBe(true);

    seal(live, false);
    finalize(live);
    const dead = readTail(live.key, live.catalog);
    expect(dead?.open).toBe(false);
    expect(dead?.complete).toBe(false);
  });
});

/**
 * THE SECOND STREAM — the same key, the other file.
 *
 * The push is a step of its own, and its output is its own log: a node that
 * passed its recipe and could not reach the bucket has two stories, and the
 * reason a reader can tell them apart is that the bytes were never mixed. The
 * address does not change — one `logKey` per attempt, still — so what these
 * tests pin is that `stream` picks the FILE and nothing else: the cursor, the
 * refusal and the follow all behave as they do on the recipe's log.
 */
describe("log.read on the push stream", () => {
  it("answers the push's bytes, and a bare key still answers the recipe's", async () => {
    const w = open();
    const fixture = writing(w, "cargo test … ok\n");
    writeAttemptLog(fixture.handle, NODE, 1, "pushing 3 paths\n", "push");

    const pushed = await run(
      readLog({ key: fixture.key, stream: "push" }, { catalog: fixture.catalog }),
    );
    expect(pushed._tag).toBe("Success");
    if (pushed._tag !== "Success") return;
    expect(pushed.success.text).toBe("pushing 3 paths\n");
    // THE KEY IS ECHOED, not re-spelled. A follower that switched streams
    // keeps the address it was given, so nothing downstream has to parse a
    // second grammar to know which run and node it is looking at.
    expect(pushed.success.key).toBe(fixture.key);

    const recipe = await run(
      readLog({ key: fixture.key }, { catalog: fixture.catalog }),
    );
    expect(recipe._tag).toBe("Success");
    if (recipe._tag !== "Success") return;
    expect(recipe.success.text).toBe("cargo test … ok\n");
    expect(recipe.success.key).toBe(fixture.key);
    // Not one byte of the other file, and the sizes are each their own: the
    // two logs are separate evidence, not one stream with a marker in it.
    // BYTES, not characters — `size` is the file's, and the ellipsis is three
    // of them.
    expect(recipe.success.size).toBe(Buffer.byteLength("cargo test … ok\n"));
  });

  it("follows the push log's own growth, from the cursor it handed back", async () => {
    const w = open();
    const fixture = writing(w, "cargo test … ok\n");
    writeAttemptLog(fixture.handle, NODE, 1, "querying what is missing\n", "push");

    const first = await run(
      readLog({ key: fixture.key, stream: "push" }, {
        catalog: fixture.catalog,
        pollMs: 10,
      }),
    );
    expect(first._tag).toBe("Success");
    if (first._tag !== "Success") return;
    expect(first.success.eof).toBe(true);
    expect(first.success.open).toBe(true);

    // Only the PUSH log grows. The recipe's is written too, and a follow that
    // watched the wrong file would wake on those bytes and answer an empty
    // page — which is the bug this test exists for.
    const noise = setTimeout(() => {
      appendAttemptLog(fixture.handle, NODE, 1, "and more test output\n");
    }, 20);
    const later = setTimeout(() => {
      appendAttemptLog(fixture.handle, NODE, 1, "4 paths, 1.2 MiB\n", "push");
    }, 50);
    const second = await run(
      readLog(
        {
          key: fixture.key,
          offset: first.success.nextOffset,
          waitMs: 5_000,
          stream: "push",
        },
        { catalog: fixture.catalog, pollMs: 10 },
      ),
    );
    clearTimeout(noise);
    clearTimeout(later);
    expect(second._tag).toBe("Success");
    if (second._tag !== "Success") return;
    expect(second.success.offset).toBe(first.success.nextOffset);
    expect(second.success.text).toBe("4 paths, 1.2 MiB\n");
  });

  it("refuses an attempt that kept no push log, the way it refuses any absent evidence", async () => {
    // AN ATTEMPT RECORDED BEFORE THE PUSH WAS A STEP. Today's `startAttempt`
    // truncates both files, so a live attempt always HAS a push log, empty
    // until something writes to it; the only way to be without one is to be
    // older than the change, which is what unlinking reproduces. The answer
    // is the refusal any absent evidence earns — "no recorded output at this
    // address" is the truth about it, and an empty success would read as "it
    // pushed, and had nothing to say".
    const w = open();
    const fixture = writing(w, "cargo test … ok\n");
    rmSync(
      join(
        attemptDir(fixture.handle.dir, encodeNodeKey(NODE), 1),
        attemptLogFile("push"),
      ),
    );

    const answer = await run(
      readLog({ key: fixture.key, stream: "push" }, { catalog: fixture.catalog }),
    );
    expect(answer._tag).toBe("Failure");
    if (answer._tag !== "Failure") return;
    expect((answer.failure as ServiceRefused).code).toBe("unknown_run");
  });
});
