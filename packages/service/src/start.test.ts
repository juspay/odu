/**
 * `run.start` — acceptance, refusal, and ONE EXECUTION PER REQUEST ID.
 *
 * The last of those is what the whole receipt machinery exists for, so most of
 * this file is about a caller that asks twice: because its reply was lost,
 * because it retried on a timeout, because a harness restarted it. Every one of
 * those must end with one coordinator.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { handleFor, readManifest } from "@odu/run-history/store";
import { ServiceRefused, type StartInput } from "@odu/service-client/surface";
import {
  makeWorld,
  recordingPorts,
  registerFixtureRun,
  type World,
} from "./fixture.testlib";
import {
  claimReceipt,
  markDispatched,
  type ReceiptRecord,
  readReceipt,
  requestStore,
} from "./requests";
import { reconcileRequests } from "./reconcile";
import { startRun } from "./start";

let world: World | null = null;
const open = (): World => {
  world = makeWorld();
  return world;
};
afterEach(() => {
  world?.dispose();
  world = null;
});

const HEAD = "a".repeat(40);

const input = (over: Partial<StartInput> = {}): StartInput => ({
  checkout: "/code/app",
  expectedSha: HEAD,
  requestId: "req-1",
  ...over,
});

function deps(w: World, ports = recordingPorts()) {
  return {
    ports,
    run: (over: Partial<StartInput> = {}) =>
      Effect.runPromise(
        Effect.result(
          startRun(input(over), {
            launch: ports.launch,
            probeCheckout: ports.probeCheckout,
            requests: requestStore({ root: w.requestsRoot }),
            catalog: { root: w.catalogRoot },
            host: "test-host",
            now: () => Date.now(),
          }),
        ),
      ),
  };
}

describe("run.start", () => {
  it("accepts a run and hands back an addressed receipt", async () => {
    const w = open();
    const d = deps(w);
    const result = await d.run();
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(result.success.accepted).toBe(true);
    expect(result.success.replayed).toBe(false);
    expect(result.success.sha).toBe(HEAD);
    expect(d.ports.launches).toHaveLength(1);
    // The run id was MINTED BEFORE THE SPAWN — that is what makes a lost reply
    // a directory lookup rather than a guess.
    expect(d.ports.launches[0]?.runId).toBe(result.success.runId);
  });

  it("refuses a checkout that is not a repository", async () => {
    const w = open();
    const d = deps(
      w,
      recordingPorts({
        checkout: () => ({ isRepo: false, head: null, branch: null, liveRunId: null }),
      }),
    );
    const result = await d.run();
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect((result.failure as ServiceRefused).code).toBe("checkout_refused");
    expect(d.ports.launches).toHaveLength(0);
  });

  it("refuses a checkout that has moved past the expected commit", async () => {
    // Refused rather than substituted: the whole promise of `expectedSha` is
    // that a checkout which moved on gets an ANSWER, not a different run.
    const w = open();
    const d = deps(
      w,
      recordingPorts({
        checkout: () => ({
          isRepo: true,
          head: "b".repeat(40),
          branch: "main",
          liveRunId: null,
        }),
      }),
    );
    const result = await d.run();
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect((result.failure as ServiceRefused).code).toBe("checkout_refused");
    expect((result.failure as ServiceRefused).message).toContain("moved since you read it");
  });

  it("accepts a SHA PREFIX, so a caller may name it the length its tooling prints", async () => {
    const w = open();
    const d = deps(w);
    const result = await d.run({ expectedSha: HEAD.slice(0, 12) });
    expect(result._tag).toBe("Success");
  });

  it("answers a busy checkout with the run that is already there", async () => {
    // Not a refusal: nothing went wrong, and the run the caller is pointed at
    // is the one they almost certainly wanted.
    const w = open();
    const existing = registerFixtureRun(w, { repoRoot: "/code/app", sha: HEAD });
    const d = deps(
      w,
      recordingPorts({
        checkout: () => ({
          isRepo: true,
          head: HEAD,
          branch: "main",
          liveRunId: existing.runId,
        }),
      }),
    );
    const result = await d.run();
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(result.success.accepted).toBe(false);
    expect(result.success.runId).toBe(existing.runId);
    expect(result.success.existing?.runId).toBe(existing.runId);
    expect(d.ports.launches).toHaveLength(0);
  });

  it("takes the checkout when the caller says supersede", async () => {
    const w = open();
    const existing = registerFixtureRun(w, { repoRoot: "/code/app", sha: HEAD });
    const d = deps(
      w,
      recordingPorts({
        checkout: () => ({
          isRepo: true,
          head: HEAD,
          branch: "main",
          liveRunId: existing.runId,
        }),
      }),
    );
    const result = await d.run({ supersede: true });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(result.success.accepted).toBe(true);
    expect(d.ports.launches).toHaveLength(1);
  });

  it("performs ONE execution for a repeated request id", async () => {
    const w = open();
    const d = deps(w);
    const first = await d.run();
    const second = await d.run();
    expect(first._tag).toBe("Success");
    expect(second._tag).toBe("Success");
    if (first._tag !== "Success" || second._tag !== "Success") return;
    expect(second.success.runId).toBe(first.success.runId);
    expect(second.success.replayed).toBe(true);
    // THE property. Two asks, one coordinator.
    expect(d.ports.launches).toHaveLength(1);
  });

  it("refuses one id used for two different requests", async () => {
    const w = open();
    const d = deps(w);
    await d.run();
    const conflict = await d.run({ selectors: ["unit"] });
    expect(conflict._tag).toBe("Failure");
    if (conflict._tag !== "Failure") return;
    expect((conflict.failure as ServiceRefused).code).toBe("request_conflict");
    expect(d.ports.launches).toHaveLength(1);
  });

  it("refuses a request id outside the grammar", async () => {
    const w = open();
    const d = deps(w);
    const result = await d.run({ requestId: "../etc/passwd" });
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect((result.failure as ServiceRefused).code).toBe("bad_input");
  });

  it("records a failed launch, so a repeat replays the refusal", async () => {
    const w = open();
    const d = deps(
      w,
      recordingPorts({
        launch: (request) => ({
          ok: false,
          runId: request.runId,
          endpoint: "",
          error: "no venue could be claimed",
        }),
      }),
    );
    const first = await d.run();
    expect(first._tag).toBe("Failure");
    if (first._tag !== "Failure") return;
    expect((first.failure as ServiceRefused).code).toBe("launch_failed");

    const second = await d.run();
    expect(second._tag).toBe("Failure");
    // The second ask does NOT start a second coordinator against a world that
    // has since changed underneath it.
    expect(d.ports.launches).toHaveLength(1);
  });

  it("marks the dispatch BEFORE the launcher is entered", async () => {
    // From that marker on, "my reply went missing" and "nothing happened" stop
    // being the same thing.
    const w = open();
    const store = requestStore({ root: w.requestsRoot });
    // An ARRAY rather than a reassigned binding: TypeScript's control-flow
    // analysis cannot see that the launcher's closure ran, so a `let` assigned
    // only in there narrows to `never` at the assertion below.
    const seen: (ReceiptRecord | null)[] = [];
    const ports = recordingPorts({
      launch: (request) => {
        seen.push(readReceipt(store, "req-1"));
        return { ok: true, runId: request.runId, endpoint: "/tmp/x.sock" };
      },
    });
    await Effect.runPromise(
      Effect.result(
        startRun(input(), {
          launch: ports.launch,
          probeCheckout: ports.probeCheckout,
          requests: store,
          catalog: { root: w.catalogRoot },
          host: "test-host",
          now: () => Date.now(),
        }),
      ),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBeNull();
    expect(seen[0]?.dispatchedAt).toBeDefined();
  });
});

describe("crash reconciliation", () => {
  it("completes a claim whose run reached the catalog", async () => {
    // The crash-after-dispatch case: the coordinator registered, the answer was
    // lost, and the receipt is settled from the run rather than by starting a
    // second one.
    const w = open();
    const store = requestStore({ root: w.requestsRoot });
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: HEAD });
    const claim = claimReceipt(store, {
      requestId: "orphan-1",
      kind: "start",
      digest: "d",
      plannedRunId: run.runId,
    });
    expect(claim?.kind).toBe("claimed");
    markDispatched(store, "orphan-1", ["ci"]);

    const settled = reconcileRequests({
      requests: store,
      catalog: { root: w.catalogRoot },
      now: Date.now(),
      host: "test-host",
    });
    expect(settled).toBe(1);
    const receipt = readReceipt(store, "orphan-1");
    expect(receipt?.state).toBe("completed");
    expect((receipt?.result as { runId: string }).runId).toBe(run.runId);
  });

  it("leaves a claim whose run never appeared in flight", async () => {
    // An absent run means either "the launch never happened" or "the
    // coordinator is seconds from registering". Startup is exactly when those
    // two are least distinguishable, so neither is decided here.
    const w = open();
    const store = requestStore({ root: w.requestsRoot });
    claimReceipt(store, {
      requestId: "orphan-2",
      kind: "start",
      digest: "d",
      plannedRunId: "0zzzzzzzz-zzzzzzzz",
    });
    markDispatched(store, "orphan-2", ["ci"]);
    const settled = reconcileRequests({
      requests: store,
      catalog: { root: w.catalogRoot },
      now: Date.now(),
      host: "test-host",
    });
    expect(settled).toBe(0);
    expect(readReceipt(store, "orphan-2")?.state).toBe("accepted");
  });

  it("replays the reconciled answer instead of starting a second run", async () => {
    const w = open();
    const store = requestStore({ root: w.requestsRoot });
    const run = registerFixtureRun(w, { repoRoot: "/code/app", sha: HEAD });
    // A claim written by a process that is gone, whose run DID land.
    claimReceipt(store, {
      requestId: "req-1",
      kind: "start",
      digest: startDigest(),
      plannedRunId: run.runId,
      claimant: { pid: 1, host: "another-host" },
    });
    markDispatched(store, "req-1", ["ci"]);

    const d = deps(w);
    const result = await Effect.runPromise(
      Effect.result(
        startRun(input(), {
          launch: d.ports.launch,
          probeCheckout: d.ports.probeCheckout,
          requests: store,
          catalog: { root: w.catalogRoot },
          host: "test-host",
          now: () => Date.now(),
        }),
      ),
    );
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(result.success.runId).toBe(run.runId);
    expect(result.success.replayed).toBe(true);
    expect(d.ports.launches).toHaveLength(0);
    expect(readManifest(handleFor(run.runId, { root: w.catalogRoot }))).not.toBeNull();
  });
});

/** The digest `start.ts` computes for the default fixture input. Spelled by
 *  running the real thing once rather than transcribed: a hand-copied digest
 *  would silently stop matching the moment a field joined the request. */
function startDigest(): string {
  const { digestOf } = require("./requests") as typeof import("./requests");
  return digestOf([
    "/code/app",
    HEAD,
    "",
    "",
    "",
    false,
    "",
    false,
    false,
    false,
  ]);
}
