import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  heldHostForPlatform,
  pidAlive,
  readLeaseRecord,
  reconcileLeaseRecord,
  removePlatformLease,
  upsertPlatformLease,
} from "./leaseRecord";

describe("leaseRecord", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function root(): string {
    const r = mkdtempSync(join(tmpdir(), "odu-lease-rec-"));
    roots.push(r);
    return r;
  }

  it("pidAlive recognizes this process", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(999_999_999)).toBe(false);
  });

  it("upsert / heldHost / remove round-trip for a live holder", () => {
    const repo = root();
    upsertPlatformLease(repo, "x86_64-linux", {
      host: "ci-1",
      holderPid: process.pid,
      since: Date.now(),
      state: "held",
      waitingBehind: null,
      run: "lease-hold:1",
    });
    expect(heldHostForPlatform(repo, "x86_64-linux")).toBe("ci-1");
    expect(readLeaseRecord(repo)["x86_64-linux"]?.state).toBe("held");

    removePlatformLease(repo, "x86_64-linux");
    expect(heldHostForPlatform(repo, "x86_64-linux")).toBeNull();
  });

  it("reconcile drops dead holder pids", () => {
    const repo = root();
    upsertPlatformLease(repo, "x86_64-linux", {
      host: "ci-1",
      holderPid: 999_999_999,
      since: Date.now(),
      state: "held",
      waitingBehind: null,
      run: null,
    });
    const { record, changed } = reconcileLeaseRecord(repo);
    expect(changed).toBe(true);
    expect(record["x86_64-linux"]).toBeUndefined();
    expect(heldHostForPlatform(repo, "x86_64-linux")).toBeNull();
  });

  it("waiting state is not returned by heldHostForPlatform", () => {
    const repo = root();
    upsertPlatformLease(repo, "aarch64-darwin", {
      host: null,
      holderPid: process.pid,
      since: Date.now(),
      state: "waiting",
      waitingBehind: {
        holder: "a@b",
        run: "r#1",
        sinceMs: Date.now() - 60_000,
      },
      run: null,
    });
    expect(heldHostForPlatform(repo, "aarch64-darwin")).toBeNull();
    expect(readLeaseRecord(repo)["aarch64-darwin"]?.state).toBe("waiting");
  });
});
