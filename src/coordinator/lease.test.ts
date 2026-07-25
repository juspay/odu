import { describe, expect, it, vi } from "vitest";
import {
  acquireFromPool,
  formatHeldFor,
  formatHolder,
  isMixedPool,
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
      source: null,
      claim,
    });
    expect(r).toEqual({ host: "localhost", lease: null });
    expect(claim).not.toHaveBeenCalled();
  });

  it("REFUSES a mixed pool at the lease entry, naming the hosts file (juspay/odu#54, #66)", async () => {
    // This test used to assert the opposite — that the scan picked localhost
    // once the remotes came back busy. That IS the #54 defect: localhost is
    // lease-exempt, so it read as always-free and starved every busy remote.
    // The rule is judged once at this entry, over the one pool this call
    // leases, and the localhost-beside-remotes branch is gone from the scan
    // rather than special-cased.
    const claim = vi.fn(
      async (): Promise<ClaimResult> => ({ kind: "busy", heldBy: null }),
    );
    await expect(
      acquireFromPool({
        platform: "x86_64-linux",
        pool: ["ci-1", "localhost"],
        identity: id,
        noWait: true,
        source: "/home/me/.config/odu/hosts.json",
        claim,
        rotateBy: 0,
      }),
    ).rejects.toThrow(
      /\/home\/me\/\.config\/odu\/hosts\.json: host pool for "x86_64-linux" must not mix localhost with remote hosts/,
    );
    // Refused before any claim: no remote is dialed to learn the pool is illegal.
    expect(claim).not.toHaveBeenCalled();
  });

  it("never judges a platform this run does not lease (juspay/odu#66)", async () => {
    // The regression the whole issue is about, at the seam that now owns the
    // rule: an illegal x86_64-linux pool sits in the same (machine-global)
    // hosts file, but this call leases aarch64-darwin. `acquireFromPool` is
    // handed exactly one pool, so the linux pool cannot possibly refuse this
    // run — by construction, not by convention.
    const r = await acquireFromPool({
      platform: "aarch64-darwin",
      pool: ["rasam"],
      identity: id,
      noWait: true,
      source: "/home/me/.config/odu/hosts.json",
      claim: async (host) => held(host),
      rotateBy: 0,
    });
    expect(r.host).toBe("rasam");
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
      source: null,
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
        pool: ["mac-1"],
        identity: id,
        noWait: true,
        source: null,
        claim,
      }),
    ).rejects.toThrow(/every host for aarch64-darwin is busy/);
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
      source: null,
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
        source: null,
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
        source: null,
        claim: vi.fn(),
      }),
    ).rejects.toThrow(/empty host pool/);
  });
});

describe("leaseLanes", () => {
  it("REFUSES a mixed pool on a LATER platform even while an earlier one is busy", async () => {
    // The reason legality is judged at the entry rather than in the poll loop.
    // `platforms` is sorted alphabetically and the loop breaks on the first
    // blocked platform, so a per-scan assert for `x86_64-linux` was never
    // reached while `aarch64-darwin` stayed busy: with the default
    // `noWait: false` the operator waited forever instead of being told the
    // config is illegal. Judged at the entry the refusal is deterministic —
    // it does not depend on alphabetical order or on who happens to be busy.
    const claim = vi.fn(
      async (): Promise<ClaimResult> => ({ kind: "busy", heldBy: null }),
    );
    const sleep = vi.fn(async () => {});
    await expect(
      leaseLanes({
        pools: {
          hosts: {
            "aarch64-darwin": ["mac-1"],
            "x86_64-linux": ["ci-1", "localhost"],
          },
          source: "/home/me/.config/odu/hosts.json",
        },
        platforms: ["aarch64-darwin", "x86_64-linux"],
        identity: id,
        noWait: false,
        claim,
        sleep,
      }),
    ).rejects.toThrow(
      /\/home\/me\/\.config\/odu\/hosts\.json: host pool for "x86_64-linux" must not mix localhost with remote hosts/,
    );
    expect(claim).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("never judges a platform this run does not lease (juspay/odu#66)", async () => {
    // The mixed x86_64-linux pool is in the same machine-global hosts file,
    // but this run claims only darwin — `platforms` IS the run's lease set, so
    // the illegal pool is none of its business and must not refuse it.
    const claim = vi.fn(async (host: string): Promise<ClaimResult> => held(host));
    const r = await leaseLanes({
      pools: {
        hosts: {
          "aarch64-darwin": ["mac-1"],
          "x86_64-linux": ["ci-1", "localhost"],
        },
        source: "/home/me/.config/odu/hosts.json",
      },
      platforms: ["aarch64-darwin"],
      identity: id,
      noWait: true,
      claim,
    });
    expect(r.lanes).toEqual({ "aarch64-darwin": "mac-1" });
  });

  it("releases already-held leases if a later platform fails", async () => {
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
          hosts: {
            "x86_64-linux": ["linux-1"],
            "aarch64-darwin": ["mac-1"],
          },
          source: null,
        },
        platforms: ["x86_64-linux", "aarch64-darwin"],
        identity: id,
        noWait: true,
        claim,
      }),
    ).rejects.toThrow(/no reachable host/);
    expect(releaseDarwin).toHaveBeenCalled();
  });

  it("multi-platform: does not hold early platforms while waiting on a busy later one", async () => {
    const releaseDarwin = vi.fn();
    let pass = 0;
    const claim = vi.fn(async (host: string): Promise<ClaimResult> => {
      if (host === "mac-1") {
        return {
          kind: "held",
          lease: { host, release: releaseDarwin },
        };
      }
      if (pass === 0) return { kind: "busy", heldBy: null };
      return held(host);
    });
    const sleep = vi.fn(async () => {
      pass += 1;
    });
    const r = await leaseLanes({
      pools: {
        hosts: {
          "x86_64-linux": ["linux-1"],
          "aarch64-darwin": ["mac-1"],
        },
        source: null,
      },
      platforms: ["x86_64-linux", "aarch64-darwin"],
      identity: id,
      noWait: false,
      claim,
      sleep,
    });
    expect(r.lanes).toEqual({
      "aarch64-darwin": "mac-1",
      "x86_64-linux": "linux-1",
    });
    expect(releaseDarwin).toHaveBeenCalled();
    expect(sleep).toHaveBeenCalled();
    expect(r.leases.length).toBe(2);
  });

  it("rejects when two platforms list the same remote host (self-livelock)", async () => {
    const claim = vi.fn(async (host: string): Promise<ClaimResult> => held(host));
    await expect(
      leaseLanes({
        pools: {
          hosts: {
            "x86_64-linux": ["shared-builder"],
            "aarch64-linux": ["shared-builder"],
          },
          source: null,
        },
        platforms: ["x86_64-linux", "aarch64-linux"],
        identity: id,
        noWait: false,
        claim,
      }),
    ).rejects.toThrow(
      /shared-builder.*both.*x86_64-linux.*aarch64-linux|both.*aarch64-linux.*x86_64-linux/,
    );
    expect(claim).not.toHaveBeenCalled();
  });

  it("rejects user@host vs bare host across platforms (same machine lock)", async () => {
    const claim = vi.fn(async (host: string): Promise<ClaimResult> => held(host));
    await expect(
      leaseLanes({
        pools: {
          hosts: {
            "x86_64-linux": ["nix@ci-1"],
            "aarch64-linux": ["ci-1"],
          },
          source: null,
        },
        platforms: ["x86_64-linux", "aarch64-linux"],
        identity: id,
        noWait: false,
        claim,
      }),
    ).rejects.toThrow(/ci-1.*both/);
    expect(claim).not.toHaveBeenCalled();
  });

  it("rejects different users on the same host across platforms", async () => {
    const claim = vi.fn(async (host: string): Promise<ClaimResult> => held(host));
    await expect(
      leaseLanes({
        pools: {
          hosts: {
            "x86_64-linux": ["nix@ci-1"],
            "aarch64-linux": ["root@ci-1"],
          },
          source: null,
        },
        platforms: ["x86_64-linux", "aarch64-linux"],
        identity: id,
        noWait: false,
        claim,
      }),
    ).rejects.toThrow(/ci-1.*both/);
    expect(claim).not.toHaveBeenCalled();
  });

  it("allows the same localhost string across platforms (lease-exempt)", async () => {
    const claim = vi.fn();
    const r = await leaseLanes({
      pools: {
        hosts: {
          "x86_64-linux": ["localhost"],
          "aarch64-darwin": ["localhost"],
        },
        source: null,
      },
      platforms: ["x86_64-linux", "aarch64-darwin"],
      identity: id,
      noWait: true,
      claim,
    });
    expect(r.lanes).toEqual({
      "aarch64-darwin": "localhost",
      "x86_64-linux": "localhost",
    });
    expect(r.leases).toEqual([]);
    expect(claim).not.toHaveBeenCalled();
  });

  it("rejects short name vs FQDN for the same machine across platforms", async () => {
    const claim = vi.fn(async (host: string): Promise<ClaimResult> => held(host));
    await expect(
      leaseLanes({
        pools: {
          hosts: {
            "x86_64-linux": ["ci-1"],
            "aarch64-linux": ["ci-1.example.com"],
          },
          source: null,
        },
        platforms: ["x86_64-linux", "aarch64-linux"],
        identity: id,
        noWait: false,
        claim,
      }),
    ).rejects.toThrow(/ci-1.*both/);
    expect(claim).not.toHaveBeenCalled();
  });

  it("rejects user@short vs bare FQDN aliases", async () => {
    const claim = vi.fn(async (host: string): Promise<ClaimResult> => held(host));
    await expect(
      leaseLanes({
        pools: {
          hosts: {
            "x86_64-linux": ["nix@ci-1.lab.example.com"],
            "aarch64-linux": ["ci-1"],
          },
          source: null,
        },
        platforms: ["x86_64-linux", "aarch64-linux"],
        identity: id,
        noWait: false,
        claim,
      }),
    ).rejects.toThrow(/ci-1.*both/);
    expect(claim).not.toHaveBeenCalled();
  });

  it("does not collapse distinct IPv4 targets via first-dot split", async () => {
    const claim = vi.fn(async (host: string): Promise<ClaimResult> => held(host));
    const r = await leaseLanes({
      pools: {
        hosts: {
          "x86_64-linux": ["10.0.0.1"],
          "aarch64-linux": ["10.0.0.2"],
        },
        source: null,
      },
      platforms: ["x86_64-linux", "aarch64-linux"],
      identity: id,
      noWait: true,
      claim,
    });
    expect(r.lanes).toEqual({
      "aarch64-linux": "10.0.0.2",
      "x86_64-linux": "10.0.0.1",
    });
  });
});

describe("isMixedPool — the shape the lease seam refuses", () => {
  // Exported so `odu hosts` can WARN about an illegal pool without refusing
  // over it: the inventory view never leases, and refusing there would be
  // juspay/odu#66 again — a run stopped over a platform it never touches.
  it("is true only when localhost sits beside a remote", () => {
    expect(isMixedPool(["ci-1", "localhost"])).toBe(true);
    expect(isMixedPool(["localhost", "nix@ci-2.example"])).toBe(true);
  });

  it("is false for the two legal shapes", () => {
    expect(isMixedPool(["localhost"])).toBe(false);
    expect(isMixedPool(["ci-1", "ci-2", "ci-3"])).toBe(false);
  });
});
