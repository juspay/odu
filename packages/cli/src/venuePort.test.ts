/**
 * THE VENUE PORTS — the refusals, and the one invariant the move broke if it
 * broke anything.
 *
 * Two things are worth a suite here.
 *
 * The first is the refusal shape. "No hosts are configured" and "every host is
 * busy" are the same empty table and opposite actions — write a hosts file
 * versus wait — so the first is `ok: false` and the second is `ok: true` with
 * no free row. A face that got an empty list for both would tell an operator to
 * wait for machines that do not exist.
 *
 * The second is the one this PR actually put at risk. `odu lease` used to fork
 * its holder from the operator's shell; through the service the holder is the
 * DAEMON's child, so `holderPid` in `.ci/odu-lease.json` is now a pid in a
 * different process tree. Three readers depend on that pid — `pidAlive`,
 * `heldHostForPlatform` (which the COORDINATOR consults at run time to consume
 * an agent's hold) and `releaseVenues` — and all three would have failed
 * silently, as "your hold vanished", if that pid had stopped meaning anything.
 * The tests below use a real, unrelated child process for exactly that reason:
 * a pid this test's own tree did not parent is the case that matters, and
 * `process.pid` would have proved nothing.
 */

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
import { holdVenue, probeVenues, releaseVenue } from "./venuePort";

const trash: string[] = [];
const strays: ChildProcess[] = [];
const HOSTS_WAS = process.env.ODU_HOSTS;
const BUILD_WAS = {
  ODU_RUNNER_FLAKE: process.env.ODU_RUNNER_FLAKE,
  ODU_AGENT_SUBSTITUTERS: process.env.ODU_AGENT_SUBSTITUTERS,
  ODU_AGENT_TRUSTED_PUBLIC_KEYS: process.env.ODU_AGENT_TRUSTED_PUBLIC_KEYS,
};

// The probe builds a runner resolver per venue before it knows the venue is
// local, and that resolver refuses an unset flake or binary cache as a MISBUILT
// PACKAGE rather than a mode. A real `odu` carries all three baked onto its
// wrapper; a bun test process does not, so the suite supplies them. The flake
// deliberately does not exist: nothing below is meant to provision, and a
// pointer that resolves would let a slip reach the network.
process.env.ODU_RUNNER_FLAKE = "path:/nonexistent#odu-runner";
process.env.ODU_AGENT_SUBSTITUTERS = "https://cache.invalid";
process.env.ODU_AGENT_TRUSTED_PUBLIC_KEYS = "cache.invalid-1:AAAA";

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

/** Point `loadHosts` at exactly this inventory, hermetically — the dev
 *  machine's own `~/.config/odu/hosts.json` must never decide a test. */
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

/**
 * A live process this test did not fork from itself in any meaningful sense —
 * the stand-in for a holder the daemon parented. It is a real pid: `pidAlive`
 * signals it, and `releaseVenues` can actually kill it.
 */
function stranger(): number {
  const child = spawn("sh", ["-c", "sleep 60"], { stdio: "ignore" });
  strays.push(child);
  if (child.pid === undefined) throw new Error("could not fork a stand-in holder");
  return child.pid;
}

/** Write `.ci/odu-lease.json` by hand, in the format and at the location the
 *  holder, the coordinator and `odu release` all already agree on — which this
 *  change deliberately did not move. */
function writeRecord(
  repoRoot: string,
  record: Record<string, PlatformLeaseRecord>,
): void {
  mkdirSync(join(repoRoot, ".ci"), { recursive: true });
  writeFileSync(join(repoRoot, LEASE_RECORD_PATH), JSON.stringify(record));
}

describe("probeVenues", () => {
  it("REFUSES an inventory of nothing, naming the file that decided it", async () => {
    // Not `ok: true` with zero rows: a face showing an empty table would tell
    // the operator to wait for machines nobody has declared.
    const file = hosts({});
    const outcome = await probeVenues({ platforms: [] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain(file);
    expect(outcome.message).toContain("no hosts configured");
  });

  it("answers with a row per venue, and no warnings for a clean config", async () => {
    const file = hosts({ "x86_64-linux": "localhost" });
    const outcome = await probeVenues({ platforms: [] });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.source).toBe(file);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.rows).toHaveLength(1);
    const row = outcome.rows[0];
    expect(row?.platform).toBe("x86_64-linux");
    // A local venue is never leased — the checkout socket already serializes
    // local runs — so it reports `local` rather than free or busy.
    expect(row?.state).toBe("local");
    expect(row?.heldBy).toBeNull();
    // Known to be fine, not "no error field": absence and zero stay apart.
    expect(row?.error).toBeNull();
    expect(row?.slots).toBe(1);
  });

  it("reports a mixed pool as a WARNING and still answers", async () => {
    // juspay/odu#66: refusing here would refuse an inventory over a pool the
    // operator is not running. It is this view's business to report the rule,
    // not to enforce it — and through the service the report cannot be stderr,
    // because there is no terminal attached to a browser.
    const file = hosts({ "x86_64-linux": ["localhost", "nope.invalid"] });
    const outcome = await probeVenues({ platforms: [] });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain(file);
    expect(outcome.warnings[0]).toContain("mixes localhost with remote hosts");
    expect(outcome.rows).toHaveLength(2);
  });

  it("says `down`, not `unreachable`, and keeps the probe's own sentence", async () => {
    // The rename `odu hosts` has always made, carried into the port rather than
    // repeated at each face — three faces choosing three words for one state is
    // how a vocabulary stops being shared. Nothing is lost by the shorter
    // label: `error` on the same row is where the reason lives.
    hosts({ "x86_64-linux": "nope.invalid" });
    const outcome = await probeVenues({ platforms: [] });
    if (!outcome.ok) throw new Error(outcome.message);
    const row = outcome.rows[0];
    expect(row?.state).toBe("down");
    expect(row?.error).not.toBeNull();
    expect(row?.heldBy).toBeNull();
  });

  it("dials only the platforms asked for, and leaves the rest alone", async () => {
    // The filter has to bite BEFORE the dial, not after: a probe ssh's every
    // machine, so filtering the rows afterwards would still cost the round trip
    // this exists to avoid. `nope.invalid` is unreachable and would show as a
    // `down` row if it had been probed at all — its absence is the assertion.
    hosts({ "x86_64-linux": "localhost", "aarch64-darwin": "nope.invalid" });
    const outcome = await probeVenues({ platforms: ["x86_64-linux"] });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.rows).toHaveLength(1);
    expect(outcome.rows[0]?.platform).toBe("x86_64-linux");
    expect(outcome.warnings).toEqual([]);
  });

  it("REFUSES when nothing the caller named is configured, listing what is", async () => {
    // A typo must not read as an empty fleet: zero rows cannot say whether the
    // machines are missing or the name is, and the two have opposite fixes.
    hosts({ "x86_64-linux": "localhost" });
    const outcome = await probeVenues({ platforms: ["x86_54-linux"] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("x86_54-linux");
    expect(outcome.message).toContain("x86_64-linux");
  });

  it("answers the answerable part when only SOME named platforms exist", async () => {
    // Refusing the whole request over one typo would throw away an answer the
    // caller can use; a warning names the part that went unprobed.
    hosts({ "x86_64-linux": "localhost" });
    const outcome = await probeVenues({
      platforms: ["x86_64-linux", "riscv64-linux"],
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
      platforms: ["aarch64-darwin"],
      noWait: true,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The engine's own sentence — it knows the platform has no host and what
    // the operator can pass instead; this layer only has to not swallow it.
    expect(outcome.message).toContain("aarch64-darwin");
    expect(outcome.message).toContain("--host");
  });

  it("refuses an empty inventory rather than holding nothing successfully", async () => {
    // `{ ok: true, results: [] }` would read to a face as "held everything you
    // asked for", which is exactly true and completely wrong.
    const file = hosts({});
    const outcome = await holdVenue({
      checkout: checkout(),
      platforms: [],
      noWait: true,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("no hosts configured");
    expect(outcome.message).toContain(file);
  });

  it("sees a hold whose holder is in ANOTHER process tree, and spawns nothing", async () => {
    // The daemon-parenting change in one assertion. The record names a pid this
    // process did not fork; `heldHostForPlatform` must still read it as held,
    // or every hold taken through the service would look vanished to the very
    // next caller — and to the coordinator, which consults the same function
    // at run time to consume the hold.
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
      platforms: ["x86_64-linux"],
      noWait: true,
    });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.results).toHaveLength(1);
    const result = outcome.results[0];
    expect(result?.status).toBe("already");
    expect(result?.host).toBe("some-box");
    expect(result?.holderPid).toBe(pid);
    // The record is untouched — asking for a hold you already have must not
    // fork a second holder onto the same box.
    expect(readLeaseRecord(repo)["x86_64-linux"]?.holderPid).toBe(pid);
  });
});

describe("releaseVenue", () => {
  it("answers `nothing` for a checkout that holds nothing", async () => {
    // No refusal arm on purpose: releasing what is not held is what a caller
    // who lost the first reply will do, and it must be safe.
    const { results } = await releaseVenue({
      checkout: checkout(),
      platforms: ["x86_64-linux"],
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

    const { results } = await releaseVenue({ checkout: repo, platforms: [] });
    expect(results).toHaveLength(1);
    expect(results[0]?.effective).toBe("released");
    expect(results[0]?.host).toBe("some-box");
    expect(results[0]?.detail).toContain(String(pid));
    // Our side of the record goes whatever the holder does, so a second release
    // is a no-op rather than a second signal at a recycled pid.
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
      platforms: ["x86_64-linux"],
    });
    expect(results).toHaveLength(1);
    // NOT `released`: nothing was holding, so nothing was let go. Saying
    // `released` would tell an operator a box came free that never was.
    expect(results[0]?.effective).toBe("nothing");
    expect(readLeaseRecord(repo)["x86_64-linux"]).toBeUndefined();
  });
});
