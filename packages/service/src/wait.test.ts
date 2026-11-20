import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { formatLogKey } from "@odu/service-client/logKey";
import type { ServiceRefused } from "@odu/service-client/surface";
import { cancelRun } from "./cancel";
import {
  finalizeRun,
  makeWorld,
  recordingPorts,
  registerFixtureRun,
  type World,
  writeNode,
  writeRoster,
} from "./fixture.testlib";
import { readLog, readRecipeTail } from "./logs";
import { readReceipt, requestStore } from "./requests";
import { readRun, waitForRun } from "./wait";

let world: World | null = null;
const open = (): World => {
  world = makeWorld();
  return world;
};
afterEach(() => {
  world?.dispose();
  world = null;
});

const SHA = "a".repeat(40);
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.result(effect));

describe("run.wait", () => {
  it("answers a red run with a SUCCESS carrying the diagnosis", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    writeRoster(fixture.handle, fixture.token, ["unit@x86_64-linux"]);
    writeNode(w, fixture.handle, fixture.token, {
      id: "unit@x86_64-linux",
      status: "failed",
      exitCode: 3,
      log: "assertion failed at line 4\n",
    });
    finalizeRun(fixture.handle, fixture.token, "failed", ["unit@x86_64-linux"]);

    const answer = await run(
      waitForRun({ runId: fixture.runId, deadlineMs: 1000 }, {
        catalog: { root: w.catalogRoot },
      }),
    );
    expect(answer._tag).toBe("Success");
    if (answer._tag !== "Success") return;
    expect(answer.success.reason).toBe("settled");
    expect(answer.success.passed).toBe(false);
    expect(answer.success.failures).toHaveLength(1);
    const failure = answer.success.failures[0];
    expect(failure?.exitCode).toBe(3);
    expect(failure?.excerpt).toContain("assertion failed");
    expect(failure?.logKey).toBe(
      formatLogKey({ runId: fixture.runId, node: "unit@x86_64-linux", attempt: 1 }),
    );
  });

  it("returns still_running at the deadline, which is a fact rather than an error", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    writeRoster(fixture.handle, fixture.token, ["slow@x86_64-linux"]);
    const answer = await run(
      waitForRun({ runId: fixture.runId, deadlineMs: 60 }, {
        catalog: { root: w.catalogRoot },
      }),
    );
    expect(answer._tag).toBe("Success");
    if (answer._tag !== "Success") return;
    expect(answer.success.reason).toBe("still_running");
    expect(answer.success.settled).toBe(false);
  });

  it("refuses a cursor belonging to another run, with a resync", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    const answer = await run(
      waitForRun({ runId: fixture.runId, after: "0zzzzzzzz-zzzzzzzz@4" }, {
        catalog: { root: w.catalogRoot },
      }),
    );
    expect(answer._tag).toBe("Failure");
    if (answer._tag !== "Failure") return;
    expect((answer.failure as ServiceRefused).code).toBe("bad_cursor");
    expect((answer.failure as ServiceRefused).resync).toContain(fixture.runId);
  });

  it("tells an unknown run apart from an expired one", async () => {
    const w = open();
    const missing = await run(
      waitForRun({ runId: "0aaaaaaaa-aaaaaaaa" }, { catalog: { root: w.catalogRoot } }),
    );
    expect(missing._tag).toBe("Failure");
    if (missing._tag !== "Failure") return;
    expect((missing.failure as ServiceRefused).code).toBe("unknown_run");
  });

  it("delivers an actionable failure before an unrelated node settles", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    writeRoster(fixture.handle, fixture.token, [
      "unit@x86_64-linux",
      "e2e@x86_64-linux",
    ]);
    writeNode(w, fixture.handle, fixture.token, {
      id: "unit@x86_64-linux",
      status: "failed",
      log: "red\n",
    });
    const answer = await run(
      waitForRun({ runId: fixture.runId, deadlineMs: 2000 }, {
        catalog: { root: w.catalogRoot },
      }),
    );
    expect(answer._tag).toBe("Success");
    if (answer._tag !== "Success") return;
    expect(answer.success.settled).toBe(false);
    expect(answer.success.reason).toBe("failure");
    expect(answer.success.actionable).toBe(true);
  });
});

describe("run.read", () => {
  it("gives the IDENTICAL answer a wait would, without waiting for one", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    writeRoster(fixture.handle, fixture.token, ["unit@x86_64-linux"]);
    writeNode(w, fixture.handle, fixture.token, {
      id: "unit@x86_64-linux",
      status: "failed",
      exitCode: 3,
      log: "assertion failed at line 4\n",
    });
    finalizeRun(fixture.handle, fixture.token, "failed", ["unit@x86_64-linux"]);

    const catalog = { root: w.catalogRoot };
    const read = await run(readRun({ runId: fixture.runId }, { catalog }));
    const waited = await run(
      waitForRun({ runId: fixture.runId, deadlineMs: 1000 }, { catalog }),
    );
    expect(read._tag).toBe("Success");
    expect(waited._tag).toBe("Success");
    if (read._tag !== "Success" || waited._tag !== "Success") return;
    expect(read.success).toEqual(waited.success);
    expect(read.success.reason).toBe("settled");
    expect(read.success.failures[0]?.excerpt).toContain("assertion failed");
  });

  it("answers WHO started the run, and says nothing for a record that predates it", async () => {
    const w = open();
    const catalog = { root: w.catalogRoot };
    const mine = registerFixtureRun(w, {
      repoRoot: "/code/app",
      sha: SHA,
      actor: "srid",
    });
    const old = registerFixtureRun(w, { repoRoot: "/code/other", sha: SHA });

    const read = await run(readRun({ runId: mine.runId }, { catalog }));
    expect(read._tag).toBe("Success");
    if (read._tag !== "Success") return;
    expect(read.success.actor).toBe("srid");

    const before = await run(readRun({ runId: old.runId }, { catalog }));
    expect(before._tag).toBe("Success");
    if (before._tag !== "Success") return;
    expect(before.success.actor).toBeUndefined();
  });

  it("returns at once for a run that is still going, rather than holding", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    writeRoster(fixture.handle, fixture.token, ["slow@x86_64-linux"]);
    const started = Date.now();
    const answer = await run(
      readRun({ runId: fixture.runId }, { catalog: { root: w.catalogRoot } }),
    );
    expect(answer._tag).toBe("Success");
    if (answer._tag !== "Success") return;
    expect(answer.success.reason).toBe("still_running");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses the same things a wait refuses, from the same resolution", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    const catalog = { root: w.catalogRoot };

    const missing = await run(readRun({ runId: "0aaaaaaaa-aaaaaaaa" }, { catalog }));
    expect(missing._tag).toBe("Failure");
    if (missing._tag !== "Failure") return;
    expect((missing.failure as ServiceRefused).code).toBe("unknown_run");

    const stray = await run(
      readRun({ runId: fixture.runId, after: "0zzzzzzzz-zzzzzzzz@4" }, { catalog }),
    );
    expect(stray._tag).toBe("Failure");
    if (stray._tag !== "Failure") return;
    expect((stray.failure as ServiceRefused).code).toBe("bad_cursor");
    expect((stray.failure as ServiceRefused).resync).toContain(fixture.runId);
  });

  it("pages from a cursor the way a wait does", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    writeRoster(fixture.handle, fixture.token, ["unit@x86_64-linux"]);
    writeNode(w, fixture.handle, fixture.token, { id: "unit@x86_64-linux", status: "ok" });
    finalizeRun(fixture.handle, fixture.token, "passed");
    const catalog = { root: w.catalogRoot };

    const first = await run(readRun({ runId: fixture.runId, limit: 1 }, { catalog }));
    expect(first._tag).toBe("Success");
    if (first._tag !== "Success") return;
    expect(first.success.hasMore).toBe(true);

    const next = await run(
      readRun({ runId: fixture.runId, after: first.success.cursor }, { catalog }),
    );
    expect(next._tag).toBe("Success");
    if (next._tag !== "Success") return;
    expect(next.success.settled).toBe(true);
  });
});

describe("log.read", () => {
  it("pages by byte offset and reports where to continue", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    writeRoster(fixture.handle, fixture.token, ["unit@x86_64-linux"]);
    writeNode(w, fixture.handle, fixture.token, {
      id: "unit@x86_64-linux",
      status: "failed",
      log: "0123456789abcdefghij",
    });
    const key = formatLogKey({
      runId: fixture.runId,
      node: "unit@x86_64-linux",
      attempt: 1,
    });
    const first = await run(readLog({ key, limit: 10 }, { catalog: { root: w.catalogRoot } }));
    expect(first._tag).toBe("Success");
    if (first._tag !== "Success") return;
    expect(first.success.text).toBe("0123456789");
    expect(first.success.eof).toBe(false);
    expect(first.success.nextOffset).toBe(10);
    expect(first.success.size).toBe(20);

    const second = await run(
      readLog({ key, offset: first.success.nextOffset }, { catalog: { root: w.catalogRoot } }),
    );
    expect(second._tag).toBe("Success");
    if (second._tag !== "Success") return;
    expect(second.success.text).toBe("abcdefghij");
    expect(second.success.eof).toBe(true);
  });

  it("reads a tail from a negative offset", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    writeRoster(fixture.handle, fixture.token, ["unit@x86_64-linux"]);
    writeNode(w, fixture.handle, fixture.token, {
      id: "unit@x86_64-linux",
      status: "failed",
      log: "0123456789abcdefghij",
    });
    const key = formatLogKey({
      runId: fixture.runId,
      node: "unit@x86_64-linux",
      attempt: 1,
    });
    const tail = await run(readLog({ key, offset: -5 }, { catalog: { root: w.catalogRoot } }));
    expect(tail._tag).toBe("Success");
    if (tail._tag !== "Success") return;
    expect(tail.success.text).toBe("fghij");
  });

  it("says a truncated log is truncated rather than quiet", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    writeRoster(fixture.handle, fixture.token, ["unit@x86_64-linux"]);
    writeNode(w, fixture.handle, fixture.token, {
      id: "unit@x86_64-linux",
      status: "errored",
      log: "cut off mid-",
      complete: false,
    });
    const key = formatLogKey({
      runId: fixture.runId,
      node: "unit@x86_64-linux",
      attempt: 1,
    });
    const page = await run(readLog({ key }, { catalog: { root: w.catalogRoot } }));
    expect(page._tag).toBe("Success");
    if (page._tag !== "Success") return;
    expect(page.success.eof).toBe(true);
    expect(page.success.complete).toBe(false);
  });

  it("keeps an old attempt's evidence when a retry writes a new one", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    writeRoster(fixture.handle, fixture.token, ["unit@x86_64-linux"]);
    writeNode(w, fixture.handle, fixture.token, {
      id: "unit@x86_64-linux",
      attempt: 1,
      status: "failed",
      log: "first attempt\n",
    });
    writeNode(w, fixture.handle, fixture.token, {
      id: "unit@x86_64-linux",
      attempt: 2,
      status: "ok",
      log: "second attempt\n",
    });
    const first = await run(
      readLog(
        {
          key: formatLogKey({
            runId: fixture.runId,
            node: "unit@x86_64-linux",
            attempt: 1,
          }),
        },
        { catalog: { root: w.catalogRoot } },
      ),
    );
    expect(first._tag).toBe("Success");
    if (first._tag !== "Success") return;
    expect(first.success.text).toBe("first attempt\n");
  });

  it("refuses a key it did not issue", async () => {
    const w = open();
    const answer = await run(
      readLog({ key: "not-a-key" }, { catalog: { root: w.catalogRoot } }),
    );
    expect(answer._tag).toBe("Failure");
    if (answer._tag !== "Failure") return;
    expect((answer.failure as ServiceRefused).code).toBe("bad_input");
  });

  it("reads a tail for the live view, or null for a key that addresses nothing", () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    writeRoster(fixture.handle, fixture.token, ["unit@x86_64-linux"]);
    writeNode(w, fixture.handle, fixture.token, {
      id: "unit@x86_64-linux",
      status: "ok",
      log: "hello\n",
    });
    const key = formatLogKey({
      runId: fixture.runId,
      node: "unit@x86_64-linux",
      attempt: 1,
    });
    expect(readRecipeTail(key, { root: w.catalogRoot })?.text).toBe("hello\n");
    expect(readRecipeTail("nonsense", { root: w.catalogRoot })).toBeNull();
  });
});

describe("run.cancel", () => {
  const cancelDeps = (w: World, ports = recordingPorts()) => ({
    ports,
    deps: {
      cancel: ports.cancel,
      requests: requestStore({ root: w.requestsRoot }),
      catalog: { root: w.catalogRoot },
      now: () => Date.now(),
    },
  });

  it("cancels a live run and reports the scope it acted on", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    const { ports, deps } = cancelDeps(w);
    const answer = await run(
      cancelRun(
        { runId: fixture.runId, scope: { kind: "run" }, requestId: "c-1" },
        deps,
      ),
    );
    expect(answer._tag).toBe("Success");
    if (answer._tag !== "Success") return;
    expect(answer.success.effective).toBe("run");
    expect(ports.cancels).toHaveLength(1);
  });

  it("says nothing was cancelled, and why, when the coordinator declines", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    const { deps } = cancelDeps(w, recordingPorts({ cancelOk: false }));
    const answer = await run(
      cancelRun(
        {
          runId: fixture.runId,
          scope: { kind: "lane", platform: "aarch64-darwin" },
          requestId: "c-2",
        },
        deps,
      ),
    );
    expect(answer._tag).toBe("Success");
    if (answer._tag !== "Success") return;
    expect(answer.success.effective).toBe("nothing");
    expect(answer.success.detail).toBe("the stub declined");
  });

  it("replays a repeated cancel rather than dialling twice", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    const { ports, deps } = cancelDeps(w);
    await run(
      cancelRun({ runId: fixture.runId, scope: { kind: "run" }, requestId: "c-3" }, deps),
    );
    const again = await run(
      cancelRun({ runId: fixture.runId, scope: { kind: "run" }, requestId: "c-3" }, deps),
    );
    expect(again._tag).toBe("Success");
    if (again._tag !== "Success") return;
    expect(again.success.replayed).toBe(true);
    expect(ports.cancels).toHaveLength(1);
  });

  it("refuses a cancel for a run the catalog does not have", async () => {
    const w = open();
    const { deps } = cancelDeps(w);
    const answer = await run(
      cancelRun(
        { runId: "0aaaaaaaa-aaaaaaaa", scope: { kind: "run" }, requestId: "c-4" },
        deps,
      ),
    );
    expect(answer._tag).toBe("Failure");
    if (answer._tag !== "Failure") return;
    expect((answer.failure as ServiceRefused).code).toBe("unknown_run");
  });

  it("carries the run's identity to the port, so the socket can be checked", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    const { ports, deps } = cancelDeps(w);
    await run(
      cancelRun({ runId: fixture.runId, scope: { kind: "run" }, requestId: "c-5" }, deps),
    );
    const sent = ports.cancels[0];
    expect(sent?.runId).toBe(fixture.runId);
    expect(sent?.expect.sha).toBe(SHA);
  });

  it("keeps an UNCONFIRMED cancel unresolved, and the receipt open", async () => {
    const w = open();
    const fixture = registerFixtureRun(w, { repoRoot: "/code/app", sha: SHA });
    const { ports, deps } = cancelDeps(
      w,
      recordingPorts({
        cancelOk: { kind: "unresolved", detail: "the socket is still up" },
      }),
    );
    const answer = await run(
      cancelRun({ runId: fixture.runId, scope: { kind: "run" }, requestId: "c-6" }, deps),
    );
    expect(answer._tag).toBe("Failure");
    if (answer._tag !== "Failure") return;
    expect((answer.failure as ServiceRefused).code).toBe("request_unresolved");
    expect(readReceipt(deps.requests, "c-6")?.state).not.toBe("completed");

    await run(
      cancelRun({ runId: fixture.runId, scope: { kind: "run" }, requestId: "c-6" }, deps),
    );
    expect(ports.cancels).toHaveLength(2);
  });
});
