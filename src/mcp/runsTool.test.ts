import { describe, expect, it } from "bun:test";
import { RUN_RECORD_VERSION, type RunRecord } from "../common/runRecord";
import { listRuns } from "./runsTool";

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    version: RUN_RECORD_VERSION,
    repo: "juspay/odu",
    sha: "26d2c2dabc",
    seq: 1,
    dirty: false,
    pipeline: "ci::default",
    outcome: "passed",
    startedAt: 1000,
    finishedAt: 2000,
    lanes: [{ platform: "x86_64-linux", host: "localhost" }],
    nodes: [],
    ...over,
  };
}

describe("listRuns", () => {
  it("returns the ledger as given (the loader already sorts newest-first)", () => {
    const ledger = [record({ seq: 3 }), record({ seq: 2 }), record({ seq: 1 })];
    expect(listRuns({ loadLedger: () => ledger }).runs.map((r) => r.seq)).toEqual([
      3, 2, 1,
    ]);
  });

  it("caps to the newest `limit` runs", () => {
    const ledger = Array.from({ length: 30 }, (_, i) => record({ seq: 30 - i }));
    const result = listRuns({ limit: 5, loadLedger: () => ledger });
    expect(result.runs).toHaveLength(5);
    expect(result.runs[0]?.seq).toBe(30);
    expect(result.runs[4]?.seq).toBe(26);
  });

  it("defaults to the newest 20 when no limit is given", () => {
    const ledger = Array.from({ length: 50 }, () => record());
    expect(listRuns({ loadLedger: () => ledger }).runs).toHaveLength(20);
  });

  it("is empty when the ledger is empty (no checkout / no runs)", () => {
    expect(listRuns({ loadLedger: () => [] }).runs).toEqual([]);
  });
});
