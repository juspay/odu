/**
 * `run.wait`, `log.read` and `run.cancel` — the answers, and what stays a
 * refusal.
 *
 * The line these tests draw over and over: a red CI answer is a SUCCESS. It
 * travels on the output channel, it exits 0 through the CLI, it is a normal
 * tool result to an agent. Only a request odu DECLINES is an error. Confusing
 * the two is how "your tests failed" becomes "the tool is broken".
 */

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
import { readLog, readTail } from "./logs";
import { readReceipt, requestStore } from "./requests";
import { waitForRun } from "./wait";

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
    // The log is ADDRESSED, so an agent echoes rather than reassembles.
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
    // The case that matters most and is hardest to notice: a finalized retry
    // mints a NEW run, so an agent that kept its cursor is holding the parent's.
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
    // The whole point of a bounded wait: a red unit lane beside a lane with
    // ninety seconds to go is already actionable.
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
    // `e2e` has started and has NOT finished — the run is not settled.
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
    // `eof` says this READ reached the end; `complete` says the file got its
    // producer's last word. The difference is "the recipe was quiet" versus
    // "the evidence is gone".
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
    expect(readTail(key, { root: w.catalogRoot })?.text).toBe("hello\n");
    expect(readTail("nonsense", { root: w.catalogRoot })).toBeNull();
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
    // A cheerful ok here would leave a caller believing it had stopped work
    // that is still running.
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
    // `.ci/odu.sock` is scoped to a CHECKOUT and a crashed coordinator keeps its
    // recorded endpoint through the ownership grace — so the address alone can
    // reach a DIFFERENT, live run. The adapter compares `<sha>#<seq>` before it
    // mutates anything, and it can only do that if the service sends it.
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
    // The reply went missing and the socket stayed up, so whether the run was
    // cancelled is not known. Reporting success would write a completed receipt
    // for a mutation nobody saw happen; reporting failure would tell a caller
    // nothing happened when it may have. Neither — and the claim stays in
    // flight so the same request id may ask again, which is safe because
    // cancelling twice cancels once.
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

    // And the repeat DOES ask again rather than replaying a non-answer.
    await run(
      cancelRun({ runId: fixture.runId, scope: { kind: "run" }, requestId: "c-6" }, deps),
    );
    expect(ports.cancels).toHaveLength(2);
  });
});
