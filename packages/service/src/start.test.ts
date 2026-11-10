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
  type RecordingPorts,
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
import type { CheckoutFacts } from "./ports";
import { reconcileRequests } from "./reconcile";
import { LOCAL_OWNER } from "@odu/cordis/principal";
import { digestOfRequest, startRun } from "./start";

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
            moveCheckout: ports.moveCheckout,
            cancel: ports.cancel,
            push: ports.push,
            requests: requestStore({ root: w.requestsRoot }),
            catalog: { root: w.catalogRoot },
            host: "test-host",
            now: () => Date.now(),
          },
          LOCAL_OWNER),
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

  it("refuses one id used for two different INVENTORIES", async () => {
    // A start carries the caller's `$ODU_HOSTS` and hands it to the
    // coordinator, so it decides which machines the run's pins are names of —
    // and it was missing from the digest entirely. Two starts against two
    // fleets under one id replayed as one, and the caller was handed the other
    // fleet's run while believing its own had been accepted.
    const w = open();
    const d = deps(w);
    await d.run({ hostsFile: "/fleets/a.json" });
    const conflict = await d.run({ hostsFile: "/fleets/b.json" });
    expect(conflict._tag).toBe("Failure");
    if (conflict._tag !== "Failure") return;
    expect((conflict.failure as ServiceRefused).code).toBe("request_conflict");
    expect(d.ports.launches).toHaveLength(1);
    expect(d.ports.launches[0]?.caller.hostsFile).toBe("/fleets/a.json");
  });

  it("refuses an omitted inventory repeated as an explicit empty one", async () => {
    // The reading that has no other spelling: ABSENT means "use the daemon's
    // `$ODU_HOSTS`" and `""` means "the caller's shell had none". The launch
    // request keeps them apart (`null` against `""`), so the digest must too.
    const w = open();
    const d = deps(w);
    await d.run();
    const conflict = await d.run({ hostsFile: "" });
    expect(conflict._tag).toBe("Failure");
    if (conflict._tag !== "Failure") return;
    expect((conflict.failure as ServiceRefused).code).toBe("request_conflict");
    expect(d.ports.launches).toHaveLength(1);
    expect(d.ports.launches[0]?.caller.hostsFile).toBeNull();
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
          moveCheckout: ports.moveCheckout,
          cancel: ports.cancel,
          push: ports.push,
          requests: store,
          catalog: { root: w.catalogRoot },
          host: "test-host",
          now: () => Date.now(),
        },
        LOCAL_OWNER),
      ),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBeNull();
    expect(seen[0]?.dispatchedAt).toBeDefined();
  });
});

/**
 * A START THAT NAMES A BRANCH MOVES THE SERVICE'S OWN CLONE.
 *
 * The case is a GitHub workflow calling `run.start` with the commit it has
 * just pushed, against a clone on the service's machine that has never heard
 * of it (PLAN 4.4). Every outcome below is stated without git, which is what
 * the `moveCheckout` port is for.
 */
describe("run.start, moving a checkout onto a branch", () => {
  /** What the clone is on before anything moves it. */
  const BEFORE = "b".repeat(40);

  /** A clone on {@link BEFORE} whose probe answers the NEW head once the
   *  mover has moved it — the two reads `start` really performs. */
  function clone(
    over: Parameters<typeof recordingPorts>[0] = {},
    liveRunId: string | null = null,
  ): RecordingPorts {
    let head = BEFORE;
    return recordingPorts({
      checkout: () => ({ isRepo: true, head, branch: "main", liveRunId }),
      move: (request) => {
        head = request.sha;
        return { kind: "moved", head };
      },
      ...over,
    });
  }

  it("fetches, moves the clone, and runs the commit it was handed", async () => {
    const w = open();
    const ports = clone();
    const d = deps(w, ports);
    const result = await d.run({ branch: "main" });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(result.success.accepted).toBe(true);
    expect(ports.moves).toEqual([
      { checkout: "/code/app", branch: "main", sha: HEAD },
    ]);
    // The run is about the commit the caller asked for, not the one the clone
    // was on when the call arrived.
    expect(ports.launches[0]?.expectedSha).toBe(HEAD);
    expect(ports.launches[0]?.checkoutMoved).toBe(
      `moved /code/app to main at ${HEAD.slice(0, 7)}`,
    );
  });

  it("moves nothing when the clone is already on that commit", async () => {
    const w = open();
    const ports = recordingPorts();
    const d = deps(w, ports);
    const result = await d.run({ branch: "main" });
    expect(result._tag).toBe("Success");
    expect(ports.moves).toEqual([]);
    expect(ports.launches[0]?.checkoutMoved).toBeNull();
  });

  it("refuses a dirty tree, and moves nothing", async () => {
    // odu does not discard work it did not make.
    const w = open();
    const ports = clone({
      move: () => ({ kind: "dirty", detail: " M packages/service/src/start.ts" }),
    });
    const d = deps(w, ports);
    const result = await d.run({ branch: "main" });
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    const refusal = result.failure as ServiceRefused;
    expect(refusal.code).toBe("checkout_refused");
    expect(refusal.message).toContain("uncommitted changes");
    expect(refusal.message).toContain("packages/service/src/start.ts");
    expect(ports.launches).toHaveLength(0);
  });

  it("reports the fetch's own failure", async () => {
    const w = open();
    const ports = clone({
      move: () => ({
        kind: "fetch_failed",
        detail: "fatal: couldn't find remote ref main",
      }),
    });
    const d = deps(w, ports);
    const result = await d.run({ branch: "main" });
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    const refusal = result.failure as ServiceRefused;
    expect(refusal.code).toBe("checkout_refused");
    expect(refusal.message).toContain("couldn't find remote ref main");
    expect(ports.launches).toHaveLength(0);
  });

  it("refuses a commit that is not on that branch, and says BOTH shas", async () => {
    // The two mistakes behind this are opposite — a commit from another
    // branch, and one that was force-pushed away — and only both shas
    // together tell them apart.
    const w = open();
    const tip = "c".repeat(40);
    const ports = clone({ move: () => ({ kind: "not_on_branch", tip }) });
    const d = deps(w, ports);
    const result = await d.run({ branch: "main" });
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    const refusal = result.failure as ServiceRefused;
    expect(refusal.message).toContain(HEAD);
    expect(refusal.message).toContain(tip.slice(0, 12));
    expect(refusal.message).toContain("origin/main");
    expect(ports.launches).toHaveLength(0);
  });

  it("answers a busy clone with the run already in it, and moves nothing", async () => {
    // The live-run rule keeps its meaning: a branch is not a licence to take
    // a checkout somebody else's run is reading.
    const w = open();
    const existing = registerFixtureRun(w, { repoRoot: "/code/app", sha: BEFORE });
    const ports = clone({}, existing.runId);
    const d = deps(w, ports);
    const result = await d.run({ branch: "main" });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(result.success.accepted).toBe(false);
    expect(result.success.runId).toBe(existing.runId);
    expect(ports.moves).toEqual([]);
    expect(ports.cancels).toHaveLength(0);
  });

  it("stops the live run, and CONFIRMS it stopped, before the tree moves", async () => {
    // The coordinator's own cancel-then-claim happens after the launch, by
    // which time the files would already have moved under a live process.
    const w = open();
    const existing = registerFixtureRun(w, { repoRoot: "/code/app", sha: BEFORE });
    const cancelsWhenMoved: number[] = [];
    let head = BEFORE;
    const ports: RecordingPorts = recordingPorts({
      checkout: () => ({ isRepo: true, head, branch: "main", liveRunId: existing.runId }),
      move: (request) => {
        cancelsWhenMoved.push(ports.cancels.length);
        head = request.sha;
        return { kind: "moved", head };
      },
    });
    const d = deps(w, ports);
    const result = await d.run({ branch: "main", supersede: true });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(result.success.accepted).toBe(true);
    expect(ports.cancels[0]?.runId).toBe(existing.runId);
    expect(ports.cancels[0]?.scope).toEqual({ kind: "run" });
    // THE ORDERING, as the only thing that can state it: the cancel had
    // already been answered when the mover was entered.
    expect(cancelsWhenMoved).toEqual([1]);
  });

  it("moves nothing when the incumbent cannot be confirmed stopped", async () => {
    const w = open();
    const existing = registerFixtureRun(w, { repoRoot: "/code/app", sha: BEFORE });
    const ports = clone({ cancelOk: false }, existing.runId);
    const d = deps(w, ports);
    const result = await d.run({ branch: "main", supersede: true });
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect((result.failure as ServiceRefused).message).toContain(
      "could not be confirmed stopped",
    );
    expect(ports.moves).toEqual([]);
    expect(ports.launches).toHaveLength(0);
  });

  it("refuses, and does not move, when no branch was named", async () => {
    // Today's rule, byte for byte, which is every run from the checkout its
    // caller is standing in.
    const w = open();
    const ports = clone();
    const d = deps(w, ports);
    const result = await d.run();
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect((result.failure as ServiceRefused).message).toContain(
      "moved since you read it",
    );
    expect(ports.moves).toEqual([]);
  });

  it("is a DIFFERENT request from the same start without a branch", async () => {
    // The branch licenses moving the checkout, so repeating one id with and
    // without it is a conflict to be told about rather than a replay.
    const w = open();
    const d = deps(w, clone());
    await d.run({ branch: "main" });
    const conflict = await d.run();
    expect(conflict._tag).toBe("Failure");
    if (conflict._tag !== "Failure") return;
    expect((conflict.failure as ServiceRefused).code).toBe("request_conflict");
  });

  it("refuses a branch git would read as an OPTION, before git is reached", async () => {
    // `--upload-pack=<cmd>` on a `git fetch` command line runs that command.
    // `execFile` takes the shell away and takes nothing away from git's own
    // option parsing, so the name is held to git's grammar here — and the
    // port, which is the only thing that spells it to git, is never entered.
    const w = open();
    const ports = clone();
    const d = deps(w, ports);
    const result = await d.run({ branch: "--upload-pack=touch /tmp/pwned" });
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    const refusal = result.failure as ServiceRefused;
    expect(refusal.code).toBe("bad_input");
    expect(refusal.message).toContain("leading dash");
    expect(ports.moves).toEqual([]);
    expect(ports.launches).toHaveLength(0);
  });

  it("refuses the rest of git's non-branch names too", async () => {
    const w = open();
    const ports = clone();
    const d = deps(w, ports);
    const names = ["", "a b", "feat/..x", "x@{0}", "main.lock", ".hidden", "a//b"];
    for (const [index, branch] of names.entries()) {
      // A fresh id per name: a receipt replays, and these are seven requests.
      const result = await d.run({ branch, requestId: `bad-name-${index}` });
      expect(result._tag, branch).toBe("Failure");
      if (result._tag !== "Failure") continue;
      expect((result.failure as ServiceRefused).code, branch).toBe("bad_input");
    }
    expect(ports.moves).toEqual([]);
  });

  it("takes the branch names git takes", async () => {
    const w = open();
    const ports = clone();
    const d = deps(w, ports);
    const result = await d.run({ branch: "release/1.2-rc_3" });
    expect(result._tag).toBe("Success");
    expect(ports.moves[0]?.branch).toBe("release/1.2-rc_3");
  });

  it("refuses an expectedSha that is not a commit", async () => {
    // It reaches `git merge-base` and `git checkout -B` on the move path, so
    // it is held to hex for the same reason the branch is held to a name.
    const w = open();
    const ports = clone();
    const d = deps(w, ports);
    const result = await d.run({ expectedSha: "--upload-pack=x", branch: "main" });
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect((result.failure as ServiceRefused).code).toBe("bad_input");
    expect(ports.moves).toEqual([]);
  });
});

/**
 * THE RECEIPT IS CONSULTED BEFORE THE WORLD.
 *
 * Everything about a checkout is mutable — HEAD moves, a run starts in it, a
 * run ends in it — and a receipt that could be invalidated by any of those is
 * not a receipt. These four are the cases where looking at the checkout first
 * gave a repeated request a DIFFERENT answer, which is the same thing as
 * performing it twice.
 */
describe("a repeat is answered from the receipt, not from the checkout", () => {
  /** A probe whose answers a test can move under the service's feet. */
  function movingCheckout(initial: {
    head: string;
    liveRunId: string | null;
  }): { facts: { head: string; liveRunId: string | null }; probe: () => CheckoutFacts } {
    const facts = { ...initial };
    return {
      facts,
      probe: () => ({
        isRepo: true,
        head: facts.head,
        branch: "main",
        liveRunId: facts.liveRunId,
      }),
    };
  }

  it("replays the accepted run after HEAD has moved on", async () => {
    const w = open();
    const world = movingCheckout({ head: HEAD, liveRunId: null });
    const d = deps(w, recordingPorts({ checkout: world.probe }));
    const first = await d.run();
    expect(first._tag).toBe("Success");
    if (first._tag !== "Success") return;

    // The developer pulls. The request has not changed, and neither has its
    // answer: repeating it must not become `checkout_refused`, which would
    // leave a caller unable to recover the identity of the run it started.
    world.facts.head = "b".repeat(40);
    const again = await d.run();
    expect(again._tag).toBe("Success");
    if (again._tag !== "Success") return;
    expect(again.success.runId).toBe(first.success.runId);
    expect(again.success.replayed).toBe(true);
    expect(d.ports.launches).toHaveLength(1);
  });

  it("replays the accepted run even while a DIFFERENT run holds the checkout", async () => {
    const w = open();
    const other = registerFixtureRun(w, { repoRoot: "/code/app", sha: HEAD });
    const world = movingCheckout({ head: HEAD, liveRunId: null });
    const d = deps(w, recordingPorts({ checkout: world.probe }));
    const first = await d.run();
    expect(first._tag).toBe("Success");
    if (first._tag !== "Success") return;

    // Something else takes the checkout. A repeat that consulted the checkout
    // first would hand back THAT run's id under this request id — a receipt
    // pointing at a run the request never started.
    world.facts.liveRunId = other.runId;
    const again = await d.run();
    expect(again._tag).toBe("Success");
    if (again._tag !== "Success") return;
    expect(again.success.runId).toBe(first.success.runId);
    expect(again.success.runId).not.toBe(other.runId);
  });

  it("still refuses a CHANGED request under a used id while the checkout is busy", async () => {
    const w = open();
    const other = registerFixtureRun(w, { repoRoot: "/code/app", sha: HEAD });
    const world = movingCheckout({ head: HEAD, liveRunId: null });
    const d = deps(w, recordingPorts({ checkout: world.probe }));
    await d.run();
    world.facts.liveRunId = other.runId;
    // A busy checkout used to be answered before the id was claimed, so a
    // caller could reuse one id for a different request and never be told.
    const conflict = await d.run({ selectors: ["unit"] });
    expect(conflict._tag).toBe("Failure");
    if (conflict._tag !== "Failure") return;
    expect((conflict.failure as ServiceRefused).code).toBe("request_conflict");
  });

  it("records the busy-checkout answer, so a repeat replays it after the run ends", async () => {
    const w = open();
    const existing = registerFixtureRun(w, { repoRoot: "/code/app", sha: HEAD });
    const world = movingCheckout({ head: HEAD, liveRunId: existing.runId });
    const d = deps(w, recordingPorts({ checkout: world.probe }));
    const first = await d.run();
    expect(first._tag).toBe("Success");
    if (first._tag !== "Success") return;
    expect(first.success.accepted).toBe(false);

    // That run finishes and the checkout is free. One request id, one answer:
    // the repeat replays rather than quietly starting the run it declined to.
    world.facts.liveRunId = null;
    const again = await d.run();
    expect(again._tag).toBe("Success");
    if (again._tag !== "Success") return;
    expect(again.success.accepted).toBe(false);
    expect(again.success.runId).toBe(existing.runId);
    expect(d.ports.launches).toHaveLength(0);
  });

  it("records a refused checkout, so a repeat replays the refusal", async () => {
    const w = open();
    const world = movingCheckout({ head: "b".repeat(40), liveRunId: null });
    const d = deps(w, recordingPorts({ checkout: world.probe }));
    const first = await d.run();
    expect(first._tag).toBe("Failure");
    if (first._tag !== "Failure") return;
    expect((first.failure as ServiceRefused).code).toBe("checkout_refused");

    world.facts.head = HEAD;
    const again = await d.run();
    expect(again._tag).toBe("Failure");
    if (again._tag !== "Failure") return;
    // The world moved into agreement, but the request was already answered.
    // A fresh id is how a caller says "ask again".
    expect((again.failure as ServiceRefused).code).toBe("checkout_refused");
    expect(d.ports.launches).toHaveLength(0);
  });

  it("carries supersede to the launcher, and into the request's identity", async () => {
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
    // Without this the flag stopped at the service: the coordinator was
    // launched normally and refused by the run already in that checkout, so
    // the browser's checkbox and the CLI's option did nothing at all.
    expect(d.ports.launches[0]?.supersede).toBe(true);

    // And it is part of what the request IS: the same id with the flag off is
    // a different request, not a repeat of this one.
    const other = await d.run({ supersede: false });
    expect(other._tag).toBe("Failure");
    if (other._tag !== "Failure") return;
    expect((other.failure as ServiceRefused).code).toBe("request_conflict");
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
    // The stored value is a TAGGED envelope — an answer or a refusal — because
    // both have to replay and only a tag tells a reader which it is holding.
    expect(
      (receipt?.result as { outcome: string; receipt: { runId: string } }).outcome,
    ).toBe("receipt");
    expect(
      (receipt?.result as { receipt: { runId: string } }).receipt.runId,
    ).toBe(run.runId);
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
          moveCheckout: d.ports.moveCheckout,
          cancel: d.ports.cancel,
          push: d.ports.push,
          requests: store,
          catalog: { root: w.catalogRoot },
          host: "test-host",
          now: () => Date.now(),
        },
        LOCAL_OWNER),
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

/** The digest `start.ts` computes for the default fixture input — from the real
 *  function, not transcribed. A hand-copied digest silently stops matching the
 *  moment a field joins the request, which is exactly what happened when
 *  `supersede` did. */
function startDigest(): string {
  const request = input();
  return digestOfRequest(request, {
    selectors: [...(request.selectors ?? [])],
    platforms: [...(request.platforms ?? [])],
    noDeps: request.noDeps ?? false,
  });
}
