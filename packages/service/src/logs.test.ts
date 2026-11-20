import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Fiber } from "effect";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { attemptDir, attemptLogFile } from "@odu/run-history/paths";
import { formatLogKey } from "@odu/service-client/logKey";
import type { ServiceRefused } from "@odu/service-client/surface";
import {
  type AttemptLogSink,
  sealAttempt,
  startAttempt,
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
import { readLog, readRecipeTail } from "./logs";

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
  sink: AttemptLogSink | null;
  catalog: { root: string };
}

function writing(w: World, text = ""): Fixture {
  const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
  writeRoster(fixture.handle, fixture.token, [NODE]);
  const sink = startAttempt(fixture.handle, fixture.token, {
    node: NODE,
    attempt: 1,
    placement: PLACEMENT,
    startedAt: Date.now(),
  });
  sink?.replace(text);
  return {
    ...fixture,
    key: formatLogKey({ runId: fixture.runId, node: NODE, attempt: 1 }),
    sink,
    catalog: { root: w.catalogRoot },
  };
}

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
      fixture.sink?.append("boom\n");
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
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(page._tag).toBe("Success");
    if (page._tag !== "Success") return;
    expect(page.success.text).toBe("");
    expect(page.success.nextOffset).toBe(14);
    expect(page.success.open).toBe(true);
  });

  it("shows a cursor that a REWRITE left stranded, rather than a quiet nothing", async () => {
    const w = open();
    const fixture = writing(w, "0123456789abcdefghij");
    const held = 20;
    fixture.sink?.replace("resync\n");

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
    expect(readRecipeTail(live.key, live.catalog)?.open).toBe(true);

    seal(live, false);
    finalize(live);
    const dead = readRecipeTail(live.key, live.catalog);
    expect(dead?.open).toBe(false);
    expect(dead?.complete).toBe(false);
  });
});

describe("log.read on the push stream", () => {
  it("answers the push's bytes, and a bare key still answers the recipe's", async () => {
    const w = open();
    const fixture = writing(w, "cargo test … ok\n");
    fixture.sink?.replace("pushing 3 paths\n", "push");

    const pushed = await run(
      readLog({ key: fixture.key, stream: "push" }, { catalog: fixture.catalog }),
    );
    expect(pushed._tag).toBe("Success");
    if (pushed._tag !== "Success") return;
    expect(pushed.success.text).toBe("pushing 3 paths\n");
    expect(pushed.success.key).toBe(fixture.key);

    const recipe = await run(
      readLog({ key: fixture.key }, { catalog: fixture.catalog }),
    );
    expect(recipe._tag).toBe("Success");
    if (recipe._tag !== "Success") return;
    expect(recipe.success.text).toBe("cargo test … ok\n");
    expect(recipe.success.key).toBe(fixture.key);
    expect(recipe.success.size).toBe(Buffer.byteLength("cargo test … ok\n"));
  });

  it("follows the push log's own growth, from the cursor it handed back", async () => {
    const w = open();
    const fixture = writing(w, "cargo test … ok\n");
    fixture.sink?.replace("querying what is missing\n", "push");

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

    const noise = setTimeout(() => {
      fixture.sink?.append("and more test output\n");
    }, 20);
    const later = setTimeout(() => {
      fixture.sink?.append("4 paths, 1.2 MiB\n", "push");
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
    const w = open();
    const fixture = writing(w, "cargo test … ok\n");
    rmSync(
      join(
        attemptDir(fixture.handle.dir, NODE, 1),
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
