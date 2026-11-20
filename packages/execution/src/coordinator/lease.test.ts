import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, jest } from "bun:test";
import {
  acquireFromPool,
  failFastOptionalDisconnect,
  formatHeldFor,
  formatHolder,
  isMixedPool,
  leaseProbeIsOurs,
  leaseBurstSlots,
  leaseLanes,
  parseHolderBody,
  settleLeaseHandoff,
  slotLockPath,
  type ClaimResult,
  type LeaseIdentity,
} from "./lease";

const id: LeaseIdentity = { holder: "me@desk", run: "abc1234#1" };

it("keeps slot zero's lock identity stable when declared capacity changes", () => {
  expect(slotLockPath("/tmp/odu.lock", { host: "ci", slot: 0, slots: 1 })).toBe(
    "/tmp/odu.lock",
  );
  expect(slotLockPath("/tmp/odu.lock", { host: "ci", slot: 0, slots: 4 })).toBe(
    "/tmp/odu.lock",
  );
  expect(slotLockPath("/tmp/odu.lock", { host: "ci", slot: 2, slots: 4 })).toBe(
    "/tmp/odu.lock.2",
  );
});

it("verifies the lock belongs to this run, not merely that it is busy", () => {
  expect(
    leaseProbeIsOurs({ state: "busy", heldBy: { ...id, sinceMs: 1 } }, id),
  ).toBe(true);
  expect(
    leaseProbeIsOurs(
      {
        state: "busy",
        heldBy: { holder: "other@desk", run: "def#1", sinceMs: 1 },
      },
      id,
    ),
  ).toBe(false);
  expect(leaseProbeIsOurs({ state: "busy", heldBy: null }, id)).toBe(false);
  expect(leaseProbeIsOurs({ state: "free" }, id)).toBe(false);
});

function held(host: string): ClaimResult {
  return {
    kind: "held",
    lease: { host, release: jest.fn() },
  };
}

describe("optional burst connection policy", () => {
  it("allows a cold pin to keep making non-terminal progress", async () => {
    let observe: (phase: string) => void = () => {};
    let resolvePin: (value: string) => void = () => {};
    const pin = new Promise<string>((resolve) => {
      resolvePin = resolve;
    });
    const ready = failFastOptionalDisconnect(
      pin,
      (listener) => {
        observe = listener;
      },
      "cold-ci",
    );

    observe("provisioning");
    resolvePin("ready");
    await expect(ready).resolves.toBe("ready");
  });

  it("rejects the first actual disconnect instead of entering retry", async () => {
    let observe: (phase: string) => void = () => {};
    const ready = failFastOptionalDisconnect(
      new Promise<string>(() => {}),
      (listener) => {
        observe = listener;
      },
      "broken-ci.example.com",
    );

    observe("disconnected");
    await expect(ready).rejects.toThrow(
      /optional burst connection to broken-ci disconnected/,
    );
  });
});

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
    const claim = jest.fn();
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
    const claim = jest.fn(
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
    expect(claim).not.toHaveBeenCalled();
  });

  it("never judges a platform this run does not lease (juspay/odu#66)", async () => {
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
    const claim = jest.fn(async (host: string): Promise<ClaimResult> => {
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
    const claim = jest.fn(
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
    const claim = jest.fn(async (host: string): Promise<ClaimResult> => {
      attempt += 1;
      if (attempt <= 2) return { kind: "busy", heldBy: null };
      return held(host);
    });
    const sleep = jest.fn(async () => {});
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
    const claim = jest.fn(
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
        claim: jest.fn(),
      }),
    ).rejects.toThrow(/empty host pool/);
  });
});

describe("leaseBurstSlots", () => {
  it("takes bounded free capacity without waiting and preserves spread order", async () => {
    const calls: string[] = [];
    const releases: Array<ReturnType<typeof jest.fn>> = [];
    const leases = await leaseBurstSlots({
      platform: "x86_64-linux",
      pool: [
        { host: "ci-1", slot: 0, slots: 2 },
        { host: "ci-2", slot: 0, slots: 2 },
        { host: "ci-1", slot: 1, slots: 2 },
        { host: "ci-2", slot: 1, slots: 2 },
      ],
      identity: id,
      limit: 2,
      exclude: new Set(["ci-1#0"]),
      occupiedHosts: new Set(["ci-1"]),
      claim: async (host, _identity, slot) => {
        calls.push(`${host}#${slot?.slot}`);
        if (host === "ci-2" && slot?.slot === 0) {
          return { kind: "busy", heldBy: null };
        }
        const release = jest.fn();
        releases.push(release);
        return {
          kind: "held",
          lease: { host, slot: slot?.slot, release },
        };
      },
    });
    expect(calls).toEqual(["ci-2#0", "ci-1#1", "ci-2#1"]);
    expect(leases.map((lease) => `${lease.host}#${lease.slot}`)).toEqual([
      "ci-1#1",
      "ci-2#1",
    ]);
    expect(releases).toHaveLength(2);
  });

  it("drops a broken handoff before fixing TOTAL and continues to another slot", async () => {
    const calls: string[] = [];
    const brokenRelease = jest.fn();
    const lines: string[] = [];
    const leases = await leaseBurstSlots({
      platform: "x86_64-linux",
      pool: ["ci-broken", "ci-good-1", "ci-good-2"],
      identity: id,
      limit: 2,
      onLine: (line) => lines.push(line),
      claim: async (host) => {
        calls.push(host);
        return {
          kind: "held" as const,
          lease: {
            host,
            release: host === "ci-broken" ? brokenRelease : jest.fn(),
            verifyHeld: async () => host !== "ci-broken",
          },
        };
      },
    });

    expect(calls).toEqual(["ci-broken", "ci-good-1", "ci-good-2"]);
    expect(leases.map((lease) => lease.host)).toEqual(["ci-good-1", "ci-good-2"]);
    expect(brokenRelease).toHaveBeenCalledTimes(1);
    expect(lines).toContain(
      "x86_64-linux: skipped broken burst slot ci-broken#1 during handoff",
    );
  });

  it("treats a rejected optional claim as one broken slot, not a leaked batch", async () => {
    const release = jest.fn();
    const leases = await leaseBurstSlots({
      platform: "x86_64-linux",
      pool: ["ci-good", "ci-throws"],
      identity: id,
      limit: 2,
      claim: async (host) => {
        if (host === "ci-throws") throw new Error("ssh exploded");
        return {
          kind: "held" as const,
          lease: { host, release, verifyHeld: async () => true },
        };
      },
    });

    expect(leases.map(({ host }) => host)).toEqual(["ci-good"]);
    expect(release).not.toHaveBeenCalled();
  });
});

describe("settleLeaseHandoff", () => {
  it("promotes a surviving burst lease when the primary dies during cold provisioning", async () => {
    const brokenRelease = jest.fn();
    const promotedRelease = jest.fn();
    const otherRelease = jest.fn();
    const handoff = await settleLeaseHandoff(
      {
        host: "primary-broke",
        release: brokenRelease,
        verifyHeld: async () => false,
      },
      [
        {
          host: "burst-1",
          release: promotedRelease,
          verifyHeld: async () => true,
        },
        {
          host: "burst-2",
          release: otherRelease,
          verifyHeld: async () => true,
        },
      ],
    );

    expect(handoff?.primary.host).toBe("burst-1");
    expect(handoff?.extras.map((lease) => lease.host)).toEqual(["burst-2"]);
    expect(brokenRelease).toHaveBeenCalledTimes(1);
    expect(promotedRelease).not.toHaveBeenCalled();
    expect(otherRelease).not.toHaveBeenCalled();
  });

  it("returns null when no claimed lane survives the handoff", async () => {
    const release = jest.fn();
    const handoff = await settleLeaseHandoff({
      host: "only-broken-lane",
      release,
      verifyHeld: async () => false,
    }, []);

    expect(handoff).toBeNull();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("leaseLanes", () => {
  it("REFUSES a mixed pool on a LATER platform even while an earlier one is busy", async () => {
    const claim = jest.fn(
      async (): Promise<ClaimResult> => ({ kind: "busy", heldBy: null }),
    );
    const sleep = jest.fn(async () => {});
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
    const claim = jest.fn(async (host: string): Promise<ClaimResult> => held(host));
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
    const releaseDarwin = jest.fn();
    const claim = jest.fn(async (host: string): Promise<ClaimResult> => {
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
    const releaseDarwin = jest.fn();
    let pass = 0;
    const claim = jest.fn(async (host: string): Promise<ClaimResult> => {
      if (host === "mac-1") {
        return {
          kind: "held",
          lease: { host, release: releaseDarwin },
        };
      }
      if (pass === 0) return { kind: "busy", heldBy: null };
      return held(host);
    });
    const sleep = jest.fn(async () => {
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
    const claim = jest.fn(async (host: string): Promise<ClaimResult> => held(host));
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
    const claim = jest.fn(async (host: string): Promise<ClaimResult> => held(host));
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
    const claim = jest.fn(async (host: string): Promise<ClaimResult> => held(host));
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
    const claim = jest.fn();
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
    const claim = jest.fn(async (host: string): Promise<ClaimResult> => held(host));
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
    const claim = jest.fn(async (host: string): Promise<ClaimResult> => held(host));
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
    const claim = jest.fn(async (host: string): Promise<ClaimResult> => held(host));
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
  it("is true only when localhost sits beside a remote", () => {
    expect(isMixedPool(["ci-1", "localhost"])).toBe(true);
    expect(isMixedPool(["localhost", "nix@ci-2.example"])).toBe(true);
  });

  it("is false for the two legal shapes", () => {
    expect(isMixedPool(["localhost"])).toBe(false);
    expect(isMixedPool(["ci-1", "ci-2", "ci-3"])).toBe(false);
  });
});

describe("the wait poll holds the process open", () => {
  const leaseModule = join(import.meta.dir, "lease.ts");
  const POLL_MS = 250;

  function runAlone(body: string): {
    status: number | null;
    stdout: string;
    stderr: string;
    elapsedMs: number;
  } {
    const dir = mkdtempSync(join(tmpdir(), "odu-lease-waitpoll-"));
    try {
      const file = join(dir, "waiter.ts");
      writeFileSync(file, body);
      const started = Date.now();
      const r = spawnSync(process.execPath, [file], {
        encoding: "utf8",
        env: { ...process.env, ODU_LEASE_WAIT_POLL_MS: String(POLL_MS) },
        timeout: 30_000,
      });
      return {
        status: r.status,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        elapsedMs: Date.now() - started,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const claimSource = (busyHost: string) => `
    let looks = 0;
    const claim = async (host) => {
      if (host === ${JSON.stringify(busyHost)}) {
        looks += 1;
        if (looks === 1) return { kind: "busy", heldBy: null };
      }
      return { kind: "held", lease: { host, release() {} } };
    };
  `;

  const drive = (call: string) => `
    async function main() {
      const r = await ${call};
      console.log("WAITED-THEN-ACQUIRED", JSON.stringify(r.lanes ?? r.host));
    }
    main().then(
      () => process.exit(0),
      (e) => { console.error(e); process.exit(1); },
    );
  `;

  it("leaseLanes polls again after releasing partial holds", () => {
    const r = runAlone(`
      import { leaseLanes } from ${JSON.stringify(leaseModule)};
      ${claimSource("linux-1")}
      ${drive(`leaseLanes({
        pools: {
          hosts: { "x86_64-linux": ["linux-1"], "aarch64-darwin": ["mac-1"] },
          source: null,
        },
        platforms: ["x86_64-linux", "aarch64-darwin"],
        identity: { holder: "me@desk", run: null },
        noWait: false,
        claim,
      })`)}
    `);

    expect(`${r.stdout}${r.stderr}`).toContain("WAITED-THEN-ACQUIRED");
    expect(r.status).toBe(0);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(POLL_MS);
  }, 30_000);

  it("acquireFromPool polls again while its only host is busy", () => {
    const r = runAlone(`
      import { acquireFromPool } from ${JSON.stringify(leaseModule)};
      ${claimSource("ci-1")}
      ${drive(`acquireFromPool({
        platform: "x86_64-linux",
        pool: ["ci-1"],
        identity: { holder: "me@desk", run: null },
        noWait: false,
        source: null,
        claim,
        rotateBy: 0,
      })`)}
    `);

    expect(`${r.stdout}${r.stderr}`).toContain("WAITED-THEN-ACQUIRED");
    expect(r.status).toBe(0);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(POLL_MS);
  }, 30_000);
});
