import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../common/runRecord";
import { RUN_RECORD_VERSION } from "../common/runRecord";
import { allocateSeq, readLedger, recordPath, writeRunRecord } from "./ledger";

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
    sha7: "26d2c2d",
    seq: 1,
    dirty: false,
    pipeline: "pipeline",
    verdict: "passed",
    complete: true,
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
    writeRunRecord(repo, record({ seq: 1 }));
    writeRunRecord(repo, record({ seq: 2 }));
    expect(allocateSeq(repo, "26d2c2d")).toBe(3);
  });

  it("is per-commit — a different sha starts fresh at 1", () => {
    const repo = tmpRepo();
    writeRunRecord(repo, record({ sha7: "aaaaaaa", seq: 5 }));
    expect(allocateSeq(repo, "bbbbbbb")).toBe(1);
  });

  it("ignores non-seq files in the runs dir", () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".ci", "26d2c2d", "runs"), { recursive: true });
    writeFileSync(join(repo, ".ci", "26d2c2d", "runs", "notes.txt"), "x");
    expect(allocateSeq(repo, "26d2c2d")).toBe(1);
  });
});

describe("writeRunRecord / readLedger round-trip", () => {
  it("writes to .ci/<sha7>/runs/<seq>.json and reads it back", () => {
    const repo = tmpRepo();
    const r = record({ seq: 2 });
    writeRunRecord(repo, r);
    expect(recordPath(repo, "26d2c2d", 2)).toBe(
      join(repo, ".ci", "26d2c2d", "runs", "2.json"),
    );
    expect(readLedger(repo)).toEqual([r]);
  });

  it("collects records across commits, newest (finishedAt) first", () => {
    const repo = tmpRepo();
    writeRunRecord(repo, record({ sha7: "aaaaaaa", seq: 1, finishedAt: 100 }));
    writeRunRecord(repo, record({ sha7: "bbbbbbb", seq: 1, finishedAt: 300 }));
    writeRunRecord(repo, record({ sha7: "ccccccc", seq: 1, finishedAt: 200 }));
    expect(readLedger(repo).map((r) => r.sha7)).toEqual([
      "bbbbbbb",
      "ccccccc",
      "aaaaaaa",
    ]);
  });

  it("breaks a finishedAt tie by seq, descending", () => {
    const repo = tmpRepo();
    writeRunRecord(repo, record({ seq: 1, finishedAt: 500 }));
    writeRunRecord(repo, record({ seq: 2, finishedAt: 500 }));
    expect(readLedger(repo).map((r) => r.seq)).toEqual([2, 1]);
  });

  it("is empty for a checkout with no .ci at all", () => {
    expect(readLedger(tmpRepo())).toEqual([]);
  });

  it("skips an unparseable record rather than blinding the whole ledger", () => {
    const repo = tmpRepo();
    writeRunRecord(repo, record({ seq: 1 }));
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
