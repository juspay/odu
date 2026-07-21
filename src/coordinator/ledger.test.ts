import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../common/runRecord";
import { RUN_RECORD_VERSION } from "../common/runRecord";
import {
  allocateSeq,
  readLedger,
  recordPath,
  releaseReservation,
  reserveNextSeq,
  writeRunRecord,
} from "./ledger";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-ledger-"));
  dirs.push(dir);
  return dir;
}

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    version: RUN_RECORD_VERSION,
    repo: "juspay/kolu",
    sha: "26d2c2dabc",
    seq: 1,
    dirty: false,
    pipeline: "pipeline",
    outcome: "passed",
    startedAt: 1000,
    finishedAt: 2000,
    lanes: [{ platform: "x86_64-linux", host: "localhost" }],
    nodes: [],
    ...over,
  };
}

describe("allocateSeq", () => {
  it("starts at 1 for a commit with no prior runs", () => {
    expect(allocateSeq(tmpRepo(), "26d2c2d")).toBe(1);
  });

  it("returns one past the highest existing seq", () => {
    const repo = tmpRepo();
    writeRunRecord(repo, "26d2c2d", record({ seq: 1 }));
    writeRunRecord(repo, "26d2c2d", record({ seq: 2 }));
    expect(allocateSeq(repo, "26d2c2d")).toBe(3);
  });

  it("is per-commit — a different sha starts fresh at 1", () => {
    const repo = tmpRepo();
    writeRunRecord(repo, "aaaaaaa", record({ seq: 5 }));
    expect(allocateSeq(repo, "bbbbbbb")).toBe(1);
  });

  it("ignores non-seq files in the runs dir", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".ci", "26d2c2d", "runs"), { recursive: true });
    writeFileSync(join(repo, ".ci", "26d2c2d", "runs", "notes.txt"), "x");
    expect(allocateSeq(repo, "26d2c2d")).toBe(1);
  });
});

describe("reserveNextSeq — atomic select-and-reserve", () => {
  it("reserves the next seq and returns it", () => {
    const repo = tmpRepo();
    expect(reserveNextSeq(repo, "26d2c2d")).toBe(1);
  });

  it("two reservations without a finalize between them get DISTINCT seqs", () => {
    // The whole point of atomic reserve-not-just-scan (juspay/odu#49 F1): a
    // plain `allocateSeq` scan would hand both the same number, letting two runs
    // publish the same `<sha7>#<seq>`. The exclusive create makes the second
    // advance.
    const repo = tmpRepo();
    expect(reserveNextSeq(repo, "26d2c2d")).toBe(1);
    expect(reserveNextSeq(repo, "26d2c2d")).toBe(2);
  });

  it("a reserved seq is never reused after a crash (SIGKILL before finalize)", () => {
    const repo = tmpRepo();
    reserveNextSeq(repo, "26d2c2d"); // reserved 1, then the coordinator dies
    expect(reserveNextSeq(repo, "26d2c2d")).toBe(2);
  });

  it("never truncates an existing finalized record — a stale contender advances", () => {
    // A finalized record must not be overwritten by a later reservation of the
    // same number: the exclusive create sees the file and advances instead.
    const repo = tmpRepo();
    const finished = record({ seq: 1 });
    writeRunRecord(repo, "26d2c2d", finished);
    expect(reserveNextSeq(repo, "26d2c2d")).toBe(2);
    expect(readLedger(repo)).toEqual([finished]); // untouched
  });

  it("a reservation sentinel is skipped by readLedger — a live run is not phantom history", () => {
    // reserveNextSeq claims the seq before the run serves; it must NOT surface in
    // `odu runs` as a finished run (the sentinel fails RunRecordSchema). A real
    // finalize later overwrites the same file with a genuine record.
    const repo = tmpRepo();
    reserveNextSeq(repo, "26d2c2d");
    expect(readLedger(repo)).toEqual([]);
    const finished = record({ seq: 1 });
    writeRunRecord(repo, "26d2c2d", finished);
    expect(readLedger(repo)).toEqual([finished]);
  });

  it("releaseReservation reclaims an orphaned sentinel and frees the ordinal", () => {
    // A run reserved a seq then threw before serving (early-throw). runCommand's
    // finally releases the orphan so it doesn't accumulate or burn the ordinal.
    const repo = tmpRepo();
    expect(reserveNextSeq(repo, "26d2c2d")).toBe(1);
    releaseReservation(repo, "26d2c2d", 1);
    // Gone from disk, and the ordinal is free again (an unpublished seq is safe
    // to reuse — nothing ever observed it).
    expect(reserveNextSeq(repo, "26d2c2d")).toBe(1);
  });

  it("releaseReservation NEVER removes a finalized record", () => {
    // A published+finalized seq is a real record, not a sentinel — release must
    // leave it untouched (it never races a genuine record or a SIGKILL reservation).
    const repo = tmpRepo();
    reserveNextSeq(repo, "26d2c2d");
    const finished = record({ seq: 1 });
    writeRunRecord(repo, "26d2c2d", finished); // overwrites the sentinel
    releaseReservation(repo, "26d2c2d", 1);
    expect(readLedger(repo)).toEqual([finished]); // still there
  });

  it("returns null on a write failure rather than throwing (never gates the run)", () => {
    // A genuine write failure: the `runs` path already exists as a FILE, so the
    // reservation can't create its dir/sentinel. reserveNextSeq must return null
    // (best-effort) so the coordinator proceeds with no seq — not throw and abort
    // the run (juspay/odu#49 F4).
    const repo = tmpRepo();
    mkdirSync(join(repo, ".ci", "26d2c2d"), { recursive: true });
    writeFileSync(join(repo, ".ci", "26d2c2d", "runs"), "not a dir");
    expect(reserveNextSeq(repo, "26d2c2d")).toBeNull();
  });
});

describe("writeRunRecord / readLedger round-trip", () => {
  it("writes to .ci/<sha7>/runs/<seq>.json and reads it back", () => {
    const repo = tmpRepo();
    const r = record({ seq: 2 });
    writeRunRecord(repo, "26d2c2d", r);
    expect(recordPath(repo, "26d2c2d", 2)).toBe(
      join(repo, ".ci", "26d2c2d", "runs", "2.json"),
    );
    expect(readLedger(repo)).toEqual([r]);
  });

  it("collects records across commits, newest (finishedAt) first", () => {
    const repo = tmpRepo();
    writeRunRecord(repo, "aaaaaaa", record({ sha: "aaaaaaaXX", seq: 1, finishedAt: 100 }));
    writeRunRecord(repo, "bbbbbbb", record({ sha: "bbbbbbbXX", seq: 1, finishedAt: 300 }));
    writeRunRecord(repo, "ccccccc", record({ sha: "cccccccXX", seq: 1, finishedAt: 200 }));
    expect(readLedger(repo).map((r) => r.sha)).toEqual([
      "bbbbbbbXX",
      "cccccccXX",
      "aaaaaaaXX",
    ]);
  });

  it("breaks a finishedAt tie by seq, descending", () => {
    const repo = tmpRepo();
    writeRunRecord(repo, "26d2c2d", record({ seq: 1, finishedAt: 500 }));
    writeRunRecord(repo, "26d2c2d", record({ seq: 2, finishedAt: 500 }));
    expect(readLedger(repo).map((r) => r.seq)).toEqual([2, 1]);
  });

  it("is empty for a checkout with no .ci at all", () => {
    expect(readLedger(tmpRepo())).toEqual([]);
  });

  it("skips an unparseable record rather than blinding the whole ledger", () => {
    const repo = tmpRepo();
    writeRunRecord(repo, "26d2c2d", record({ seq: 1 }));
    const runs = join(repo, ".ci", "26d2c2d", "runs");
    writeFileSync(join(runs, "2.json"), "{ not valid json");
    writeFileSync(join(runs, "3.json"), JSON.stringify({ version: 1 })); // missing fields
    const ledger = readLedger(repo);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.seq).toBe(1);
  });

  it("ignores a commit dir that has logs but no runs subdir", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".ci", "26d2c2d", "x86_64-linux"), { recursive: true });
    writeFileSync(join(repo, ".ci", "26d2c2d", "x86_64-linux", "ci::e2e.log"), "log");
    expect(readLedger(repo)).toEqual([]);
  });
});
