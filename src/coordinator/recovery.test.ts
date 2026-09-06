/**
 * The retry policy — what "run that again" means, and which of the three
 * meanings a given run gets.
 *
 * Two properties carry this whole file, and both are the kind that a suite
 * written from the happy path would never notice were gone:
 *
 *   - **ATTEMPT, DON'T PREDICT.** Whether a retry lands on the live run or
 *     starts a fresh one is decided by the live coordinator's own answer, never
 *     by reading "is it settled?" and acting on the reading. So every way the
 *     live path can decline — no recorded endpoint, nothing serving it, a
 *     coordinator that will not take the mutation — must FALL THROUGH to a new
 *     run rather than fail the caller. Three shapes, three tests: a policy that
 *     handled two of them would be wrong only on the day a run finalized inside
 *     the window, which is the day it matters.
 *   - **A LOST REPLY IS RECONCILED, NEVER REPEATED.** A repeat of a request id
 *     replays the recorded answer; a repeat whose first attempt vanished
 *     mid-flight asks the catalog whether the PRE-MINTED run exists instead of
 *     spawning a second one to find out. The assertion that matters in both is
 *     the same one: the stub launcher was called exactly once.
 *
 * And two refusals, which are refusals precisely so they cannot become
 * substitutions: a dirty live-tree run has no recorded inputs to replay, and a
 * caller naming an attempt the run has moved past is reading stale state.
 *
 * Every test builds a REAL catalog run on a temp root and injects both edges —
 * the launcher and the dial — so nothing here spawns a process or opens a
 * socket, and the policy is exercised against the same store a coordinator
 * writes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Stream } from "effect";
import { pendingNode, type PipelineState } from "@odu/run-client/surface";
import { claimReceipt, digestOf } from "@odu/run-history/receipts";
import type { RunManifest } from "@odu/run-history/schema";
import {
  appendEvent,
  readJournal,
  registerRun,
  type RunHandle,
  startAttempt,
  writeVerdict,
} from "@odu/run-history/store";
import type { LaunchRequest, RunLauncher } from "./launcher";
import { retryRun, type RetryInput, type RetryOutcome } from "./recovery";

const T0 = 1_700_000_000_000;
const SHA = "26d2c2dabcdef0123456789012345678901234ab";
/** A REAL directory, because a relaunch refuses a checkout that is gone — "a
 *  replay has to run where the run ran", and a fixture pointing at an
 *  imaginary path would take every relaunch case down that refusal instead of
 *  the one it is about. The one case that IS about the missing checkout makes
 *  its own path and removes it. */
const CHECKOUT = mkdtempSync(join(tmpdir(), "odu-recovery-checkout-"));
const ENDPOINT = join(CHECKOUT, ".ci", "odu.sock");
const PARENT_RUN = "0000000a-0001";
const PLATFORM = "x86_64-linux";
const UNIT = `ci::unit@${PLATFORM}`;
const E2E = `ci::e2e@${PLATFORM}`;
const LINT = `ci::lint@${PLATFORM}`;
const PLACEMENT = { platform: PLATFORM, host: "builder-1" };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A catalog root of our own. Never the developer's real one. */
function tmpCatalog(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-recovery-"));
  dirs.push(dir);
  return dir;
}

type ManifestInput = Omit<RunManifest, "version" | "owner">;

function manifest(over: Partial<ManifestInput> = {}): ManifestInput {
  return {
    runId: PARENT_RUN,
    repo: "juspay/odu",
    sha: SHA,
    seq: 3,
    pipeline: "ci",
    repoRoot: CHECKOUT,
    createdAt: T0,
    scope: { selectors: ["unit", "e2e"], platforms: [PLATFORM], noDeps: true },
    snapshot: { mode: "strict", expectedSha: SHA, dirty: false, retryable: true },
    build: { oduVersion: "0.1.0", self: "/nix/store/x/bin/odu", runnerFlake: null },
    parentRunId: null,
    requestId: null,
    ...over,
  };
}

/** A run in the catalog with a journal and one node's attempt evidence — the
 *  state a retry actually reads. `endpoint` is what decides whether the live
 *  path is even reachable, so it is always spelled out at the call site. */
function aRun(
  root: string,
  endpoint: string | null,
  over: Partial<ManifestInput> = {},
): RunHandle {
  const result = registerRun(manifest(over), { root, endpoint, now: T0 });
  if (!result.ok) throw new Error(`registration refused: ${result.refusal.reason}`);
  const { handle, token } = result;
  appendEvent(handle, token, { kind: "roster", order: [UNIT, E2E, LINT] }, T0 + 1);
  // Two attempts on `unit`, one on nothing else: enough that a receipt reading
  // the recorded ordinal is distinguishable from one defaulting to 1.
  startAttempt(handle, token, {
    node: UNIT,
    attempt: 1,
    placement: PLACEMENT,
    startedAt: T0 + 2,
  });
  startAttempt(handle, token, {
    node: UNIT,
    attempt: 2,
    placement: PLACEMENT,
    startedAt: T0 + 3,
  });
  return handle;
}

/** A finished run: a verdict on disk, and no owner serving a socket. What a
 *  finalized retry is actually asked about. */
function aFinishedRun(root: string, over: Partial<ManifestInput> = {}): RunHandle {
  const result = registerRun(manifest(over), { root, endpoint: null, now: T0 });
  if (!result.ok) throw new Error(`registration refused: ${result.refusal.reason}`);
  const { handle, token } = result;
  appendEvent(handle, token, { kind: "roster", order: [UNIT, E2E, LINT] }, T0 + 1);
  startAttempt(handle, token, {
    node: UNIT,
    attempt: 1,
    placement: PLACEMENT,
    startedAt: T0 + 2,
  });
  appendEvent(handle, token, { kind: "finalized", outcome: "failed" }, T0 + 3);
  writeVerdict(handle, token, {
    runId: handle.runId,
    outcome: "failed",
    startedAt: T0,
    finishedAt: T0 + 3,
    failed: [UNIT],
    errored: [],
    cancelled: [],
    unposted: [],
  });
  return handle;
}

/** The live run a dial would answer with: `e2e` needs `unit`, `lint` is
 *  independent. Enough of a DAG that "dependency-minimal roots" and "transitive
 *  dependants" are different sets. */
function liveState(): PipelineState {
  const seed = (id: string, needs: string[]) =>
    pendingNode({ id, name: id, command: "just x", needs });
  return {
    name: "ci::default",
    sha7: SHA.slice(0, 7),
    dirty: false,
    order: [UNIT, E2E, LINT],
    nodes: {
      [UNIT]: { ...seed(UNIT, []), status: "failed", exitCode: 1 },
      [E2E]: seed(E2E, [UNIT]),
      [LINT]: { ...seed(LINT, []), status: "failed", exitCode: 1 },
    },
  };
}

type Dial = NonNullable<RetryInput["dial"]>;

interface DialStub {
  dial: Dial;
  /** Every node the policy asked the live coordinator to re-run, in order. */
  asked: string[];
  closes: number;
}

/** A live coordinator that serves `state` and answers `node.rerun` with
 *  `accepts(id)`. The shapes are exactly the two members the policy consumes —
 *  a `Stream` for the cell and an `Effect` for the mutation — because that is
 *  what `firstFrame` and `runUnary` know how to run. */
function stubDial(
  state: PipelineState,
  accepts: (id: string) => boolean = () => true,
): DialStub {
  const stub: DialStub = { asked: [], closes: 0, dial: async () => null };
  stub.dial = (async () => ({
    client: {
      surface: {
        nodes: { get: () => Stream.make(state) },
        node: {
          rerun: ({ id }: { id: string }) => {
            stub.asked.push(id);
            return Effect.succeed({ ok: accepts(id) });
          },
        },
      },
    },
    close: async () => {
      stub.closes += 1;
    },
  })) as unknown as Dial;
  return stub;
}

interface LauncherStub {
  launcher: RunLauncher;
  /** Every launch request, so a test can assert nothing was started as easily
   *  as it asserts what was. */
  calls: LaunchRequest[];
}

const LIFETIME = "the coordinator is a detached process group — a shell";

function stubLauncher(
  opts: { ok?: boolean; onLaunch?: (request: LaunchRequest) => void } = {},
): LauncherStub {
  const calls: LaunchRequest[] = [];
  return {
    calls,
    launcher: async (request) => {
      calls.push(request);
      opts.onLaunch?.(request);
      if (opts.ok === false) {
        return {
          ok: false,
          runId: request.runId,
          endpoint: "",
          error: "the coordinator exited before serving a socket",
        };
      }
      return {
        ok: true,
        runId: request.runId,
        endpoint: `${request.checkout}/.ci/odu.sock`,
        lifetime: LIFETIME,
      };
    },
  };
}

/** Narrow an outcome to its success, failing loudly with the refusal's own
 *  words when it is not one. */
function accepted(outcome: RetryOutcome) {
  if (!outcome.ok) throw new Error(`refused: ${outcome.message}`);
  return outcome;
}

function refused(outcome: RetryOutcome) {
  if (outcome.ok) throw new Error("expected a refusal, got a receipt");
  return outcome;
}

describe("a retry on a run that is still live", () => {
  it("resets the node in place and starts nothing", async () => {
    const root = tmpCatalog();
    const handle = aRun(root, ENDPOINT);
    const dial = stubDial(liveState());
    const launcher = stubLauncher();

    const out = accepted(
      await retryRun({
        runId: PARENT_RUN,
        // The whole lane: three targets, of which only two are roots.
        selector: `@${PLATFORM}`,
        catalog: { root },
        launcher: launcher.launcher,
        dial: dial.dial,
        now: () => T0 + 10,
      }),
    );

    expect(out.replayed).toBe(false);
    expect(out.receipt.mode).toBe("live");
    // The run retried IS the run acted on; there is no second run to link to.
    expect(out.receipt.effective_run).toBe(PARENT_RUN);
    expect(out.receipt.parent_run).toBeNull();

    // DEPENDENCY-MINIMAL: `e2e` is inside `unit`'s closure, so it is reset by
    // that rerun rather than issued one of its own — and the caller is told so
    // by name, because reading "reran unit" and finding `e2e` pending is the
    // confusion this field exists to prevent.
    expect(out.receipt.roots).toEqual([UNIT, LINT]);
    expect(out.receipt.reset_dependants).toEqual([E2E]);
    expect(dial.asked).toEqual([UNIT, LINT]);

    // Read from the store, not invented: `unit` is on its second attempt and
    // `lint` has no evidence at all.
    expect(out.receipt.attempts).toEqual([
      { node: UNIT, attempt: 2 },
      { node: LINT, attempt: 1 },
    ]);
    expect(out.receipt.sha).toBe(SHA);
    // Where to resume reading — the journal's head, so a caller that follows it
    // sees the reset and nothing it has already been served.
    expect(readJournal(handle).highestSeq).toBe(2);
    expect(out.receipt.cursor).toBe(`${PARENT_RUN}@2`);

    // The point of the live path: no new run, no new coordinator, no new lease.
    expect(launcher.calls).toEqual([]);
    // And the dial is released rather than held open on a socket the caller is
    // about to stop caring about.
    expect(dial.closes).toBe(1);
  });

  it("names one root and its transitive dependants for a single-node selector", async () => {
    const root = tmpCatalog();
    aRun(root, ENDPOINT);
    const dial = stubDial(liveState());
    const launcher = stubLauncher();

    const out = accepted(
      await retryRun({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
        dial: dial.dial,
      }),
    );

    expect(out.receipt.roots).toEqual([UNIT]);
    expect(out.receipt.reset_dependants).toEqual([E2E]);
    expect(launcher.calls).toHaveLength(0);
  });
});

describe("the live path is attempted, never predicted", () => {
  /** The same request in three worlds that differ only in how the live path
   *  declines. All three must land on a new run. */
  async function retryAgainst(
    root: string,
    dial: Dial | undefined,
    launcher: LauncherStub,
  ): Promise<RetryOutcome> {
    return retryRun({
      runId: PARENT_RUN,
      selector: "unit",
      catalog: { root },
      launcher: launcher.launcher,
      ...(dial === undefined ? {} : { dial }),
      now: () => T0 + 10,
    });
  }

  it("relaunches when the live coordinator will not take the mutation", async () => {
    // `ok: false` means "I will not do that" — the node is unknown to me, its
    // lane is gone, I am shutting down. Every one of those is a reason to start
    // a fresh run, and none of them is a reason to fail the caller.
    const root = tmpCatalog();
    aRun(root, ENDPOINT);
    const launcher = stubLauncher();
    const dial = stubDial(liveState(), () => false);

    const out = accepted(await retryAgainst(root, dial.dial, launcher));
    expect(out.receipt.mode).toBe("relaunched");
    expect(dial.asked).toEqual([UNIT]);
    expect(launcher.calls).toHaveLength(1);
  });

  it("relaunches when nothing is serving the recorded endpoint", async () => {
    // The run finalized between the manifest being written and this dial. No
    // clock read that, and no clock had to.
    const root = tmpCatalog();
    aRun(root, ENDPOINT);
    const launcher = stubLauncher();

    const out = accepted(
      await retryAgainst(root, (async () => null) as Dial, launcher),
    );
    expect(out.receipt.mode).toBe("relaunched");
    expect(launcher.calls).toHaveLength(1);
  });

  it("relaunches when the run recorded no endpoint at all", async () => {
    const root = tmpCatalog();
    aFinishedRun(root);
    const launcher = stubLauncher();
    // A dial that would THROW if it were reached: a run with no endpoint must
    // not be dialled at all.
    const dial = (async () => {
      throw new Error("dialled a run that records no endpoint");
    }) as Dial;

    const out = accepted(await retryAgainst(root, dial, launcher));
    expect(out.receipt.mode).toBe("relaunched");
    expect(launcher.calls).toHaveLength(1);
  });

  it("reports a launcher that could not start the replay, with a way out", async () => {
    const root = tmpCatalog();
    aFinishedRun(root);
    const launcher = stubLauncher({ ok: false });

    const out = refused(await retryAgainst(root, undefined, launcher));
    expect(out.message).toContain("could not start the replay run");
    expect(out.message).toContain("the coordinator exited before serving a socket");
    expect(out.suggestion).toEqual(["odu", "run", "unit"]);
  });
});

describe("relaunching a finalized run", () => {
  it("starts a NEW run linked to its parent, pinned to the parent's commit", async () => {
    const root = tmpCatalog();
    aFinishedRun(root);
    const launcher = stubLauncher();

    const out = accepted(
      await retryRun({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
        now: () => T0 + 10,
      }),
    );

    expect(out.receipt.mode).toBe("relaunched");
    // A new identity, not the parent's: the parent is not rewritten and is not
    // marked green by anything its child does.
    expect(out.receipt.effective_run).not.toBe(PARENT_RUN);
    expect(out.receipt.parent_run).toBe(PARENT_RUN);
    expect(out.receipt.sha).toBe(SHA);
    expect(out.receipt.cursor).toBe(`${out.receipt.effective_run}@0`);
    expect(out.receipt.lifetime).toBe(LIFETIME);

    const request = launcher.calls[0];
    if (request === undefined) throw new Error("nothing was launched");
    expect(request.runId).toBe(out.receipt.effective_run);
    expect(request.parentRunId).toBe(PARENT_RUN);
    expect(request.checkout).toBe(CHECKOUT);
    // NEVER today's HEAD: the child's own strict gate refuses a checkout that
    // has moved on rather than quietly running something else.
    expect(request.expectedSha).toBe(SHA);
    // A replay does not post. A selection's statuses would overwrite the full
    // run's contexts with a partial verdict.
    expect(request.noPost).toBe(true);
    // The SELECTION, with its dependency closure. `noDeps` is deliberately not
    // carried from the parent: a replay of one node needs what that node needs.
    expect(request.scope.selectors).toEqual(["unit"]);
    expect(request.scope.noDeps).toBe(false);
    expect(request.scope.platforms).toEqual([PLATFORM]);
    // …and the receipt says what the new run covers, so no face can present its
    // verdict as the pipeline's.
    expect(out.receipt.scope.selectors).toEqual(["unit"]);
    expect(out.receipt.scope.noDeps).toBe(false);
  });

  it("carries the recorded root and the parent's strict mode through", async () => {
    const root = tmpCatalog();
    aFinishedRun(root, {
      scope: {
        selectors: ["e2e"],
        platforms: [PLATFORM],
        root: "ci::default",
        noDeps: false,
      },
      snapshot: { mode: "live", expectedSha: SHA, dirty: false, retryable: true },
    });
    const launcher = stubLauncher();

    accepted(
      await retryRun({
        runId: PARENT_RUN,
        selector: "e2e",
        catalog: { root },
        launcher: launcher.launcher,
      }),
    );

    const request = launcher.calls[0];
    if (request === undefined) throw new Error("nothing was launched");
    expect(request.scope.root).toBe("ci::default");
    // A run recorded as `live` replays as `live`, not as today's defaults.
    expect(request.noStrict).toBe(true);
    expect(request.noSnapshot).toBe(true);
  });
});

describe("a run whose inputs were never committed", () => {
  it("is refused rather than replaced by a run of today's tree", async () => {
    // The substitution the whole design forbids: a dirty working tree exists
    // nowhere but on that disk at that moment, so there is nothing to replay.
    const root = tmpCatalog();
    aFinishedRun(root, {
      snapshot: { mode: "live", expectedSha: SHA, dirty: true, retryable: false },
    });
    const launcher = stubLauncher();

    const out = refused(
      await retryRun({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
      }),
    );

    expect(out.message).toContain("cannot be replayed");
    expect(out.message).toContain("never committed");
    expect(out.message).toContain("dirty working tree");
    // A recovery the caller can RUN — argv, never a string to eval.
    expect(Array.isArray(out.suggestion)).toBe(true);
    expect(out.suggestion?.[0]).toBe("odu");
    expect(out.suggestion).toEqual(["odu", "run", "unit", "e2e"]);
    // And nothing was started in its place.
    expect(launcher.calls).toEqual([]);
  });

  it("gives the SAME refusal to a repeat of the same request id", async () => {
    // The trap idempotency sets for itself. A refused request has an outcome
    // just as much as an accepted one, and if only the successes are recorded
    // then the second identical ask — exactly the ask idempotency invites —
    // is told the first "was accepted and its outcome is not recorded". That
    // is false, and it is false about the one thing a caller is relying on.
    const root = tmpCatalog();
    aFinishedRun(root, {
      snapshot: { mode: "live", expectedSha: SHA, dirty: true, retryable: false },
    });
    const launcher = stubLauncher();
    const ask = (): Promise<RetryOutcome> =>
      retryRun({
        runId: PARENT_RUN,
        selector: "unit",
        requestId: "the-same-id",
        catalog: { root },
        launcher: launcher.launcher,
      });

    const first = refused(await ask());
    const second = refused(await ask());
    expect(second.message).toBe(first.message);
    expect(second.suggestion).toEqual(first.suggestion);
    expect(launcher.calls).toEqual([]);
  });

  it("refuses a replay whose checkout is gone, and names the path", async () => {
    // A replay has to run where the run ran, and the path is the whole of the
    // fix — "clone it back to here" is not something a caller can guess from
    // an error that omits it.
    const root = tmpCatalog();
    const vanished = mkdtempSync(join(tmpdir(), "odu-recovery-vanished-"));
    aFinishedRun(root, { repoRoot: vanished });
    rmSync(vanished, { recursive: true, force: true });
    const launcher = stubLauncher();

    const out = refused(
      await retryRun({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
      }),
    );
    expect(out.message).toContain(vanished);
    expect(out.message).toContain("is gone");
    // The evidence is still there, and the suggestion says how to read it.
    expect(out.suggestion?.slice(0, 2)).toEqual(["odu", "logs"]);
    expect(launcher.calls).toEqual([]);
  });
});

describe("expectAttempt", () => {
  it("refuses a caller acting on a reading the run has moved past", async () => {
    const root = tmpCatalog();
    aFinishedRun(root);
    const launcher = stubLauncher();

    const out = refused(
      await retryRun({
        runId: PARENT_RUN,
        selector: "unit",
        expectAttempt: { node: UNIT, attempt: 2 },
        catalog: { root },
        launcher: launcher.launcher,
      }),
    );

    expect(out.message).toContain("attempt 1, not 2");
    expect(out.message).toContain("moved on since you read it");
    expect(out.suggestion).toEqual(["odu", "history", "show", "--run", PARENT_RUN]);
    expect(launcher.calls).toEqual([]);
  });

  it("proceeds when the node is on exactly the attempt named", async () => {
    const root = tmpCatalog();
    aFinishedRun(root);
    const launcher = stubLauncher();

    const out = accepted(
      await retryRun({
        runId: PARENT_RUN,
        selector: "unit",
        expectAttempt: { node: UNIT, attempt: 1 },
        catalog: { root },
        launcher: launcher.launcher,
      }),
    );
    expect(out.receipt.mode).toBe("relaunched");
    expect(launcher.calls).toHaveLength(1);
  });
});

describe("a request id asked twice", () => {
  const REQUEST = "agent.retry.7";

  function sameRequest(root: string, launcher: LauncherStub): RetryInput {
    return {
      runId: PARENT_RUN,
      selector: "unit",
      requestId: REQUEST,
      catalog: { root },
      launcher: launcher.launcher,
      now: () => T0 + 10,
    };
  }

  it("performs the mutation once and replays the identical answer", async () => {
    const root = tmpCatalog();
    aFinishedRun(root);
    const launcher = stubLauncher();

    const first = accepted(await retryRun(sameRequest(root, launcher)));
    const second = accepted(await retryRun(sameRequest(root, launcher)));

    // THE assertion: one ask, one run. A second launch here is two runs
    // competing for the same venue lease because a reply went missing.
    expect(launcher.calls).toHaveLength(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    // Verbatim, so two asks cannot get two different descriptions of one action.
    expect(second.receipt).toEqual(first.receipt);
    expect(second.receipt.request_id).toBe(REQUEST);
  });

  it("refuses the same id carrying a different request", async () => {
    const root = tmpCatalog();
    aFinishedRun(root);
    const launcher = stubLauncher();

    accepted(await retryRun(sameRequest(root, launcher)));
    const out = refused(
      await retryRun({ ...sameRequest(root, launcher), selector: "e2e" }),
    );

    expect(out.message).toContain("already used for a different retry");
    expect(launcher.calls).toHaveLength(1);
  });
});

describe("a reply that was lost mid-flight", () => {
  const REQUEST = "agent.retry.lost";

  /** The digest `retryRun` computes for the request below — claimed by hand
   *  here, exactly as a first attempt would have claimed it before dying. */
  function claimByHand(handle: RunHandle, plannedRunId: string): void {
    const outcome = claimReceipt(handle, {
      requestId: REQUEST,
      kind: "retry",
      digest: digestOf([PARENT_RUN, "unit", "", 0]),
      plannedRunId,
      now: T0 + 5,
    });
    if (outcome?.kind !== "claimed") {
      throw new Error(`could not claim by hand: ${outcome?.kind ?? "null"}`);
    }
  }

  function repeat(root: string, launcher: LauncherStub): Promise<RetryOutcome> {
    return retryRun({
      runId: PARENT_RUN,
      selector: "unit",
      requestId: REQUEST,
      catalog: { root },
      launcher: launcher.launcher,
      now: () => T0 + 10,
    });
  }

  it("reconciles by identity when the pre-minted run is in the catalog", async () => {
    // The spawn happened; only the answer was lost. So the question is a
    // directory lookup — does that run exist? — and not a second spawn.
    const root = tmpCatalog();
    const handle = aFinishedRun(root);
    const planned = "0000000b-0002";
    claimByHand(handle, planned);
    registerRun(
      manifest({ runId: planned, parentRunId: PARENT_RUN, requestId: REQUEST }),
      { root, endpoint: null, now: T0 + 6 },
    );
    const launcher = stubLauncher();

    const out = accepted(await repeat(root, launcher));

    expect(out.replayed).toBe(true);
    expect(out.receipt.mode).toBe("relaunched");
    expect(out.receipt.effective_run).toBe(planned);
    expect(out.receipt.parent_run).toBe(PARENT_RUN);
    expect(out.receipt.sha).toBe(SHA);
    // The mutation is NOT repeated.
    expect(launcher.calls).toEqual([]);

    // And the receipt is now completed, so a third ask is a plain replay.
    const third = accepted(await repeat(root, launcher));
    expect(third.replayed).toBe(true);
    expect(third.receipt).toEqual(out.receipt);
    expect(launcher.calls).toEqual([]);
  });

  it("refuses rather than silently redoing the work when no run was started", async () => {
    // Nothing exists under the pre-minted id. That is not the same as "nothing
    // happened" — a LIVE retry leaves no run of its own — so the caller is told
    // exactly what is and is not known instead of being handed a guess.
    const root = tmpCatalog();
    const handle = aFinishedRun(root);
    claimByHand(handle, "0000000b-0002");
    const launcher = stubLauncher();

    const out = refused(await repeat(root, launcher));

    expect(out.message).toContain("its outcome is not recorded");
    expect(out.message).toContain("no run was started under it");
    expect(out.suggestion).toEqual(["odu", "history", "show", "--run", PARENT_RUN]);
    expect(launcher.calls).toEqual([]);
  });

  it("refuses a claim that names no run to reconcile against", async () => {
    // The empty planned id is how an UNREADABLE receipt reaches this code — a
    // torn write holds the id with nothing behind it. Reading that as unclaimed
    // would be the duplicate run the whole mechanism exists to prevent.
    const root = tmpCatalog();
    const handle = aFinishedRun(root);
    claimByHand(handle, "");
    const launcher = stubLauncher();

    const out = refused(await repeat(root, launcher));
    expect(out.message).toContain("no run was started under it");
    expect(launcher.calls).toEqual([]);
  });
});

describe("requests that never get as far as a decision", () => {
  it("refuses a run id the catalog does not have", async () => {
    const root = tmpCatalog();
    const launcher = stubLauncher();

    const out = refused(
      await retryRun({
        runId: "0000000z-9999",
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
      }),
    );
    expect(out.message).toContain("no run 0000000z-9999 in the catalog");
    expect(launcher.calls).toEqual([]);
  });

  it("refuses a request id it could not put on a disk, and names the rule", async () => {
    const root = tmpCatalog();
    aFinishedRun(root);
    const launcher = stubLauncher();

    const out = refused(
      await retryRun({
        runId: PARENT_RUN,
        selector: "unit",
        requestId: "../../etc/passwd",
        catalog: { root },
        launcher: launcher.launcher,
      }),
    );
    expect(out.message).toContain("is not a usable request id");
    expect(out.message).toContain("128 chars");
    expect(launcher.calls).toEqual([]);
  });
});
