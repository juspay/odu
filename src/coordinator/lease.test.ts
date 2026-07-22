import { describe, expect, it, vi } from "vitest";
import {
  acquireFromPool,
  formatHeldFor,
  formatHolder,
  leaseLanes,
  parseHolderBody,
  type ClaimResult,
  type LeaseIdentity,
} from "./lease";

const id: LeaseIdentity = { holder: "me@desk", run: "abc1234#1" };

function held(host: string): ClaimResult {
  return {
    kind: "held",
    lease: { host, release: vi.fn() },
  };
}

describe("parseHolderBody / formatHolder", () => {
  it("round-trips the pipe-encoded holder line", () => {
    const info = parseHolderBody("grok@desk|e9f0a1b#1|1000000");
    expect(info).toEqual({
      holder: "grok@desk",
      run: "e9f0a1b#1",
      sinceMs: 1_000_000,
    });
    expect(formatHolder(info!, 1_000_000 + 6 * 60_000)).toBe(
      "grok@desk · e9f0a1b#1 · 6m",
    );
  });

  it("treats '-' run as absent", () => {
    const info = parseHolderBody("a@b|-|1000");
    expect(info?.run).toBeNull();
    expect(formatHolder(info!, 1000 + 45_000)).toBe("a@b · 45s");
  });

  it("formatHeldFor scales s/m/h", () => {
    expect(formatHeldFor(0, 30_000)).toBe("30s");
    expect(formatHeldFor(0, 120_000)).toBe("2m");
    expect(formatHeldFor(0, 7_200_000)).toBe("2h");
  });
});

describe("acquireFromPool", () => {
  it("returns localhost without claiming", async () => {
    const claim = vi.fn();
    const r = await acquireFromPool({
      platform: "x86_64-linux",
      pool: ["localhost"],
      identity: id,
      noWait: true,
      claim,
    });
    expect(r).toEqual({ host: "localhost", lease: null });
    expect(claim).not.toHaveBeenCalled();
  });

  it("picks the first free host and reports busy siblings", async () => {
    const lines: string[] = [];
    const claim = vi.fn(async (host: string): Promise<ClaimResult> => {
      if (host === "ci-1") return { kind: "busy", heldBy: null };
      if (host === "ci-2") return { kind: "busy", heldBy: null };
      return held(host);
    });
    const r = await acquireFromPool({
      platform: "x86_64-linux",
      pool: ["ci-1", "ci-2", "ci-3"],
      identity: id,
      noWait: true,
      claim,
      onLine: (m) => lines.push(m),
      rotateBy: 0,
    });
    expect(r.host).toBe("ci-3");
    expect(r.lease).not.toBeNull();
    expect(lines[0]).toMatch(/picked ci-3/);
    expect(lines[0]).toMatch(/ci-1.*busy|ci-1, ci-2 busy/);
  });

  it("--no-wait fails immediately when every host is busy", async () => {
    const claim = vi.fn(
      async (): Promise<ClaimResult> => ({
        kind: "busy",
        heldBy: {
          holder: "srid@laptop",
          run: "a1b2c3d#4",
          sinceMs: Date.now() - 6 * 60_000,
        },
      }),
    );
    await expect(
      acquireFromPool({
        platform: "aarch64-darwin",
        pool: ["rasam", "sincereintent"],
        identity: id,
        noWait: true,
        claim,
        rotateBy: 0,
      }),
    ).rejects.toThrow(/every host for aarch64-darwin is busy/);
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it("waits and retries when a host frees (no --no-wait)", async () => {
    let attempt = 0;
    const claim = vi.fn(async (host: string): Promise<ClaimResult> => {
      attempt += 1;
      if (attempt <= 2) return { kind: "busy", heldBy: null };
      return held(host);
    });
    const sleep = vi.fn(async () => {});
    const r = await acquireFromPool({
      platform: "x86_64-linux",
      pool: ["ci-1"],
      identity: id,
      noWait: false,
      claim,
      sleep,
      rotateBy: 0,
    });
    expect(r.host).toBe("ci-1");
    expect(sleep).toHaveBeenCalled();
  });

  it("fails loud when every host is unreachable (no busy to wait on)", async () => {
    const claim = vi.fn(
      async (): Promise<ClaimResult> => ({
        kind: "unreachable",
        error: "connection refused",
      }),
    );
    await expect(
      acquireFromPool({
        platform: "x86_64-linux",
        pool: ["ci-1", "ci-2"],
        identity: id,
        noWait: false,
        claim,
        rotateBy: 0,
      }),
    ).rejects.toThrow(/no reachable host/);
  });

  it("empty pool is a loud error", async () => {
    await expect(
      acquireFromPool({
        platform: "x86_64-linux",
        pool: [],
        identity: id,
        noWait: true,
      }),
    ).rejects.toThrow(/empty host pool/);
  });

  it("releases already-held leases if a later platform fails", async () => {
    // leaseLanes sorts platforms alphabetically — aarch64-darwin first.
    const releaseDarwin = vi.fn();
    const claim = vi.fn(async (host: string): Promise<ClaimResult> => {
      if (host === "mac-1") {
        return { kind: "held", lease: { host, release: releaseDarwin } };
      }
      return { kind: "unreachable", error: "down" };
    });
    await expect(
      leaseLanes({
        pools: {
          "x86_64-linux": ["linux-1"],
          "aarch64-darwin": ["mac-1"],
        },
        platforms: ["x86_64-linux", "aarch64-darwin"],
        identity: id,
        noWait: true,
        claim,
      }),
    ).rejects.toThrow(/no reachable host/);
    expect(releaseDarwin).toHaveBeenCalled();
  });
});
