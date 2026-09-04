/**
 * The venue claim as a VALUE — `claimVenues` lifted out of `orchestrate`'s
 * 1000-line scope (lens review, lowy F1 / hickey F4). Its outputs used to be
 * three mutated bindings behind an `Error | null` return; they are now the
 * return value, which is also what makes this reachable without an ssh host:
 * `leaseLanes`'s injected `claim` is the only thing standing in for one.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimResult } from "./lease";
import { readLeaseRecord } from "./leaseRecord";
import { claimVenues, prepareVenues } from "./runEnv";

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
  // Never reached: an injected `claim` is what stands in for the ssh dial that
  // would have needed a resolved runner derivation.
  resolveDrvPath: () => (): never => {
    throw new Error("resolveDrvPath must not be called with an injected claim");
  },
});

describe("claimVenues", () => {
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
    // One scope, one `finally`: `odu hosts` sees the run waiting while it
    // waits, and never after — including when the claim fails.
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
    // The clear-out runs in a `finally`, and a throw there REPLACES the value
    // the `try` produced. So an unwritable lease file would have discarded a
    // claim that actually succeeded, rejected out of a function documented not
    // to throw, and stranded the lease: `orchestrate` never reaches the merge
    // into `acquiredLeases`, so nothing left alive can release it. A stale row
    // in an inventory file is the smaller problem, and the one that loses.
    const repoRoot = repo();
    // `.ci` as a FILE, so every mkdir/write beneath it raises ENOTDIR — the
    // real disk failures (ENOSPC, EACCES, a raced rename) take the same path.
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
    // The caller gets the lease and therefore the ability to release it.
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
      resolveDrvPath: () => (): never => {
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
      resolveDrvPath: () => (): never => {
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
      resolveDrvPath: () => (): never => {
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
