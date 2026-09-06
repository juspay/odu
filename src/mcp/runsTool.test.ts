import { describe, expect, it } from "bun:test";
import { RUN_RECORD_VERSION, type RunRecord } from "@odu/run-history/legacy/record";
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

/** No corpse anywhere near these: the dead-run answer is a separate fold,
 *  covered by src/mcp/runDies.test.ts against a REAL killed coordinator. */
const noCorpse = async () => null;

describe("listRuns", () => {
  it("returns the ledger as given (the loader already sorts newest-first)", async () => {
    const ledger = [record({ seq: 3 }), record({ seq: 2 }), record({ seq: 1 })];
    const result = await listRuns({ loadLedger: () => ledger, detectDead: noCorpse });
    expect(result.runs.map((r) => r.seq)).toEqual([3, 2, 1]);
    expect(result.dead_run).toBeNull();
  });

  it("caps to the newest `limit` runs", async () => {
    const ledger = Array.from({ length: 30 }, (_, i) => record({ seq: 30 - i }));
    const result = await listRuns({ limit: 5, loadLedger: () => ledger, detectDead: noCorpse });
    expect(result.runs).toHaveLength(5);
    expect(result.runs[0]?.seq).toBe(30);
    expect(result.runs[4]?.seq).toBe(26);
  });

  it("defaults to the newest 20 when no limit is given", async () => {
    const ledger = Array.from({ length: 50 }, () => record());
    expect(
      (await listRuns({ loadLedger: () => ledger, detectDead: noCorpse })).runs,
    ).toHaveLength(20);
  });

  it("is empty when the ledger is empty (no checkout / no runs)", async () => {
    const result = await listRuns({ loadLedger: () => [], detectDead: noCorpse });
    expect(result.runs).toEqual([]);
    expect(result.dead_run).toBeNull();
  });
});
