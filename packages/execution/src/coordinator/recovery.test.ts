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
import {
  claimReceipt,
  digestOf,
  markDispatched,
  readReceipt,
} from "@odu/run-history/receipts";
import type { RunManifest } from "@odu/run-history/schema";
import { claimOwnership, OWNERSHIP_GRACE_MS } from "@odu/run-history/owner";
import {
  appendEvent,
  readJournal,
  registerRun,
  type RunHandle,
  startAttempt,
  writeVerdict,
} from "@odu/run-history/store";
import type { LaunchRequest, RunLauncher } from "./launcher";
import {
  RETRY_DISPATCH_GRACE_MS,
  retryRun,
  type RetryInput,
  type RetryOutcome,
} from "./recovery";

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
/** The host a hand-made claim is stamped with, so liveness is askable. */
const CLAIM_HOST = "claimant-box.invalid";

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

type ManifestInput = Omit<RunManifest, "version" | "registeredBy">;

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
 *  dependants" are different sets.
 *
 *  It carries the run's IDENTITY (`sha7` + `seq`), because a checkout socket
 *  serves one run after another and the policy refuses to mutate a run it
 *  cannot prove is the one it was asked about. `over` is how a test says "a
 *  DIFFERENT run is serving this socket now". */
function liveState(over: Partial<PipelineState> = {}): PipelineState {
  const seed = (id: string, needs: string[]) =>
    pendingNode({ id, name: id, command: "just x", needs });
  return {
    name: "ci::default",
    sha7: SHA.slice(0, 7),
    seq: 3,
    dirty: false,
    order: [UNIT, E2E, LINT],
    nodes: {
      [UNIT]: { ...seed(UNIT, []), status: "failed", exitCode: 1 },
      [E2E]: seed(E2E, [UNIT]),
      [LINT]: { ...seed(LINT, []), status: "failed", exitCode: 1 },
    },
    ...over,
  };
}

type Dial = NonNullable<RetryInput["dial"]>;

interface DialStub {
  dial: Dial;
  /** Every node the policy asked the live coordinator to re-run, in order. */
  asked: string[];
  /** Every rerun call WHOLE, so a test can assert what correlation crossed the
   *  wire rather than only which node did. */
  calls: { id: string; requestId?: string; inputDigest?: string }[];
  closes: number;
}

/** A live coordinator that serves `state` and answers `node.rerun` with
 *  `accepts(id)`. The shapes are exactly the two members the policy consumes —
 *  a `Stream` for the cell and an `Effect` for the mutation — because that is
 *  what `firstFrame` and `runUnary` know how to run. */
function stubDial(
  state: PipelineState,
  accepts: (id: string) => boolean = () => true,
  /** Does this stand-in coordinator write the request down? `true` is a build
   *  that records; `false` is an older one that drops the id it does not
   *  know. */
  records = true,
): DialStub {
  const stub: DialStub = { asked: [], calls: [], closes: 0, dial: async () => null };
  stub.dial = (async () => ({
    client: {
      surface: {
        nodes: { get: () => Stream.make(state) },
        node: {
          rerun: (input: { id: string; requestId?: string; inputDigest?: string }) => {
            stub.asked.push(input.id);
            stub.calls.push(input);
            const ok = accepts(input.id);
            return Effect.succeed(
              records && ok && input.requestId !== undefined
                ? { ok, recorded: true }
                : { ok },
            );
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

describe("the socket is not the run", () => {
  it("refuses to mutate a DIFFERENT run that took over the checkout's socket", async () => {
    // Run A finishes; run B starts in the same checkout and binds the same
    // `.ci/odu.sock`. Retrying A must not reset a node on B — and the receipt
    // that came back would have carried A's id and A's commit, so nothing
    // downstream could have caught it.
    const root = tmpCatalog();
    aRun(root, ENDPOINT);
    const somebodyElse = stubDial(liveState({ seq: 9 }));
    const launcher = stubLauncher();

    const out = accepted(
      await retryRun({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
        dial: somebodyElse.dial,
      }),
    );

    // Nothing was asked of the run on the wire…
    expect(somebodyElse.asked).toEqual([]);
    // …and the retry became a fresh run rather than a silent mutation.
    expect(out.receipt.mode).toBe("relaunched");
    expect(launcher.calls).toHaveLength(1);
  });

  it("refuses the live path for a run that reserved no ordinal", async () => {
    // `sha7` alone is shared by every run of a commit — including a rerun of
    // the very run being retried — so a run with no `<sha7>#<seq>` cannot
    // prove it is the one addressed. Fail closed.
    const root = tmpCatalog();
    aRun(root, ENDPOINT, { seq: null });
    const live = stubDial(liveState({ seq: undefined }));
    const launcher = stubLauncher();

    await retryRun({
      runId: PARENT_RUN,
      selector: "unit",
      catalog: { root },
      launcher: launcher.launcher,
      dial: live.dial,
    });

    expect(live.asked).toEqual([]);
    expect(launcher.calls).toHaveLength(1);
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
      // A claimant on THIS host, so reconciliation can ask about it. Whether it
      // is alive is the test's business — `repeat` injects the probe — and the
      // default below is "gone", which is what the lost-reply cases are about.
      claimant: { pid: 31337, host: CLAIM_HOST },
      now: T0 + 5,
    });
    if (outcome?.kind !== "claimed") {
      throw new Error(`could not claim by hand: ${outcome?.kind ?? "null"}`);
    }
  }

  /** The trace a live retry leaves: the coordinator that accepted it appends a
   *  fresh `attempt_started` for the node it reset. Written with the run's own
   *  ownership token, the way the coordinator would have. */
  function appendLiveRetryEvidence(root: string, handle: RunHandle): void {
    const owner = claimOwnership({
      runId: handle.runId,
      dir: handle.dir,
      endpoint: ENDPOINT,
      // Past the grace, from another host: the documented cross-host takeover,
      // and the only honest way for a test to hold this run's token while our
      // own pid is very much alive.
      now: T0 + OWNERSHIP_GRACE_MS + 1,
      pid: 4242,
      host: "some-other-box.invalid",
      isAlive: () => false,
    });
    if (!owner.ok) throw new Error(`could not take the run over: ${owner.refusal.kind}`);
    // What the COORDINATOR writes when it accepts a retry: the request's own
    // id, recorded before it performs the reset. This is the evidence
    // reconciliation reads. The `attempt_started` that follows is the reset
    // itself becoming visible — deliberately included, because it is what an
    // observer sees and what the old code MISTOOK for evidence.
    appendEvent(
      handle,
      owner.token,
      {
        kind: "retry_accepted",
        requestId: REQUEST,
        effectiveRunId: handle.runId,
        roots: [UNIT],
        resetDependants: [],
        inputDigest: "",
      },
      T0 + OWNERSHIP_GRACE_MS + 2,
    );
    appendEvent(
      handle,
      owner.token,
      { kind: "retry_applied", requestId: REQUEST, node: UNIT, applied: true },
      T0 + OWNERSHIP_GRACE_MS + 3,
    );
    appendEvent(
      handle,
      owner.token,
      {
        kind: "attempt_started",
        node: UNIT,
        attempt: 3,
        placement: PLACEMENT,
      },
      T0 + OWNERSHIP_GRACE_MS + 4,
    );
    void root;
  }

  /** Hold this run's write token the way a successor does — a heartbeat past
   *  the grace and an incumbent that is gone. (The incumbent is US, and our pid
   *  is alive, so the liveness probe is injected.) */
  function takeOverForEvidence(handle: RunHandle) {
    const owner = claimOwnership({
      runId: handle.runId,
      dir: handle.dir,
      endpoint: ENDPOINT,
      now: T0 + OWNERSHIP_GRACE_MS + 1,
      pid: 4242,
      host: "some-other-box.invalid",
      isAlive: () => false,
    });
    if (!owner.ok) throw new Error(`could not take the run over: ${owner.refusal.kind}`);
    return owner.token;
  }

  /** Accepted and then NOTHING — the coordinator died between writing the
   *  intent and performing the reset. */
  function appendAcceptedButUnresolved(handle: RunHandle): void {
    const token = takeOverForEvidence(handle);
    appendEvent(
      handle,
      token,
      {
        kind: "retry_accepted",
        requestId: REQUEST,
        effectiveRunId: handle.runId,
        roots: [UNIT],
        resetDependants: [],
        inputDigest: "",
      },
      T0 + OWNERSHIP_GRACE_MS + 2,
    );
  }

  /** Accepted, and the lane said no. */
  function appendRefusedRetry(handle: RunHandle): void {
    const owner = claimOwnership({
      runId: handle.runId,
      dir: handle.dir,
      endpoint: ENDPOINT,
      now: T0 + OWNERSHIP_GRACE_MS + 1,
      pid: 4242,
      host: "some-other-box.invalid",
      isAlive: () => false,
    });
    if (!owner.ok) throw new Error(`could not take the run over: ${owner.refusal.kind}`);
    appendEvent(
      handle,
      owner.token,
      {
        kind: "retry_accepted",
        requestId: REQUEST,
        effectiveRunId: handle.runId,
        roots: [UNIT],
        resetDependants: [],
        inputDigest: "",
      },
      T0 + OWNERSHIP_GRACE_MS + 2,
    );
    appendEvent(
      handle,
      owner.token,
      { kind: "retry_applied", requestId: REQUEST, node: UNIT, applied: false },
      T0 + OWNERSHIP_GRACE_MS + 3,
    );
  }

  /** The same run, with the reset VISIBLE but no record of who asked for it —
   *  ordinary scheduling, or somebody else's retry. */
  function appendUncorrelatedAttempt(handle: RunHandle): void {
    const owner = claimOwnership({
      runId: handle.runId,
      dir: handle.dir,
      endpoint: ENDPOINT,
      now: T0 + OWNERSHIP_GRACE_MS + 1,
      pid: 4242,
      host: "some-other-box.invalid",
      isAlive: () => false,
    });
    if (!owner.ok) throw new Error(`could not take the run over: ${owner.refusal.kind}`);
    appendEvent(
      handle,
      owner.token,
      { kind: "attempt_started", node: UNIT, attempt: 3, placement: PLACEMENT },
      T0 + OWNERSHIP_GRACE_MS + 2,
    );
  }

  /** A repeat LONG after the first ask, which is what a lost reply actually
   *  looks like: a caller times out and asks again. Past
   *  `RETRY_DISPATCH_GRACE_MS`, so the answer is about recorded evidence rather
   *  than about a claimant that might still be mid-dispatch. */
  function repeat(root: string, launcher: LauncherStub): Promise<RetryOutcome> {
    return repeatAt(root, launcher, T0 + RETRY_DISPATCH_GRACE_MS + 10);
  }

  function repeatAt(
    root: string,
    launcher: LauncherStub,
    at: number,
    /** Is the process that claimed this id still running? The question the
     *  whole post-grace branch turns on, so every test states it. */
    claimantAlive = false,
  ): Promise<RetryOutcome> {
    return retryRun({
      runId: PARENT_RUN,
      selector: "unit",
      requestId: REQUEST,
      catalog: { root },
      launcher: launcher.launcher,
      host: CLAIM_HOST,
      isAlive: () => claimantAlive,
      now: () => at,
    });
  }

  it("sends the request's identity with the mutation", async () => {
    // Correlation has to reach the process that performs the mutation, because
    // that is the only process that can record it. An id that stays on the
    // caller's side leaves the coordinator writing a reset that names nobody.
    const root = tmpCatalog();
    aRun(root, ENDPOINT);
    const dial = stubDial(liveState());
    const launcher = stubLauncher();

    const out = accepted(
      await retryRun({
        runId: PARENT_RUN,
        selector: "unit",
        requestId: REQUEST,
        catalog: { root },
        launcher: launcher.launcher,
        dial: dial.dial,
        now: () => T0 + 10,
      }),
    );

    expect(out.receipt.mode).toBe("live");
    expect(dial.calls).toHaveLength(1);
    expect(dial.calls[0]?.id).toBe(UNIT);
    expect(dial.calls[0]?.requestId).toBe(REQUEST);
    // The digest rides along so the coordinator's record can tell one request
    // from another wearing the same id, without trusting the caller's file.
    expect(dial.calls[0]?.inputDigest).toBeTruthy();
  });

  it("carries no identity when the caller asked for none", async () => {
    // A retry without an id accepts that a repeat repeats, and must not have
    // one invented for it — an id the caller never chose is one it cannot use
    // to reconcile, while still costing a journal line on every rerun.
    const root = tmpCatalog();
    aRun(root, ENDPOINT);
    const dial = stubDial(liveState());

    await retryRun({
      runId: PARENT_RUN,
      selector: "unit",
      catalog: { root },
      launcher: stubLauncher().launcher,
      dial: dial.dial,
      now: () => T0 + 10,
    });

    expect(dial.calls[0]?.requestId).toBeUndefined();
    expect(dial.calls[0]?.inputDigest).toBeUndefined();
  });

  it("warns when the coordinator did not record the request", async () => {
    // An older coordinator performs the reset and drops the id. The retry
    // SUCCEEDED — refusing it would be worse — but a future repeat of this id
    // can only be told its outcome is unknown, and the operator should hear
    // that now rather than discover it during an incident.
    const root = tmpCatalog();
    aRun(root, ENDPOINT);
    const dial = stubDial(liveState(), () => true, false);
    const warnings: string[] = [];

    const out = accepted(
      await retryRun({
        runId: PARENT_RUN,
        selector: "unit",
        requestId: REQUEST,
        catalog: { root },
        launcher: stubLauncher().launcher,
        dial: dial.dial,
        warn: (m) => warnings.push(m),
        now: () => T0 + 10,
      }),
    );

    expect(out.receipt.mode).toBe("live");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("did not record request");
    expect(warnings[0]).toContain(REQUEST);
  });

  it("says nothing when the coordinator did record it", async () => {
    const root = tmpCatalog();
    aRun(root, ENDPOINT);
    const warnings: string[] = [];

    accepted(
      await retryRun({
        runId: PARENT_RUN,
        selector: "unit",
        requestId: REQUEST,
        catalog: { root },
        launcher: stubLauncher().launcher,
        dial: stubDial(liveState()).dial,
        warn: (m) => warnings.push(m),
        now: () => T0 + 10,
      }),
    );

    expect(warnings).toEqual([]);
  });

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

  it("reconciles a LIVE mutation from the coordinator's own record of it", async () => {
    // The half a run-id lookup cannot see. A live retry resets a node on a
    // coordinator that is already going and publishes no run of its own, so
    // "does the planned run exist?" answers `no` about a mutation that
    // certainly happened — and the caller was told to retry with a fresh id,
    // which performs it a second time.
    //
    // What DID happen is written by the coordinator that did it, against the
    // request's own id, before it performed the reset.
    const root = tmpCatalog();
    const handle = aRun(root, ENDPOINT);
    claimByHand(handle, "0000000b-0002");
    appendLiveRetryEvidence(root, handle);
    const launcher = stubLauncher();

    const out = accepted(await repeat(root, launcher));

    expect(out.replayed).toBe(true);
    expect(out.receipt.mode).toBe("live");
    expect(out.receipt.effective_run).toBe(PARENT_RUN);
    expect(out.receipt.roots).toEqual([UNIT]);
    // EMPTY, deliberately: the ordinal a retry produced was never recorded, and
    // reading "the latest attempt now" would hand back a number belonging to
    // whatever has happened since — including the failure being retried.
    expect(out.receipt.attempts).toEqual([]);
    // Nothing was started, and nothing was re-issued.
    expect(launcher.calls).toEqual([]);

    // A third ask replays the completed receipt verbatim.
    const third = accepted(await repeat(root, launcher));
    expect(third.receipt).toEqual(out.receipt);
    expect(launcher.calls).toEqual([]);
  });

  it("refuses rather than silently redoing the work when nothing happened", async () => {
    // Nothing exists under the pre-minted id. That is not the same as "nothing
    // happened" — a LIVE retry leaves no run of its own — so the caller is told
    // exactly what is and is not known instead of being handed a guess.
    const root = tmpCatalog();
    const handle = aFinishedRun(root);
    claimByHand(handle, "0000000b-0002");
    const launcher = stubLauncher();

    const out = refused(await repeat(root, launcher));

    expect(out.message).toContain("its outcome is not recorded");
    expect(out.message).toContain("No run was started under it");
    expect(out.message).toContain("recorded no acceptance for it");
    expect(out.message).toContain("never put on the wire");
    expect(out.suggestion).toEqual(["odu", "history", "show", "--run", PARENT_RUN]);
    expect(launcher.calls).toEqual([]);
  });

  it("does NOT claim a retry that never happened when unrelated work starts", async () => {
    // The misattribution this correlation exists to end. Claim an id, dispatch
    // NOTHING, and then let ordinary execution begin an attempt on a node the
    // selector happens to name. The attempt is real and it is after the claim,
    // and under a timing-based reconciliation that was enough to report the
    // retry as a success — with an attempt number belonging to work this
    // request never caused. Nobody recorded the request, so nobody may claim it.
    const root = tmpCatalog();
    const handle = aRun(root, ENDPOINT);
    claimByHand(handle, "0000000b-0002");
    appendUncorrelatedAttempt(handle);
    const launcher = stubLauncher();

    const out = refused(await repeat(root, launcher));

    expect(out.message).toContain("recorded no acceptance for it");
    expect(out.message).not.toContain("UNKNOWN");
    expect(launcher.calls).toEqual([]);
  });

  it("does NOT replay an ACCEPTED-but-unresolved intent as a completed retry", async () => {
    // The coordinator records acceptance BEFORE it performs the reset, because
    // the other ordering lets a crash hide a mutation. The price is that the
    // acceptance alone proves only that the reset was ASKED FOR — the
    // coordinator can die in between. Replaying that as a success reports a
    // retry that may never have run.
    const root = tmpCatalog();
    const handle = aRun(root, ENDPOINT);
    claimByHand(handle, "0000000b-0002");
    appendAcceptedButUnresolved(handle);
    const launcher = stubLauncher();

    const out = refused(await repeat(root, launcher));

    expect(out.message).toContain("outcome is UNKNOWN");
    expect(out.message).toContain("nothing has recorded what became of");
    expect(out.message).toContain("Do not repeat it with a fresh id");
    expect(launcher.calls).toEqual([]);
  });

  it("replays a lane's REFUSAL as the answer it is", async () => {
    // Accepted, then declined. That is an outcome, not an unknown: a repeat
    // learns its retry was refused instead of being told nobody knows.
    const root = tmpCatalog();
    const handle = aRun(root, ENDPOINT);
    claimByHand(handle, "0000000b-0002");
    appendRefusedRetry(handle);
    const launcher = stubLauncher();

    const out = refused(await repeat(root, launcher));

    expect(out.message).toContain("the lane declined the reset");
    expect(out.message).not.toContain("UNKNOWN");
    expect(launcher.calls).toEqual([]);

    // Recorded, so a third ask is a plain replay rather than more reconciling.
    const third = refused(await repeat(root, launcher));
    expect(third.message).toBe(out.message);
    expect(launcher.calls).toEqual([]);
  });

  it("reports a PARTIALLY applied retry as partial, not as wholly one thing", async () => {
    // One request dispatches one `node.rerun` per root, so the answers can
    // differ. Folding them into a single boolean made the LAST one win: root A
    // reset and root B declined reported as "nothing was re-run" (false about
    // A), and the reverse order reported success listing B, whose reset never
    // happened. Both directions are lies; partial has to be representable.
    const root = tmpCatalog();
    const handle = aRun(root, ENDPOINT);
    claimByHand(handle, "0000000b-0002");
    const owner = takeOverForEvidence(handle);
    appendEvent(
      handle,
      owner,
      {
        kind: "retry_accepted",
        requestId: REQUEST,
        effectiveRunId: handle.runId,
        roots: [UNIT, LINT],
        resetDependants: [],
        inputDigest: "",
      },
      T0 + OWNERSHIP_GRACE_MS + 2,
    );
    appendEvent(
      handle,
      owner,
      { kind: "retry_applied", requestId: REQUEST, node: UNIT, applied: true },
      T0 + OWNERSHIP_GRACE_MS + 3,
    );
    appendEvent(
      handle,
      owner,
      { kind: "retry_applied", requestId: REQUEST, node: LINT, applied: false },
      T0 + OWNERSHIP_GRACE_MS + 4,
    );

    const out = refused(await repeat(root, stubLauncher()));

    expect(out.message).toContain("applied in part");
    expect(out.message).toContain(UNIT);
    expect(out.message).toContain(LINT);
  });

  it("stays UNKNOWN past the grace while the claimant is STILL RUNNING", async () => {
    // The hole a 120-second grace left. Age is not evidence: a caller paused in
    // a dial is perfectly capable of mutating a moment after the grace expires,
    // so concluding "nothing happened" from elapsed time told the second caller
    // re-issuing was safe while the first was about to act. A longer grace only
    // moves that race.
    //
    // The question is the one the ownership fence asks — is the process that
    // holds this claim GONE? — and here it is not.
    const root = tmpCatalog();
    const handle = aFinishedRun(root);
    claimByHand(handle, "0000000b-0002");
    const launcher = stubLauncher();

    const out = refused(
      await repeatAt(root, launcher, T0 + RETRY_DISPATCH_GRACE_MS * 10, true),
    );

    expect(out.message).toContain("outcome is UNKNOWN");
    expect(out.message).toContain("STILL RUNNING");
    expect(out.message).toContain("Do not repeat it with a fresh id");
    expect(launcher.calls).toEqual([]);
  });

  it("stays UNKNOWN when the claim was made on ANOTHER host", async () => {
    // No liveness to check across hosts, which the ownership fence says out
    // loud rather than implying. Same answer here, for the same reason.
    const root = tmpCatalog();
    const handle = aFinishedRun(root);
    claimByHand(handle, "0000000b-0002");

    const out = refused(
      await retryRun({
        runId: PARENT_RUN,
        selector: "unit",
        requestId: REQUEST,
        catalog: { root },
        launcher: stubLauncher().launcher,
        host: "a-different-box.invalid",
        isAlive: () => false,
        now: () => T0 + RETRY_DISPATCH_GRACE_MS * 10,
      }),
    );

    expect(out.message).toContain("outcome is UNKNOWN");
    expect(out.message).toContain("cannot see whether that process is still running");
  });

  it("does NOT complete a multi-root request from the roots dispatched so far", async () => {
    // `tryLive` dispatches roots one at a time and the coordinator records an
    // acceptance per root, so between two roots the journal holds a PREFIX of
    // the request. Reading the request's extent from that prefix let a repeat
    // arriving in the window believe the first root was the whole thing — and
    // `completeReceipt` then froze that short answer, so even a third ask long
    // after every root had landed replayed a success naming one of two.
    const root = tmpCatalog();
    const handle = aRun(root, ENDPOINT);
    claimByHand(handle, "0000000b-0002");
    // The intent, recorded before any root goes out — two roots.
    markDispatched(handle, REQUEST, [UNIT, LINT], T0 + 6);
    const owner = takeOverForEvidence(handle);
    // Only the FIRST root has been accepted and applied so far.
    appendEvent(
      handle,
      owner,
      {
        kind: "retry_accepted",
        requestId: REQUEST,
        effectiveRunId: handle.runId,
        roots: [UNIT],
        resetDependants: [],
        inputDigest: "",
      },
      T0 + OWNERSHIP_GRACE_MS + 2,
    );
    appendEvent(
      handle,
      owner,
      { kind: "retry_applied", requestId: REQUEST, node: UNIT, applied: true },
      T0 + OWNERSHIP_GRACE_MS + 3,
    );

    const out = refused(await repeat(root, stubLauncher()));

    // NOT a success naming only `unit`.
    expect(out.message).toContain("outcome is UNKNOWN");
    expect(out.message).toContain(LINT);
    expect(out.message).toContain("not finished");

    // And the receipt is NOT completed, so the answer is not frozen: once the
    // second root lands, the next ask gets the whole request.
    appendEvent(
      handle,
      owner,
      {
        kind: "retry_accepted",
        requestId: REQUEST,
        effectiveRunId: handle.runId,
        roots: [LINT],
        resetDependants: [],
        inputDigest: "",
      },
      T0 + OWNERSHIP_GRACE_MS + 4,
    );
    appendEvent(
      handle,
      owner,
      { kind: "retry_applied", requestId: REQUEST, node: LINT, applied: true },
      T0 + OWNERSHIP_GRACE_MS + 5,
    );

    const after = accepted(await repeat(root, stubLauncher()));
    expect(after.receipt.roots).toEqual([UNIT, LINT]);
  });

  it("reports a partial outcome only once EVERY intended root is resolved", async () => {
    // The same window, with the second root declined rather than applied. The
    // partial answer is only reachable when nothing is still outstanding.
    const root = tmpCatalog();
    const handle = aRun(root, ENDPOINT);
    claimByHand(handle, "0000000b-0002");
    markDispatched(handle, REQUEST, [UNIT, LINT], T0 + 6);
    const owner = takeOverForEvidence(handle);
    for (const [i, [node, applied]] of (
      [
        [UNIT, true],
        [LINT, false],
      ] as const
    ).entries()) {
      appendEvent(
        handle,
        owner,
        {
          kind: "retry_accepted",
          requestId: REQUEST,
          effectiveRunId: handle.runId,
          roots: [node],
          resetDependants: [],
          inputDigest: "",
        },
        T0 + OWNERSHIP_GRACE_MS + 2 + i * 2,
      );
      appendEvent(
        handle,
        owner,
        { kind: "retry_applied", requestId: REQUEST, node, applied },
        T0 + OWNERSHIP_GRACE_MS + 3 + i * 2,
      );
    }

    const out = refused(await repeat(root, stubLauncher()));

    expect(out.message).toContain("applied in part");
    expect(out.message).toContain(UNIT);
    expect(out.message).toContain(LINT);
  });

  it("refuses a CONCURRENT repeat while the first claimant may still dispatch", async () => {
    // Absence of a dispatch marker at one instant is not proof that the caller
    // holding this id will never dispatch. A repeat arriving while the original
    // is between its claim and its first mutation — which on the relaunch path
    // includes starting a coordinator — must not be told "nothing happened, use
    // a fresh id": that is how one request becomes two runs.
    const root = tmpCatalog();
    const handle = aFinishedRun(root);
    claimByHand(handle, "0000000b-0002");
    const launcher = stubLauncher();

    const out = refused(await repeatAt(root, launcher, T0 + 50));

    expect(out.message).toContain("outcome is UNKNOWN");
    expect(out.message).toContain("may still be dispatching");
    expect(launcher.calls).toEqual([]);
  });

  it("marks a RELAUNCH as dispatched before the launcher is entered", async () => {
    // The gap the live path had closed and this one had not. A launcher that is
    // still starting a coordinator has published no manifest, and reading that
    // absence as proof of no spawn told a repeat to use a fresh id while the
    // original launch was in flight.
    const root = tmpCatalog();
    const handle = aFinishedRun(root);
    let dispatchedWhenLauncherRan: number | undefined;
    const launcher = stubLauncher({
      onLaunch: () => {
        dispatchedWhenLauncherRan = readReceipt(handle, REQUEST)?.dispatchedAt;
      },
    });

    await retryRun({
      runId: PARENT_RUN,
      selector: "unit",
      requestId: REQUEST,
      catalog: { root },
      launcher: launcher.launcher,
      now: () => T0 + 10,
    });

    expect(launcher.calls).toHaveLength(1);
    // Marked BEFORE, not after: the marker exists at the moment the launcher is
    // running, which is the only moment at which it helps.
    expect(dispatchedWhenLauncherRan).toBe(T0 + 10);
  });

  it("keeps a launched-but-unpublished request UNRESOLVED, not a no-op", async () => {
    // Spawn → crash → the catalog entry never appears. The dispatch marker is
    // what stops that from reading as "nothing happened".
    const root = tmpCatalog();
    const handle = aFinishedRun(root);
    claimByHand(handle, "0000000b-0002");
    markDispatched(handle, REQUEST, [UNIT], T0 + 5);
    const launcher = stubLauncher();

    const out = refused(await repeat(root, launcher));

    expect(out.message).toContain("outcome is UNKNOWN");
    expect(out.message).toContain("already been put on the wire");
    expect(launcher.calls).toEqual([]);
  });

  it("keeps an unresolved acceptance UNRESOLVED once it reached the wire", async () => {
    // The case a fresh id must never be offered for. The request got as far as
    // dispatching, and then its answer vanished; the coordinator recorded no
    // acceptance, so whether the mutation landed is genuinely unknown — an
    // older coordinator that ignored the id, or one that died before writing.
    // "Nothing happened" would be a guess, and acting on it mutates twice.
    const root = tmpCatalog();
    const handle = aFinishedRun(root);
    claimByHand(handle, "0000000b-0002");
    markDispatched(handle, REQUEST, [UNIT], T0 + 5);
    const launcher = stubLauncher();

    const out = refused(await repeat(root, launcher));

    expect(out.message).toContain("outcome is UNKNOWN");
    expect(out.message).toContain("Do not repeat it with a fresh id");
    expect(out.message).not.toContain("nothing it asked for happened");
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
    expect(out.message).toContain("No run was started under it");
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
