import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { utimesSync } from "node:fs";
import { deadRun, describeDeadRun } from "./deadRun";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-dead-"));
  dirs.push(dir);
  return dir;
}

/** The reservation sentinel exactly as `reserveNextSeq` writes it. */
function reserveSentinel(root: string, sha7: string, seq: number): string {
  const dir = join(root, ".ci", sha7, "runs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${seq}.json`);
  writeFileSync(path, `${JSON.stringify({ reserved: true, seq }, null, 2)}\n`);
  return path;
}

describe("deadRun", () => {
  it("answers null for a checkout with no .ci at all (the steady state)", async () => {
    expect(await deadRun(tmpCheckout())).toBeNull();
  });

  it("answers null for a clean post-run checkout: records finalized, residue gone", async () => {
    const root = tmpCheckout();
    const dir = join(root, ".ci", "9be9c7c", "runs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "1.json"),
      JSON.stringify({ seq: 1, outcome: "passed" }),
    );
    expect(await deadRun(root)).toBeNull();
  });

  it("names the run an unfinalized reservation belongs to — the reservation NAMES the corpse, it never proves one", async () => {
    const root = tmpCheckout();
    reserveSentinel(root, "abc1234", 1);
    expect(await deadRun(root)).toBeNull();
    writeFileSync(join(root, ".ci", "odu.run.lock"), "2147483646\n");
    const dead = await deadRun(root);
    expect(dead).not.toBeNull();
    expect(dead!.sha7).toBe("abc1234");
    expect(dead!.seq).toBe(1);
    expect(dead!.evidence.reservation).toBe(true);
    expect(dead!.lastActivityAt).not.toBeNull();
  });

  it("a recovered checkout is the steady state: the tombstone stays, the corpse answer does not", async () => {
    const root = tmpCheckout();
    reserveSentinel(root, "abc1234", 1);
    writeFileSync(join(root, ".ci", "odu.run.lock"), "2147483646\n");
    writeFileSync(join(root, ".ci", "odu.sock"), "");
    rmSync(join(root, ".ci", "odu.run.lock"), { force: true });
    rmSync(join(root, ".ci", "odu.sock"), { force: true });
    const runsDir = join(root, ".ci", "abc1234", "runs");
    writeFileSync(
      join(runsDir, "2.json"),
      JSON.stringify({ seq: 2, outcome: "passed" }),
    );
    expect(await deadRun(root)).toBeNull();
  });

  it("answers null while a run is LIVE: a serving lock-holder is not a corpse", async () => {
    const root = tmpCheckout();
    const ci = join(root, ".ci");
    mkdirSync(ci, { recursive: true });
    writeFileSync(join(ci, "odu.run.lock"), `${process.pid}\n`);
    reserveSentinel(root, "abc1234", 3);
    expect(await deadRun(root)).toBeNull();
  });

  it("reads a stale run lock (dead pid) as the kill it is, even with no reservation", async () => {
    const root = tmpCheckout();
    const ci = join(root, ".ci");
    mkdirSync(ci, { recursive: true });
    writeFileSync(join(ci, "odu.run.lock"), "2147483646\n");
    const dead = await deadRun(root);
    expect(dead).not.toBeNull();
    expect(dead!.evidence.lock).toBe(true);
    expect(dead!.sha7).toBe("");
    expect(dead!.seq).toBeNull();
  });

  it("reads a socket FILE nobody serves as the kill it is", async () => {
    const root = tmpCheckout();
    const ci = join(root, ".ci");
    mkdirSync(ci, { recursive: true });
    writeFileSync(join(ci, "odu.sock"), "");
    const dead = await deadRun(root);
    expect(dead).not.toBeNull();
    expect(dead!.evidence.socket).toBe(true);
  });

  it("last sign of life is the dead run's OWN artifacts — never the shared `.ci/<sha7>` tree's later writes", async () => {
    const root = tmpCheckout();
    const past = Date.now() - 60_000;
    reserveSentinel(root, "abc1234", 1);
    writeFileSync(join(root, ".ci", "odu.run.lock"), "2147483646\n");
    for (const p of [
      join(root, ".ci", "abc1234", "runs", "1.json"),
      join(root, ".ci", "odu.run.lock"),
    ]) {
      utimesSync(p, new Date(past), new Date(past));
    }
    const logDir = join(root, ".ci", "abc1234", "x86_64-linux");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "ci::e2e.log"), "the re-run's fresher output\n");
    writeFileSync(
      join(root, ".ci", "abc1234", "runs", "2.json"),
      JSON.stringify({ seq: 2, outcome: "passed" }),
    );
    const dead = await deadRun(root);
    expect(dead).not.toBeNull();
    expect(Math.floor(dead!.lastActivityAt!)).toBe(past);
  });

  it("last sign of life includes the run's own per-seq tee (runs/<seq>.log), when the launcher kept one", async () => {
    const root = tmpCheckout();
    const past = Date.now() - 60_000;
    reserveSentinel(root, "abc1234", 1);
    writeFileSync(join(root, ".ci", "odu.run.lock"), "2147483646\n");
    writeFileSync(join(root, ".ci", "abc1234", "runs", "1.log"), "tee\n");
    utimesSync(
      join(root, ".ci", "abc1234", "runs", "1.log"),
      new Date(past),
      new Date(past),
    );
    for (const p of [
      join(root, ".ci", "abc1234", "runs", "1.json"),
      join(root, ".ci", "odu.run.lock"),
    ]) {
      utimesSync(p, new Date(past - 10_000), new Date(past - 10_000));
    }
    const dead = await deadRun(root);
    expect(dead).not.toBeNull();
    expect(Math.floor(dead!.lastActivityAt!)).toBe(past);
  });

  it("a foreign process at the lock's PID vetoes the death — EPERM means a process EXISTS, never that the holder died", async () => {
    const root = tmpCheckout();
    const ci = join(root, ".ci");
    mkdirSync(ci, { recursive: true });
    // PID 1 is init/launchd: EPERM for any test runner that is not root.
    writeFileSync(join(ci, "odu.run.lock"), "1\n");
    expect(await deadRun(root)).toBeNull();
  });
});

describe("describeDeadRun", () => {
  it("names the run and the admission", async () => {
    const root = tmpCheckout();
    reserveSentinel(root, "abc1234", 1);
    writeFileSync(join(root, ".ci", "odu.run.lock"), "2147483646\n");
    const dead = (await deadRun(root))!;
    const msg = describeDeadRun(dead);
    expect(msg).toContain("abc1234#1");
    expect(msg).toContain("died with the process that started it");
  });

  it("says what it can when no run directory names the commit", async () => {
    const root = tmpCheckout();
    const ci = join(root, ".ci");
    mkdirSync(ci, { recursive: true });
    writeFileSync(join(ci, "odu.run.lock"), "2147483646\n");
    const dead = (await deadRun(root))!;
    const msg = describeDeadRun(dead);
    expect(msg).toContain("died with the process that started it");
    expect(msg).not.toContain("#null");
  });
});
