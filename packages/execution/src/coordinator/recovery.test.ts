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
const CHECKOUT = mkdtempSync(join(tmpdir(), "odu-recovery-checkout-"));
const ENDPOINT = join(CHECKOUT, ".ci", "odu.sock");
const PARENT_RUN = "0000000a-0001";
const PLATFORM = "x86_64-linux";

const TEST_HOSTS: HostsConfig = {
  hosts: { [PLATFORM]: ["builder-1"], "aarch64-darwin": ["mac-1"] },
  source: "/test/hosts.json",
};

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

function retry(input: Omit<RetryInput, "hosts"> & { hosts?: () => HostsConfig }) {
  return retryRun({ hosts: () => TEST_HOSTS, ...input });
}
const UNIT = `ci::unit@${PLATFORM}`;
const E2E = `ci::e2e@${PLATFORM}`;
const LINT = `ci::lint@${PLATFORM}`;
const PLACEMENT = { platform: PLATFORM, host: "builder-1" };
const CLAIM_HOST = "claimant-box.invalid";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpCatalog(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-recovery-"));
  dirs.push(dir);
  return dir;
}

type ManifestInput = Omit<RunManifest, "version" | "registeredBy">;

function manifest(over: Partial<ManifestInput> = {}): ManifestInput {
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
    hostPins: [],
    hostsFile: "",
    snapshot: { mode: "strict", expectedSha: SHA, dirty: false, retryable: true },
    build: { oduVersion: "0.1.0", self: "/nix/store/x/bin/odu", runnerFlake: null },
    parentRunId: null,
    requestId: null,
    ...over,
  };
}

function aRun(
  root: string,
  endpoint: string | null,
  over: Partial<ManifestInput> = {},
): RunHandle {
  const result = registerRun(manifest(over), { root, endpoint, now: T0 });
  if (!result.ok) throw new Error(`registration refused: ${result.refusal.reason}`);
  const { handle, token } = result;
  appendEvent(handle, token, { kind: "roster", order: [UNIT, E2E, LINT] }, T0 + 1);
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
  asked: string[];
  calls: {
    id: string;
    requestId?: string;
    inputDigest?: string;
    expectAttempt?: number;
  }[];
  closes: number;
}

function stubDial(
  state: PipelineState,
  accepts: (id: string) => boolean = () => true,
  records = true,
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
        selector: `@${PLATFORM}`,
        catalog: { root },
        launcher: launcher.launcher,
        dial: dial.dial,
        now: () => T0 + 10,
      }),
    );

    expect(out.replayed).toBe(false);
    expect(out.receipt.mode).toBe("live");
    expect(out.receipt.effective_run).toBe(PARENT_RUN);
    expect(out.receipt.parent_run).toBeNull();

    expect(out.receipt.roots).toEqual([UNIT, LINT]);
    expect(out.receipt.reset_dependants).toEqual([E2E]);
    expect(dial.asked).toEqual([UNIT, LINT]);

    expect(out.receipt.attempts).toEqual([
      { node: UNIT, attempt: 2 },
      { node: LINT, attempt: 1 },
    ]);
    expect(out.receipt.sha).toBe(SHA);
    expect(readJournal(handle).cursor.seq).toBe(2);
    expect(out.receipt.cursor).toBe(`${PARENT_RUN}@2`);

    expect(launcher.calls).toEqual([]);
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
    expect(out.suggestion).toEqual(["odu", "ci", "run", "unit"]);
  });
});

describe("the socket is not the run", () => {
  it("refuses to mutate a DIFFERENT run that took over the checkout's socket", async () => {
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

    expect(somebodyElse.asked).toEqual([]);
    expect(out.receipt.mode).toBe("relaunched");
    expect(launcher.calls).toHaveLength(1);
  });

  it("refuses the live path for a run that reserved no ordinal", async () => {
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
    expect(request.expectedSha).toBe(SHA);
    expect(request.noPost).toBe(true);
    expect(request.scope.selectors).toEqual(["unit"]);
    expect(request.scope.noDeps).toBe(false);
    expect(request.scope.platforms).toEqual([PLATFORM]);
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
    expect(request.noStrict).toBe(true);
    expect(request.noSnapshot).toBe(true);
  });
});

describe("a replay runs where its parent was allowed to run", () => {
  it("replays the parent's pins, whatever the hosts file says today", async () => {
    const root = tmpCatalog();
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

    expect(launcher.calls[0]?.hostPins).toEqual([
      `${PLATFORM}=builder-7.internal`,
    ]);
  });

  it("refuses when today's inventory cannot express the parent's placement", async () => {
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
    expect(out.message).toContain(PLATFORM);
    expect(out.suggestion).toEqual(["odu", "ci", "hosts"]);
    expect(launcher.calls).toEqual([]);
  });

  it("narrows an unnamed platform set to the lanes the parent actually had", async () => {
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
    const root = tmpCatalog();
    const handle = aFinishedRun(root, {
      scope: { selectors: ["unit"], platforms: [], noDeps: false },
      hostPins: [],
    });
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
    expect(out.suggestion).toEqual(["odu", "ci", "run", "unit"]);
    expect(launcher.calls).toEqual([]);
  });

  it("refuses a record that predates placement evidence, and starts nothing", async () => {
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
    expect(out.suggestion).toEqual(["odu", "ci", "run", "unit", "e2e"]);
    expect(launcher.calls).toEqual([]);
  });

  it("replays the parent's INVENTORY, not the service's", async () => {
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

    expect(launcher.calls[0]?.hostsFile).toBe("/fleets/a.json");
  });

  it("replays a caller who had no hosts file as one who had none", async () => {
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

  it("checks that caller against the CALLER's chain, through the real resolver", async () => {
    const brokenDir = mkdtempSync(join(tmpdir(), "odu-recovery-broken-"));
    dirs.push(brokenDir);
    const broken = join(brokenDir, "hosts.json");
    writeFileSync(broken, "{ this is not JSON");
    process.env.ODU_HOSTS = broken;
    try {
      const root = tmpCatalog();
      aFinishedRun(root, {
        hostsFile: "",
        hostPins: [`${PLATFORM}=builder-7.internal`],
      });
      const launcher = stubLauncher();

      accepted(
        await retryRun({
          runId: PARENT_RUN,
          selector: "unit",
          catalog: { root },
          launcher: launcher.launcher,
        }),
      );

      expect(launcher.calls[0]?.hostsFile).toBe("");
    } finally {
      process.env.ODU_HOSTS = HOSTLESS;
    }
  });

  it("checks a recorded PATH against that file, through the real resolver", async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "odu-recovery-fleet-"));
    dirs.push(fleetDir);
    const fleet = join(fleetDir, "hosts.json");
    writeFileSync(fleet, JSON.stringify({ [PLATFORM]: ["builder-1"] }));
    const root = tmpCatalog();
    aFinishedRun(root, { hostsFile: fleet });
    const launcher = stubLauncher();

    accepted(
      await retryRun({
        runId: PARENT_RUN,
        selector: "unit",
        catalog: { root },
        launcher: launcher.launcher,
      }),
    );

    expect(launcher.calls[0]?.hostsFile).toBe(fleet);
  });

  it("refuses a record that predates inventory evidence, and starts nothing", async () => {
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
    expect(out.suggestion).toEqual(["odu", "ci", "run", "unit", "e2e"]);
    expect(launcher.calls).toEqual([]);
  });

  it("does not refuse a LIVE retry for want of placement evidence", async () => {
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
    expect(dial.asked).toEqual([UNIT]);
    expect(launcher.calls).toEqual([]);
  });
});

describe("a run whose inputs were never committed", () => {
  it("names the working-tree snapshot and keeps finalized retry refused", async () => {
    const root = tmpCatalog();
    aFinishedRun(root, { snapshot: { mode: "live", expectedSha: SHA, dirty: true, retryable: false, contentSha: "a".repeat(40) } });
    const launcher = stubLauncher();
    const out = refused(await retry({ runId: PARENT_RUN, selector: "unit", catalog: { root }, launcher: launcher.launcher }));
    expect(out.message).toContain(`working-tree snapshot aaaaaaa of ${SHA.slice(0, 7)}`);
    expect(launcher.calls).toEqual([]);
  });
  it("is refused rather than replaced by a run of today's tree", async () => {
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
    expect(Array.isArray(out.suggestion)).toBe(true);
    expect(out.suggestion?.[0]).toBe("odu");
    expect(out.suggestion).toEqual(["odu", "ci", "run", "unit", "e2e"]);
    expect(launcher.calls).toEqual([]);
  });

  it("gives the SAME refusal to a repeat of the same request id", async () => {
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
    expect(out.suggestion?.slice(0, 3)).toEqual(["odu", "ci", "logs"]);
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
    expect(out.suggestion).toEqual(["odu", "ci", "history", "show", "--run", PARENT_RUN]);
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

    expect(launcher.calls).toHaveLength(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
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

  function claimByHand(handle: RunHandle, plannedRunId: string): void {
    const outcome = claimReceipt(handle, {
      requestId: REQUEST,
      kind: "retry",
      digest: digestOf([PARENT_RUN, "unit", "", 0]),
      mint: () => plannedRunId,
      claimant: { pid: 31337, host: CLAIM_HOST },
      now: T0 + 5,
    });
    if (outcome?.kind !== "claimed") {
      throw new Error(`could not claim by hand: ${outcome?.kind ?? "null"}`);
    }
  }

  function appendLiveRetryEvidence(root: string, handle: RunHandle): void {
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

  function repeat(root: string, launcher: LauncherStub): Promise<RetryOutcome> {
    return repeatAt(root, launcher, T0 + RETRY_DISPATCH_GRACE_MS + 10);
  }

  function repeatAt(
    root: string,
    launcher: LauncherStub,
    at: number,
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
    expect(dial.calls[0]?.inputDigest).toBeTruthy();
  });

  it("carries no identity when the caller asked for none", async () => {
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
    expect(launcher.calls).toEqual([]);

    const third = accepted(await repeat(root, launcher));
    expect(third.replayed).toBe(true);
    expect(third.receipt).toEqual(out.receipt);
    expect(launcher.calls).toEqual([]);
  });

  it("reconciles a LIVE mutation from the coordinator's own record of it", async () => {
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
    expect(out.receipt.attempts).toEqual([]);
    expect(launcher.calls).toEqual([]);

    const third = accepted(await repeat(root, launcher));
    expect(third.receipt).toEqual(out.receipt);
    expect(launcher.calls).toEqual([]);
  });

  it("refuses rather than silently redoing the work when nothing happened", async () => {
    const root = tmpCatalog();
    const handle = aFinishedRun(root);
    claimByHand(handle, "0000000b-0002");
    const launcher = stubLauncher();

    const out = refused(await repeat(root, launcher));

    expect(out.message).toContain("its outcome is not recorded");
    expect(out.message).toContain("No run was started under it");
    expect(out.message).toContain("recorded no acceptance for it");
    expect(out.message).toContain("never put on the wire");
    expect(out.suggestion).toEqual(["odu", "ci", "history", "show", "--run", PARENT_RUN]);
    expect(launcher.calls).toEqual([]);
  });

  it("does NOT claim a retry that never happened when unrelated work starts", async () => {
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
    const root = tmpCatalog();
    const handle = aRun(root, ENDPOINT);
    claimByHand(handle, "0000000b-0002");
    appendRefusedRetry(handle);
    const launcher = stubLauncher();

    const out = refused(await repeat(root, launcher));

    expect(out.message).toContain("outcome is UNKNOWN");
    expect(out.message).toContain("selects a replacement RUN");
    expect(launcher.calls).toEqual([]);
    expect(readReceipt(handle, REQUEST)?.state).toBe("accepted");

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
    const root = tmpCatalog();
    aRun(root, ENDPOINT);
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
          markDispatched(handle, REQUEST, [UNIT], T0 + 50);
          return false;
        },
        now: () => T0 + RETRY_DISPATCH_GRACE_MS + 10,
      }),
    );

    expect(out.message).toContain("outcome is UNKNOWN");
    expect(out.message).toContain("already been put on the wire");
    expect(launcher.calls).toEqual([]);
  });

  it("REFUSES when the node advances between the preflight and the coordinator", async () => {
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
    expect(dial.calls[0]?.expectAttempt).toBe(2);
    expect(launcher.calls).toEqual([]);
  });

  it("carries the guard only on the root it names", async () => {
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
    const root = tmpCatalog();
    const handle = aRun(root, ENDPOINT);
    const guarded = (): Promise<RetryOutcome> =>
      retry({
        runId: PARENT_RUN,
        selector: "unit",
        requestId: REQUEST,
        expectAttempt: { node: UNIT, attempt: 2 },
        catalog: { root },
        launcher: stubLauncher().launcher,
        dial: stubDial(liveState()).dial,
        now: () => T0 + 10,
      });

    const first = accepted(await guarded());
    expect(first.receipt.mode).toBe("live");

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
    const root = tmpCatalog();
    const handle = aRun(root, ENDPOINT);
    claimByHand(handle, "0000000b-0002");
    markDispatched(handle, REQUEST, [UNIT, LINT], T0 + 6);
    const owner = takeOverForEvidence(handle);
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

    expect(out.message).toContain("outcome is UNKNOWN");
    expect(out.message).toContain(LINT);
    expect(out.message).toContain("not finished");

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
    expect(dispatchedWhenLauncherRan).toBe(T0 + 10);
  });

  it("keeps a launched-but-unpublished request UNRESOLVED, not a no-op", async () => {
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
