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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
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
  expireRun,
  readJournal,
  registerRun,
  type RunHandle,
  startAttempt,
  writeVerdict,
} from "@odu/run-history/store";
import type { LaunchRequest, RunLauncher } from "./launcher";
import type { HostsConfig } from "./hosts";
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

/**
 * The host inventory these tests run against — THEIRS, never the machine's.
 *
 * A replay checks that the parent's recorded placement is still expressible
 * against today's declared inventory, and `loadHosts()` reads whatever hosts
 * file the developer happens to have. Left to default, every test below would
 * pass or fail on a fact about the laptop it ran on, and the one that matters
 * most — a hosts file that CHANGED since the parent ran — could not be stated
 * at all.
 */
const TEST_HOSTS: HostsConfig = {
  hosts: { [PLATFORM]: ["builder-1"], "aarch64-darwin": ["mac-1"] },
  source: "/test/hosts.json",
};

/**
 * NEUTRALISE THE AMBIENT HOSTS FILE, so forgetting the wrapper fails HERE.
 *
 * `relaunch` checks the parent's placement against today's declared inventory,
 * and `loadHosts()` reads whatever the developer has. Three call sites in this
 * file passed a prepared `RetryInput` variable rather than an object literal,
 * so a search-and-replace that injected `hosts` missed them — and they went on
 * consulting the machine. On a laptop with an `x86_64-linux` entry they passed;
 * on a CI runner with no hosts file at all they failed, which is the worst
 * possible place to find out and exactly where they were found.
 *
 * Pointing `$ODU_HOSTS` at an empty-but-PRESENT config makes the real
 * `loadHosts()` answer "no host for that platform" for every test in this file.
 * So a call that skips {@link retry} now fails on every machine, not just the
 * ones without a hosts file.
 */
const HOSTLESS = join(
  mkdtempSync(join(tmpdir(), "odu-recovery-nohosts-")),
  "hosts.json",
);
writeFileSync(HOSTLESS, "{}");
const HOSTS_WAS = process.env.ODU_HOSTS;
process.env.ODU_HOSTS = HOSTLESS;
afterAll(() => {
  if (HOSTS_WAS === undefined) delete process.env.ODU_HOSTS;
  else process.env.ODU_HOSTS = HOSTS_WAS;
});

/** `retryRun` with this suite's inventory injected. Every call goes through it
 *  so no test can accidentally consult the machine. */
function retry(input: Omit<RetryInput, "hosts"> & { hosts?: () => HostsConfig }) {
  return retryRun({ hosts: () => TEST_HOSTS, ...input });
}
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

/**
 * A manifest, with two sentinels: passing `hostPins: undefined` or
 * `hostsFile: undefined` OMITS that field rather than writing an empty one.
 *
 * The two are different records and the difference is the whole of the
 * placement contract — `[]` is a run that asked for no pins, ABSENT is a run
 * whose record predates odu writing them down at all. `optionalKey` refuses a
 * present-but-`undefined` key on encode, so "absent" cannot be spelled by
 * assignment and has to be spelled by deletion.
 */
function manifest(over: Partial<ManifestInput> = {}): ManifestInput {
  // Through a mutable alias, because `RunManifest`'s fields are readonly and
  // "this key is not in the record" has no spelling in the type — which is the
  // point: production code cannot write an absent field, only an older build
  // could leave one, and this is the fixture that stands in for that build.
  const built = { ...manifestBase(over) } as Record<string, unknown>;
  if ("hostPins" in over && over.hostPins === undefined) delete built.hostPins;
  if ("hostsFile" in over && over.hostsFile === undefined) delete built.hostsFile;
  return built as unknown as ManifestInput;
}

function manifestBase(over: Partial<ManifestInput> = {}): ManifestInput {
  return {
    runId: PARENT_RUN,
    repo: "juspay/odu",
    sha: SHA,
    seq: 3,
    pipeline: "ci",
    repoRoot: CHECKOUT,
    createdAt: T0,
    scope: { selectors: ["unit", "e2e"], platforms: [PLATFORM], noDeps: true },
    // An ordinary unpinned run: the caller named no `--host`, and the record
    // SAYS so. Spelled here rather than defaulted away, because the difference
    // between this and the field being absent is what the placement tests below
    // are about — every run odu registers today writes it.
    hostPins: [],
    // The FLEET those pins are names in. `""` is an ordinary caller whose shell
    // had no `$ODU_HOSTS`, and — like `hostPins: []` — is a different record
    // from the field being absent, which is what the inventory tests below are
    // about.
    hostsFile: "",
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
  calls: {
    id: string;
    requestId?: string;
    inputDigest?: string;
    expectAttempt?: number;
  }[];
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
  /** What the COORDINATOR says this node is on, when a call carries a guard.
   *  `undefined` means it agrees with whatever the caller asked for — the
   *  ordinary case; a number is how a test says the node moved underneath. */
  attemptNow?: number,
): DialStub {
  const stub: DialStub = { asked: [], calls: [], closes: 0, dial: async () => null };
  stub.dial = (async () => ({
    client: {
      surface: {
        nodes: { get: () => Stream.make(state) },
        node: {
          rerun: (input: {
            id: string;
            requestId?: string;
            inputDigest?: string;
            expectAttempt?: number;
          }) => {
            stub.asked.push(input.id);
            stub.calls.push(input);
            if (
              input.expectAttempt !== undefined &&
              attemptNow !== undefined &&
              attemptNow !== input.expectAttempt
            ) {
              return Effect.succeed({
                ok: false,
                refusal: "stale_attempt" as const,
                attempt: attemptNow,
              });
            }
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
      await retry({
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
      await retry({
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
    return retry({
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
      await retry({
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

    await retry({
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
      await retry({
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
      await retry({
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

/**
 * WHERE a run was allowed to happen is part of what it was.
 *
 * A finalized retry builds its child's `LaunchRequest` from the parent's
 * durable record, and that request used to carry `hostPins: []` — which is not
 * "the parent asked for no pins" but "do not carry the question". Nothing in
 * the child then constrained placement, so it resolved against whatever the
 * ambient hosts file said at retry time. A parent confined to one named machine
 * came back fanned out over a pool, under a run id that says it is a replay of
 * the confined one, with no line anywhere saying it had moved.
 *
 * The pins are the CONSTRAINT the caller stated. Deliberately not the
 * `Placement.host` an attempt recorded: that is the machine a lease handed out,
 * which for a multi-host pool is an accident of who was free, and freezing it
 * would answer a question the user never asked.
 */
describe("a replay runs where its parent was allowed to run", () => {
  it("replays the parent's pins, whatever the hosts file says today", async () => {
    const root = tmpCatalog();
    // The parent was confined to one box. The ambient hosts file this test's
    // machine has is irrelevant and is never consulted — which is the point: a
    // pin overrides the file, so replaying the pin is what makes the retry
    // independent of a file that has since been edited.
    aFinishedRun(root, { hostPins: [`${PLATFORM}=builder-7.internal`] });
    const launcher = stubLauncher();

    accepted(
      await retry({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
      }),
    );

    const request = launcher.calls[0];
    if (request === undefined) throw new Error("nothing was launched");
    expect(request.hostPins).toEqual([`${PLATFORM}=builder-7.internal`]);
  });

  it("keeps every pin, not just the platform being retried", async () => {
    // A retry of `unit` still carries the pin for a platform `unit` does not
    // run on. Dropping it would be a placement decision made by the retry path
    // on the strength of a selector, and the selector expands to a dependency
    // closure whose platforms are the child coordinator's to work out.
    const root = tmpCatalog();
    const pins = [`${PLATFORM}=builder-7.internal`, "aarch64-darwin=mac-2"];
    aFinishedRun(root, { hostPins: pins });
    const launcher = stubLauncher();

    accepted(
      await retry({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
      }),
    );

    expect(launcher.calls[0]?.hostPins).toEqual(pins);
  });

  it("does not widen when the hosts file gained machines since the parent ran", async () => {
    // THE SCENARIO THE FIELD EXISTS FOR. The parent was pinned to one box; by
    // the time it is retried, somebody has added three more machines to the
    // platform's pool. Without the recorded pin the child resolves against the
    // new file and fans out over all four — a placement the user never asked
    // for, on a run whose id says it is a replay of the confined one.
    const root = tmpCatalog();
    aFinishedRun(root, { hostPins: [`${PLATFORM}=builder-7.internal`] });
    const launcher = stubLauncher();
    const widened: HostsConfig = {
      hosts: { [PLATFORM]: ["builder-1", "builder-2", "builder-3", "builder-4"] },
      source: "/test/hosts-after.json",
    };

    accepted(
      await retry({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
        hosts: () => widened,
      }),
    );

    // The pin still names the one machine, so `resolvePools` will collapse that
    // four-host pool back to it — which is what "did not widen" means, stated
    // where it can be checked rather than inferred.
    expect(launcher.calls[0]?.hostPins).toEqual([
      `${PLATFORM}=builder-7.internal`,
    ]);
  });

  it("refuses when today's inventory cannot express the parent's placement", async () => {
    // `--platform` slices the fanout, and a platform the hosts file no longer
    // configures makes the slice unstateable — `resolvePools` throws rather
    // than quietly dropping it. Launching anyway would start a child that
    // resolves to a DIFFERENT set of lanes than the run it claims to replay.
    const root = tmpCatalog();
    aFinishedRun(root, { hostPins: [] });
    const launcher = stubLauncher();
    const gone: HostsConfig = {
      hosts: { "aarch64-darwin": ["mac-1"] },
      source: "/test/hosts-after.json",
    };

    const out = refused(
      await retry({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
        hosts: () => gone,
      }),
    );

    expect(out.code).toBe("no_venue");
    expect(out.message).toContain("cannot be replayed where it ran");
    // The engine's own sentence, carried through rather than reworded — it
    // knows which platform lost its host and this layer does not.
    expect(out.message).toContain(PLATFORM);
    expect(out.suggestion).toEqual(["odu", "hosts"]);
    expect(launcher.calls).toEqual([]);
  });

  it("narrows an unnamed platform set to the lanes the parent actually had", async () => {
    // WIDENING WITHOUT A PIN. `scope.platforms: []` means "whatever the fanout
    // resolves to", and the fanout resolves against TODAY's hosts file — so a
    // platform added since the parent ran would get the retried selector
    // dispatched onto it, on a run whose id says it is a replay. No `--host`
    // needs to be involved for this to happen, which is why the pins alone are
    // not enough.
    //
    // `aFinishedRun` journals a lane for PLATFORM (via `PLACEMENT`), so the
    // parent's real lane set is knowable and is what the child gets.
    const root = tmpCatalog();
    aFinishedRun(root, {
      scope: { selectors: ["unit"], platforms: [], noDeps: false },
      hostPins: [],
    });
    const launcher = stubLauncher();

    accepted(
      await retry({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
        hosts: () => ({
          hosts: { [PLATFORM]: ["builder-1"], "aarch64-darwin": ["mac-1"] },
          source: "/test/hosts-after.json",
        }),
      }),
    );

    expect(launcher.calls[0]?.scope.platforms).toEqual([PLATFORM]);
  });

  it("replays an explicitly unpinned parent as unpinned", async () => {
    // `[]` is a recorded answer, not a missing one, and it must not be confused
    // with the refusal below.
    const root = tmpCatalog();
    aFinishedRun(root, { hostPins: [] });
    const launcher = stubLauncher();

    accepted(
      await retry({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
      }),
    );

    expect(launcher.calls[0]?.hostPins).toEqual([]);
  });

  it("refuses a run retention has expired, whose journal is gone", async () => {
    // THE HOLE THE JOURNAL-NARROWING OPENED. Expiry keeps a run's IDENTITY and
    // deletes its EVIDENCE, so an expired run reads back with a good manifest —
    // `retryable` true, `repoRoot` present, `hostPins` recorded — and sails
    // through every placement gate. What it no longer has is the journal, which
    // is the only thing that can narrow an empty `scope.platforms` down to the
    // lanes the run really had. Without this refusal a month-old run confined
    // to one platform comes back across today's whole fleet, with every other
    // guard green.
    const root = tmpCatalog();
    const handle = aFinishedRun(root, {
      scope: { selectors: ["unit"], platforms: [], noDeps: false },
      hostPins: [],
    });
    // Past the ownership grace: `expireRun` refuses to touch a run whose owner
    // record still looks live, which is the same fence every other writer keeps.
    expect(expireRun(handle, T0 + OWNERSHIP_GRACE_MS + 1)).toBe(true);
    const launcher = stubLauncher();

    const out = refused(
      await retry({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
      }),
    );

    expect(out.code).toBe("expired");
    expect(out.message).toContain("expired by retention");
    expect(out.suggestion).toEqual(["odu", "run", "unit"]);
    expect(launcher.calls).toEqual([]);
  });

  it("refuses a record that predates placement evidence, and starts nothing", async () => {
    // The case an empty array cannot express. A record written by an older odu
    // does not say whether the run was pinned, and the two possible answers
    // differ by "dispatch work onto every machine in the pool" — so the honest
    // move is to refuse and let a person state the placement they want.
    const root = tmpCatalog();
    aFinishedRun(root, { hostPins: undefined });
    const launcher = stubLauncher();

    const out = refused(
      await retry({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
      }),
    );

    expect(out.code).toBe("not_replayable");
    expect(out.message).toContain("placement evidence");
    expect(out.message).toContain("--host");
    // A recovery the caller can run, as argv.
    expect(out.suggestion).toEqual(["odu", "run", "unit", "e2e"]);
    // And above all: nothing was launched anywhere.
    expect(launcher.calls).toEqual([]);
  });

  it("replays the parent's INVENTORY, not the service's", async () => {
    // Pins say WHICH box; the inventory says which fleet that name lives in,
    // and they are two facts. A parent that resolved against `$ODU_HOSTS=A`
    // retried by a service holding `B` gets a child that resolves against B —
    // so an unpinned platform lands on different machines, or a pinned one is
    // refused because B does not configure that platform at all. The replay
    // says nothing about having moved, because from its side nothing did.
    const root = tmpCatalog();
    aFinishedRun(root, { hostsFile: "/fleets/a.json" });
    const launcher = stubLauncher();

    accepted(
      await retry({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
      }),
    );

    // Handed to the child EXPLICITLY. Inheriting the daemon's environment is
    // what put the service's fleet in a replay's hands in the first place.
    expect(launcher.calls[0]?.hostsFile).toBe("/fleets/a.json");
  });

  it("replays a caller who had no hosts file as one who had none", async () => {
    // `""` is an answer: the parent's shell had no `$ODU_HOSTS`, so it resolved
    // from `~/.config`. A replay must do the same rather than pick up whatever
    // the SERVICE was started with, which is the one value that has nothing to
    // do with the run being replayed.
    const root = tmpCatalog();
    aFinishedRun(root, { hostsFile: "" });
    const launcher = stubLauncher();

    accepted(
      await retry({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
      }),
    );

    expect(launcher.calls[0]?.hostsFile).toBe("");
  });

  it("refuses a record that predates inventory evidence, and starts nothing", async () => {
    // The same shape as the placement refusal above, one fact over. A record
    // that does not say which hosts file it resolved against cannot promise to
    // replay against it, and guessing places somebody's work on a fleet they
    // never named.
    const root = tmpCatalog();
    aFinishedRun(root, { hostsFile: undefined });
    const launcher = stubLauncher();

    const out = refused(
      await retry({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
      }),
    );

    expect(out.code).toBe("not_replayable");
    expect(out.message).toContain("inventory evidence");
    expect(out.suggestion).toEqual(["odu", "run", "unit", "e2e"]);
    expect(launcher.calls).toEqual([]);
  });

  it("does not refuse a LIVE retry for want of placement evidence", async () => {
    // The refusal is scoped to a REPLAY, and it has to be. A live retry resets
    // nodes on a coordinator that is still up — placement is that coordinator's
    // already-resolved lanes, not something this path reconstructs — so an old
    // record with no pins recorded has nothing missing that a live retry needs.
    // Refusing it would take away the cheaper recovery on the strength of a
    // fact only the expensive one depends on.
    const root = tmpCatalog();
    aRun(root, ENDPOINT, { hostPins: undefined });
    const launcher = stubLauncher();
    const dial = stubDial(liveState());

    const out = accepted(
      await retry({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
        dial: dial.dial,
      }),
    );

    expect(out.receipt.mode).toBe("live");
    expect(out.receipt.effective_run).toBe(PARENT_RUN);
    // The coordinator was asked, and nothing was relaunched.
    expect(dial.asked).toEqual([UNIT]);
    expect(launcher.calls).toEqual([]);
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
      await retry({
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
      retry({
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
      await retry({
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
      await retry({
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
      await retry({
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

    const first = accepted(await retry(sameRequest(root, launcher)));
    const second = accepted(await retry(sameRequest(root, launcher)));

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

    accepted(await retry(sameRequest(root, launcher)));
    const out = refused(
      await retry({ ...sameRequest(root, launcher), selector: "e2e" }),
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
    return retry({
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
      await retry({
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

    await retry({
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
      await retry({
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
      await retry({
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

  it("keeps an ALL-DECLINED live reset PENDING, because a relaunch follows it", async () => {
    // Where the live attempt ends and the request does not. A wholly-declined
    // live reset is exactly what selects a replacement RUN, so these same
    // records mean "the live path is over" to the policy and used to mean "the
    // request is over" to the fold. A repeat arriving while the original caller
    // was inside its launcher persisted a refusal, and `completeReceipt` then
    // hid the child that really started — permanently, since the first result
    // wins.
    const root = tmpCatalog();
    const handle = aRun(root, ENDPOINT);
    claimByHand(handle, "0000000b-0002");
    appendRefusedRetry(handle);
    const launcher = stubLauncher();

    const out = refused(await repeat(root, launcher));

    expect(out.message).toContain("outcome is UNKNOWN");
    expect(out.message).toContain("selects a replacement RUN");
    // NOT re-issued, and NOT recorded as a final answer.
    expect(launcher.calls).toEqual([]);
    expect(readReceipt(handle, REQUEST)?.state).toBe("accepted");

    // And once the fallback's child exists, the repeat replays THAT — the
    // outcome the request actually had.
    registerRun(
      manifest({
        runId: "0000000b-0002",
        parentRunId: PARENT_RUN,
        requestId: REQUEST,
      }),
      { root, endpoint: null, now: T0 + 6 },
    );
    const after = accepted(await repeat(root, launcher));
    expect(after.receipt.mode).toBe("relaunched");
    expect(after.receipt.effective_run).toBe("0000000b-0002");
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

  it("reports a partial LIVE retry as partial on the FIRST call, not only on replay", async () => {
    // One rule for the whole request, whichever path answers it. The
    // reconciliation fold reports a part-applied retry as partial; the live
    // path used to collect the roots that succeeded and say nothing about the
    // rest — so identical lane replies meant "success" when the first reply
    // arrived and "partial" when it was lost and reconstructed. A domain answer
    // that depends on whether a reply was delivered is not a domain answer.
    const root = tmpCatalog();
    aRun(root, ENDPOINT);
    // `unit` takes the reset; `lint` (independent of it) declines.
    const dial = stubDial(liveState(), (id) => id === UNIT);

    const out = refused(
      await retry({
        runId: PARENT_RUN,
        selector: `@${PLATFORM}`,
        requestId: REQUEST,
        catalog: { root },
        launcher: stubLauncher().launcher,
        dial: dial.dial,
        now: () => T0 + 10,
      }),
    );

    expect(out.message).toContain("applied in part");
    expect(out.message).toContain(UNIT);
    expect(out.message).toContain(LINT);

    // And the RECORDED answer is that same partial, so a repeat — the SAME
    // request, or the digest would make it a conflict — is told the truth
    // rather than handed a cached unqualified success.
    const again = refused(
      await retry({
        runId: PARENT_RUN,
        selector: `@${PLATFORM}`,
        requestId: REQUEST,
        catalog: { root },
        launcher: stubLauncher().launcher,
        dial: stubDial(liveState()).dial,
        now: () => T0 + 20,
      }),
    );
    expect(again.message).toContain("applied in part");
  });

  it("re-reads the receipt after observing the claimant dead", async () => {
    // The window between the two reads. The evidence is gathered BEFORE the
    // pid probe runs, so the process the probe then reports dead could have
    // marked its dispatch, sent it and exited in between — and an answer built
    // from the earlier snapshot would licence a second mutation.
    //
    // The interleaving is driven from inside the probe itself: the dispatch
    // marker lands at the exact moment liveness is observed false.
    const root = tmpCatalog();
    const handle = aFinishedRun(root);
    claimByHand(handle, "0000000b-0002");
    const launcher = stubLauncher();

    const out = refused(
      await retry({
        runId: PARENT_RUN,
        selector: "unit",
        requestId: REQUEST,
        catalog: { root },
        launcher: launcher.launcher,
        host: CLAIM_HOST,
        isAlive: () => {
          // A, still alive a moment ago, dispatches and exits right here.
          markDispatched(handle, REQUEST, [UNIT], T0 + 50);
          return false;
        },
        now: () => T0 + RETRY_DISPATCH_GRACE_MS + 10,
      }),
    );

    // NOT "nothing happened, retry with a fresh id".
    expect(out.message).toContain("outcome is UNKNOWN");
    expect(out.message).toContain("already been put on the wire");
    expect(launcher.calls).toEqual([]);
  });

  it("REFUSES when the node advances between the preflight and the coordinator", async () => {
    // The other half of the guard. A caller checks the attempt it read, then
    // dials, then dispatches — and the node can advance in between, so a guard
    // evaluated only at the caller is a preflight reporting a state it has
    // already stopped speaking for. Here the coordinator says the node is on 3
    // while the caller authorized 2, and the reset must not happen.
    const root = tmpCatalog();
    aRun(root, ENDPOINT);
    const dial = stubDial(liveState(), () => true, true, 3);
    const launcher = stubLauncher();

    const out = refused(
      await retry({
        runId: PARENT_RUN,
        selector: "unit",
        expectAttempt: { node: UNIT, attempt: 2 },
        catalog: { root },
        launcher: launcher.launcher,
        dial: dial.dial,
        now: () => T0 + 10,
      }),
    );

    expect(out.message).toContain("is on attempt 3, not 2");
    // The guard carried to the authority, and its refusal is TERMINAL: it must
    // not fall through to starting a whole new run, which is the one thing the
    // guard exists to prevent.
    expect(dial.calls[0]?.expectAttempt).toBe(2);
    expect(launcher.calls).toEqual([]);
  });

  it("carries the guard only on the root it names", async () => {
    // A caller names ONE node and an attempt, and the coordinator checks it
    // against that node's allocator — so sending it with a sibling's reset
    // would refuse work the guard says nothing about.
    const root = tmpCatalog();
    aRun(root, ENDPOINT);
    const dial = stubDial(liveState());

    await retry({
      runId: PARENT_RUN,
      selector: `@${PLATFORM}`,
      expectAttempt: { node: UNIT, attempt: 2 },
      catalog: { root },
      launcher: stubLauncher().launcher,
      dial: dial.dial,
      now: () => T0 + 10,
    });

    expect(dial.calls.find((c) => c.id === UNIT)?.expectAttempt).toBe(2);
    expect(dial.calls.find((c) => c.id === LINT)?.expectAttempt).toBeUndefined();
  });

  it("replays a completed guarded retry even after its own attempt landed", async () => {
    // A guarded retry that SUCCEEDS moves the node to the next attempt, so an
    // identical repeat — which is exactly what an idempotency key invites, and
    // what a lost reply forces — arrived to find the precondition it had
    // already satisfied now false, and was refused against its own effect. The
    // recorded answer is the right one; the guard is for work not yet accepted.
    const root = tmpCatalog();
    const handle = aRun(root, ENDPOINT);
    const guarded = (): Promise<RetryOutcome> =>
      retry({
        runId: PARENT_RUN,
        selector: "unit",
        requestId: REQUEST,
        // `unit` is recorded at attempt 2 by `aRun`.
        expectAttempt: { node: UNIT, attempt: 2 },
        catalog: { root },
        launcher: stubLauncher().launcher,
        dial: stubDial(liveState()).dial,
        now: () => T0 + 10,
      });

    const first = accepted(await guarded());
    expect(first.receipt.mode).toBe("live");

    // The retry's own effect: a third attempt on the node it just re-ran.
    startAttempt(handle, takeOverForEvidence(handle), {
      node: UNIT,
      attempt: 3,
      placement: PLACEMENT,
      startedAt: T0 + 20,
    });

    const again = accepted(await guarded());
    expect(again.replayed).toBe(true);
    expect(again.receipt).toEqual(first.receipt);
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
      await retry({
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

    await retry({
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
      await retry({
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
      await retry({
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
