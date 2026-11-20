import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEASE_RECORD_PATH,
  type PlatformLeaseRecord,
  readLeaseRecord,
} from "@odu/execution/coordinator/leaseRecord";
import { LOCAL_OWNER } from "@odu/cordis/principal";
import { holdVenue, probeVenues, releaseVenue } from "./venuePort";

const trash: string[] = [];
const strays: ChildProcess[] = [];
const HOSTS_WAS = process.env.ODU_HOSTS;
const BUILD_WAS = {
  SURFACE_AGENT_FLAKE_REF: process.env.SURFACE_AGENT_FLAKE_REF,
};

process.env.SURFACE_AGENT_FLAKE_REF = "path:/nonexistent";

afterEach(() => {
  for (const child of strays.splice(0)) child.kill("SIGKILL");
  for (const dir of trash.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (HOSTS_WAS === undefined) delete process.env.ODU_HOSTS;
  else process.env.ODU_HOSTS = HOSTS_WAS;
});

// Restored once, not per test: the suite needs them set throughout, and bun may
// share this process with another test file that does not.
afterAll(() => {
  for (const [key, was] of Object.entries(BUILD_WAS)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

function hosts(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-venue-hosts-"));
  trash.push(dir);
  const file = join(dir, "hosts.json");
  writeFileSync(file, JSON.stringify(config));
  process.env.ODU_HOSTS = file;
  return file;
}

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-venue-checkout-"));
  trash.push(dir);
  return dir;
}

function stranger(): number {
  const child = spawn("sh", ["-c", "sleep 60"], { stdio: "ignore" });
  strays.push(child);
  if (child.pid === undefined) throw new Error("could not fork a stand-in holder");
  return child.pid;
}

function writeRecord(
  repoRoot: string,
  record: Record<string, PlatformLeaseRecord>,
): void {
  mkdirSync(join(repoRoot, ".ci"), { recursive: true });
  writeFileSync(join(repoRoot, LEASE_RECORD_PATH), JSON.stringify(record));
}

describe("probeVenues", () => {
  it("REFUSES an inventory of nothing, naming the file that decided it", async () => {
    const file = hosts({});
    const outcome = await probeVenues({ platforms: [], caller: { hostsFile: null, principal: LOCAL_OWNER } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain(file);
    expect(outcome.message).toContain("no hosts configured");
  });

  it("answers with a row per venue, and no warnings for a clean config", async () => {
    const file = hosts({ "x86_64-linux": "localhost" });
    const outcome = await probeVenues({ platforms: [], caller: { hostsFile: null, principal: LOCAL_OWNER } });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.source).toBe(file);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.rows).toHaveLength(1);
    const row = outcome.rows[0];
    expect(row?.platform).toBe("x86_64-linux");
    expect(row?.state).toBe("local");
    expect(row?.heldBy).toBeNull();
    expect(row?.error).toBeNull();
    expect(row?.slots).toBe(1);
  });

  it("reports a mixed pool as a WARNING and still answers", async () => {
    const file = hosts({ "x86_64-linux": ["localhost", "nope.invalid"] });
    const outcome = await probeVenues({ platforms: [], caller: { hostsFile: null, principal: LOCAL_OWNER } });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain(file);
    expect(outcome.warnings[0]).toContain("mixes localhost with remote hosts");
    expect(outcome.rows).toHaveLength(2);
  });

  it("says `down`, not `unreachable`, and keeps the probe's own sentence", async () => {
    hosts({ "x86_64-linux": "nope.invalid" });
    const outcome = await probeVenues({ platforms: [], caller: { hostsFile: null, principal: LOCAL_OWNER } });
    if (!outcome.ok) throw new Error(outcome.message);
    const row = outcome.rows[0];
    expect(row?.state).toBe("down");
    expect(row?.error).not.toBeNull();
    expect(row?.heldBy).toBeNull();
  });

  it("dials only the platforms asked for, and leaves the rest alone", async () => {
    hosts({ "x86_64-linux": "localhost", "aarch64-darwin": "nope.invalid" });
    const outcome = await probeVenues({ platforms: ["x86_64-linux"], caller: { hostsFile: null, principal: LOCAL_OWNER } });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.rows).toHaveLength(1);
    expect(outcome.rows[0]?.platform).toBe("x86_64-linux");
    expect(outcome.warnings).toEqual([]);
  });

  it("REFUSES when nothing the caller named is configured, listing what is", async () => {
    hosts({ "x86_64-linux": "localhost" });
    const outcome = await probeVenues({ platforms: ["x86_54-linux"], caller: { hostsFile: null, principal: LOCAL_OWNER } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("x86_54-linux");
    expect(outcome.message).toContain("x86_64-linux");
  });

  it("answers the answerable part when only SOME named platforms exist", async () => {
    hosts({ "x86_64-linux": "localhost" });
    const outcome = await probeVenues({
      platforms: ["x86_64-linux", "riscv64-linux"], caller: { hostsFile: null, principal: LOCAL_OWNER },
    });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.rows).toHaveLength(1);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain("riscv64-linux");
  });
});

describe("holdVenue", () => {
  it("refuses a platform no hosts file declares, listing the ones that are", async () => {
    hosts({ "x86_64-linux": "localhost" });
    const outcome = await holdVenue({
      checkout: checkout(),
      platforms: ["aarch64-darwin"], caller: { hostsFile: null, principal: LOCAL_OWNER },
      noWait: true,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("aarch64-darwin");
    expect(outcome.message).toContain("--host");
  });

  it("refuses an empty inventory rather than holding nothing successfully", async () => {
    const file = hosts({});
    const outcome = await holdVenue({
      checkout: checkout(),
      platforms: [], caller: { hostsFile: null, principal: LOCAL_OWNER },
      noWait: true,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("no hosts configured");
    expect(outcome.message).toContain(file);
  });

  it("sees a hold whose holder is in ANOTHER process tree, and spawns nothing", async () => {
    hosts({ "x86_64-linux": "some-box" });
    const repo = checkout();
    const pid = stranger();
    writeRecord(repo, {
      "x86_64-linux": {
        host: "some-box",
        holderPid: pid,
        since: Date.now(),
        state: "held",
        waitingBehind: null,
        run: `lease-hold:${pid}`,
      },
    });

    const outcome = await holdVenue({
      checkout: repo,
      platforms: ["x86_64-linux"], caller: { hostsFile: null, principal: LOCAL_OWNER },
      noWait: true,
    });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.results).toHaveLength(1);
    const result = outcome.results[0];
    expect(result?.status).toBe("already");
    expect(result?.host).toBe("some-box");
    expect(result?.holderPid).toBe(pid);
    expect(readLeaseRecord(repo)["x86_64-linux"]?.holderPid).toBe(pid);
  });
});

describe("releaseVenue", () => {
  it("answers `nothing` for a checkout that holds nothing", async () => {
    const { results } = await releaseVenue({
      checkout: checkout(),
      platforms: ["x86_64-linux"], caller: { hostsFile: null, principal: LOCAL_OWNER },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.effective).toBe("nothing");
    expect(results[0]?.detail).toContain("no lease record");
  });

  it("releases every held platform when the caller names none", async () => {
    const repo = checkout();
    const pid = stranger();
    writeRecord(repo, {
      "x86_64-linux": {
        host: "some-box",
        holderPid: pid,
        since: Date.now(),
        state: "held",
        waitingBehind: null,
        run: null,
      },
    });

    const { results } = await releaseVenue({ checkout: repo, platforms: [], caller: { hostsFile: null, principal: LOCAL_OWNER } });
    expect(results).toHaveLength(1);
    expect(results[0]?.effective).toBe("released");
    expect(results[0]?.host).toBe("some-box");
    expect(results[0]?.detail).toContain(String(pid));
    expect(readLeaseRecord(repo)["x86_64-linux"]).toBeUndefined();
  });

  it("treats a record whose holder died as nothing to release", async () => {
    const repo = checkout();
    const child = spawn("sh", ["-c", "exit 0"], { stdio: "ignore" });
    const pid = child.pid ?? 0;
    await new Promise<void>((r) => child.once("exit", () => r()));
    writeRecord(repo, {
      "x86_64-linux": {
        host: "some-box",
        holderPid: pid,
        since: Date.now(),
        state: "held",
        waitingBehind: null,
        run: null,
      },
    });

    const { results } = await releaseVenue({
      checkout: repo,
      platforms: ["x86_64-linux"], caller: { hostsFile: null, principal: LOCAL_OWNER },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.effective).toBe("nothing");
    expect(readLeaseRecord(repo)["x86_64-linux"]).toBeUndefined();
  });
});
