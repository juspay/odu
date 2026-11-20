import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimResult } from "./lease";
import { readLeaseRecord } from "./leaseRecord";
import {
  claimPlatformsIndependently,
  claimVenues,
  prepareVenues,
  type ClaimOutcome,
} from "./runEnv";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-runenv-"));
  dirs.push(dir);
  return dir;
}

const base = (repoRoot: string) => ({
  repoRoot,
  pools: {
    hosts: { "x86_64-linux": ["ci-1"] },
    source: "/home/me/.config/odu/hosts.json",
  },
  platforms: ["x86_64-linux"],
  identity: { holder: "me@box", run: "abc1234#1" },
  noWait: true,
  runLabel: "abc1234#1",
  onLine: (): void => {},
  resolveDrvPath: (): never => {
    throw new Error("resolveDrvPath must not be called with an injected claim");
  },
});

describe("claimVenues", () => {
  it("preflights the complete run before a per-platform claim", async () => {
    const repoRoot = repo();
    const claim = mock(async (host: string): Promise<ClaimResult> => ({
      kind: "held",
      lease: { host, release: () => {} },
    }));
    const outcome = await claimVenues({
      ...base(repoRoot),
      pools: {
        hosts: {
          "x86_64-linux": ["shared-builder"],
          "aarch64-linux": ["shared-builder"],
        },
        source: null,
      },
      platforms: ["x86_64-linux"],
      validatePlatforms: ["x86_64-linux", "aarch64-linux"],
      claim,
    });

    expect(outcome.ok).toBe(false);
    expect(claim).not.toHaveBeenCalled();
  });

  it("returns the lanes and leases it got, instead of mutating them into scope", async () => {
    const repoRoot = repo();
    const outcome = await claimVenues({
      ...base(repoRoot),
      claim: async (host): Promise<ClaimResult> => ({
        kind: "held",
        lease: { host, release: () => {} },
      }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.lanes).toEqual({ "x86_64-linux": "ci-1" });
    expect(outcome.leases.map((l) => l.host)).toEqual(["ci-1"]);
  });

  it("returns the failure as a value — a run with a live socket must not unwind", async () => {
    const repoRoot = repo();
    const outcome = await claimVenues({
      ...base(repoRoot),
      claim: async (): Promise<ClaimResult> => ({
        kind: "unreachable",
        error: "down",
      }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toContain("x86_64-linux");
  });

  it("holds the observable waiting rows for exactly the claim, on both exits", async () => {
    const repoRoot = repo();
    let duringClaim: string[] = [];
    await claimVenues({
      ...base(repoRoot),
      claim: async (host): Promise<ClaimResult> => {
        duringClaim = Object.keys(readLeaseRecord(repoRoot));
        return { kind: "held", lease: { host, release: () => {} } };
      },
    });
    expect(duringClaim).toEqual(["x86_64-linux"]);
    expect(readLeaseRecord(repoRoot)).toEqual({});

    await claimVenues({
      ...base(repoRoot),
      claim: async (): Promise<ClaimResult> => ({
        kind: "unreachable",
        error: "down",
      }),
    });
    expect(readLeaseRecord(repoRoot)).toEqual({});
  });

  it("writes nothing at all when no platform needs a claim", async () => {
    const repoRoot = repo();
    const outcome = await claimVenues({ ...base(repoRoot), platforms: [] });
    expect(outcome).toEqual({ ok: true, lanes: {}, leases: [] });
    expect(readLeaseRecord(repoRoot)).toEqual({});
  });

  it("keeps a successful claim when the bookkeeping write fails", async () => {
    const repoRoot = repo();
    writeFileSync(join(repoRoot, ".ci"), "not a directory");

    const released: string[] = [];
    const outcome = await claimVenues({
      ...base(repoRoot),
      claim: async (host): Promise<ClaimResult> => ({
        kind: "held",
        lease: { host, release: () => released.push(host) },
      }),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.lanes).toEqual({ "x86_64-linux": "ci-1" });
    expect(outcome.leases.map((l) => l.host)).toEqual(["ci-1"]);
    expect(released).toEqual([]);
  });

  it("reports an unforeseen throw as a value, honouring its own contract", async () => {
    const repoRoot = repo();
    const outcome = await claimVenues({
      ...base(repoRoot),
      claim: () => {
        throw new Error("odu: something nobody planned for");
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toContain("nobody planned for");
  });
});

describe("claimPlatformsIndependently", () => {
  it("publishes a ready platform before a sibling claim settles", async () => {
    let finishLinux: (outcome: ClaimOutcome) => void = () => {};
    const linux = new Promise<ClaimOutcome>((resolve) => {
      finishLinux = resolve;
    });
    const ready: string[] = [];
    const claims = claimPlatformsIndependently(
      ["aarch64-darwin", "x86_64-linux"],
      async (platform) =>
        platform === "aarch64-darwin"
          ? { ok: true, lanes: { [platform]: "mac" }, leases: [] }
          : await linux,
      (platform) => ready.push(platform),
    );

    await Promise.resolve();
    expect(ready).toEqual(["aarch64-darwin"]);

    finishLinux({
      ok: true,
      lanes: { "x86_64-linux": "linux" },
      leases: [],
    });
    await claims;
    expect(ready).toEqual(["aarch64-darwin", "x86_64-linux"]);
  });
});

describe("prepareVenues", () => {
  it("promotes surviving capacity and returns ownership grouped by platform", async () => {
    const brokenRelease = () => {};
    const broken = {
      host: "ci-primary",
      slot: 0,
      release: brokenRelease,
      verifyHeld: async () => false,
    };
    const promoted = {
      host: "ci-burst",
      slot: 0,
      release: () => {},
      verifyHeld: async () => true,
    };
    const lines: string[] = [];
    const outcome = await prepareVenues({
      claimed: {
        ok: true,
        lanes: { "x86_64-linux": broken.host },
        leases: [broken],
      },
      existingLanes: {},
      platforms: ["x86_64-linux"],
      bursts: [{ platform: "x86_64-linux", label: "e2e", limit: 1 }],
      pools: {
        hosts: { "x86_64-linux": [broken.host, promoted.host] },
        source: null,
      },
      identity: { holder: "me@box", run: "abc1234#1" },
      onLine: (line) => lines.push(line),
      resolveDrvPath: (): never => {
        throw new Error("injected burst acquisition must be used");
      },
      leaseBurst: async () => [promoted],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.venues.get("x86_64-linux")).toEqual({
      host: "ci-burst",
      leases: [promoted],
      bursts: [],
    });
    expect(lines.join("\n")).toContain("promoted ci-burst");
  });

  it("rechecks optional leases on an agent-held primary after cold peers finish", async () => {
    const brokenRelease = () => {};
    const broken = {
      host: "ci-broken",
      release: brokenRelease,
      verifyHeld: async () => false,
    };
    const healthy = {
      host: "ci-healthy",
      release: () => {},
      verifyHeld: async () => true,
    };
    const outcome = await prepareVenues({
      claimed: { ok: true, lanes: {}, leases: [] },
      existingLanes: { "x86_64-linux": "agent-held" },
      platforms: ["x86_64-linux"],
      bursts: [{ platform: "x86_64-linux", label: "e2e", limit: 2 }],
      pools: {
        hosts: { "x86_64-linux": ["agent-held", broken.host, healthy.host] },
        source: null,
      },
      identity: { holder: "me@box", run: "abc1234#1" },
      onLine: () => {},
      resolveDrvPath: (): never => {
        throw new Error("injected burst acquisition must be used");
      },
      leaseBurst: async (opts) => {
        expect(opts.exclude).toBeUndefined();
        return [broken, healthy];
      },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.venues.get("x86_64-linux")).toEqual({
      host: "agent-held",
      leases: [healthy],
      bursts: [healthy],
    });
  });

  it("releases optional handles, leaving caller-owned primaries alone", async () => {
    const released: string[] = [];
    const primary = (host: string) => ({
      host,
      release: () => released.push(host),
      verifyHeld: async () => true,
    });
    const linux = primary("linux-primary");
    const darwin = primary("darwin-primary");
    const extra = primary("linux-extra");
    const outcome = await prepareVenues({
      claimed: {
        ok: true,
        lanes: {
          "aarch64-darwin": darwin.host,
          "x86_64-linux": linux.host,
        },
        leases: [darwin, linux],
      },
      existingLanes: {},
      platforms: ["aarch64-darwin", "x86_64-linux"],
      bursts: [
        { platform: "aarch64-darwin", label: "e2e", limit: 1 },
        { platform: "x86_64-linux", label: "e2e", limit: 1 },
      ],
      pools: {
        hosts: {
          "aarch64-darwin": [darwin.host],
          "x86_64-linux": [linux.host],
        },
        source: null,
      },
      identity: { holder: "me@box", run: "abc1234#1" },
      onLine: () => {},
      resolveDrvPath: (): never => {
        throw new Error("injected burst acquisition must be used");
      },
      leaseBurst: async ({ platform }) => {
        if (platform === "aarch64-darwin") {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error("darwin preparation exploded");
        }
        return [extra];
      },
    });

    expect(outcome.ok).toBe(false);
    expect(released).toEqual([extra.host]);
  });
});
