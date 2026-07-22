import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentLeaseLockPath,
  claimLocal,
  parseHolderBody,
  probeLocal,
} from "./leaseHold";

const flockAvailable = (() => {
  const r = spawnSync("flock", ["--version"], { encoding: "utf8" });
  return r.error === undefined;
})();

describe("parseHolderBody", () => {
  it("parses pipe-encoded holder lines", () => {
    expect(parseHolderBody("a@b|run#1|100")).toEqual({
      holder: "a@b",
      run: "run#1",
      sinceMs: 100,
    });
  });
});

describe("agentLeaseLockPath", () => {
  it("defaults to /tmp/odu.lease", () => {
    const prev = process.env.ODU_LEASE_LOCK;
    delete process.env.ODU_LEASE_LOCK;
    expect(agentLeaseLockPath()).toBe("/tmp/odu.lease");
    expect(agentLeaseLockPath("/custom")).toBe("/custom");
    if (prev !== undefined) process.env.ODU_LEASE_LOCK = prev;
  });
});

describe.skipIf(!flockAvailable)("claimLocal / probeLocal", () => {
  it("claims, probes busy, releases to free", async () => {
    const lock = join(tmpdir(), `odu-lease-test-${process.pid}-${Date.now()}`);
    const holder = `${lock}.holder`;
    try {
      expect(probeLocal(lock).state).toBe("free");
      const c = await claimLocal(lock, { holder: "t@h", run: "abc#1" }, 1_000);
      expect(c.status).toBe("held");
      if (c.status !== "held") return;

      const p = probeLocal(lock);
      expect(p.state).toBe("busy");
      if (p.state === "busy") {
        expect(p.heldBy?.holder).toBe("t@h");
        expect(p.heldBy?.run).toBe("abc#1");
      }

      c.hold.release();
      // flock drop is prompt after stdin EOF
      await new Promise((r) => setTimeout(r, 200));
      expect(probeLocal(lock).state).toBe("free");
    } finally {
      for (const p of [lock, holder]) {
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("second concurrent claim is busy", async () => {
    const lock = join(tmpdir(), `odu-lease-busy-${process.pid}-${Date.now()}`);
    const holder = `${lock}.holder`;
    try {
      const a = await claimLocal(lock, { holder: "a@h", run: null }, 1_000);
      expect(a.status).toBe("held");
      if (a.status !== "held") return;

      const b = await claimLocal(lock, { holder: "b@h", run: null }, 1_000);
      expect(b.status).toBe("busy");

      a.hold.release();
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      for (const p of [lock, holder]) {
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
  });
});
