import { describe, expect, it } from "bun:test";
import { Result, Schema } from "effect";
import {
  leasedLanes,
  type NodeState,
  pendingNode,
  type PipelineState,
} from "@odu/run-client/surface";
import {
  buildRunRecord,
  formatRunRef,
  RUN_RECORD_VERSION,
  RunRecordSchema,
} from "./runRecord";

const decodesAsRecord = (value: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(RunRecordSchema)(value));

/** A PipelineState with `order`-respecting nodes built from terse tuples. */
function stateOf(
  rows: Array<[id: string, status: PipelineState["nodes"][string]["status"], exit: number | null, dur: number | null]>,
): PipelineState {
  const order = rows.map(([id]) => id);
  const nodes: Record<string, NodeState> = {};
  for (const [id, status, exitCode, durationMs] of rows) {
    nodes[id] = {
      ...pendingNode({ id, name: id, command: "x", needs: [] }),
      status,
      exitCode,
      durationMs,
    };
  }
  return { name: "pipeline", sha7: "26d2c2d", dirty: false, order, nodes };
}

const base = {
  repo: "juspay/kolu",
  sha: "26d2c2dabc",
  seq: 1,
  dirty: false,
  startedAt: 1000,
  finishedAt: 5000,
  lanes: [{ platform: "x86_64-linux", host: "localhost" }],
};

describe("buildRunRecord", () => {
  it("passes only when every node is terminal and none is red", () => {
    const record = buildRunRecord({
      ...base,
      state: stateOf([
        ["ci::nix@x86_64-linux", "ok", 0, 3000],
        ["ci::e2e@x86_64-linux", "ok", 0, 1000],
      ]),
    });
    expect(record.outcome).toBe("passed");
    expect(record.version).toBe(RUN_RECORD_VERSION);
    // The record validates against its own schema (the ledger reader's gate).
    expect(decodesAsRecord(record)).toBe(true);
  });

  it("fails when a node is red, even though the run completed", () => {
    const record = buildRunRecord({
      ...base,
      state: stateOf([
        ["ci::nix@x86_64-linux", "ok", 0, 3000],
        ["ci::e2e@x86_64-linux", "failed", 1, 1200],
      ]),
    });
    expect(record.outcome).toBe("failed");
  });

  it("marks an interrupted run incomplete (a gate that didn't finish didn't pass)", () => {
    const record = buildRunRecord({
      ...base,
      state: stateOf([
        ["ci::nix@x86_64-linux", "ok", 0, 3000],
        ["ci::e2e@x86_64-linux", "running", null, null],
      ]),
    });
    expect(record.outcome).toBe("incomplete");
  });

  it("projects nodes to the matrix-cell fields, in order, dropping command/needs", () => {
    const record = buildRunRecord({
      ...base,
      state: stateOf([
        ["ci::nix@x86_64-linux", "ok", 0, 3000],
        ["ci::e2e@x86_64-linux", "failed", 1, 1200],
      ]),
    });
    expect(record.nodes).toEqual([
      { id: "ci::nix@x86_64-linux", name: "ci::nix@x86_64-linux", status: "ok", exitCode: 0, durationMs: 3000 },
      { id: "ci::e2e@x86_64-linux", name: "ci::e2e@x86_64-linux", status: "failed", exitCode: 1, durationMs: 1200 },
    ]);
  });

  it("carries the identity + run env through unchanged", () => {
    const record = buildRunRecord({
      ...base,
      seq: 3,
      dirty: true,
      state: stateOf([["ci::nix@x86_64-linux", "ok", 0, 10]]),
    });
    expect(record).toMatchObject({
      repo: "juspay/kolu",
      sha: "26d2c2dabc",
      seq: 3,
      dirty: true,
      startedAt: 1000,
      finishedAt: 5000,
      lanes: [{ platform: "x86_64-linux", host: "localhost" }],
    });
  });

  it("records unposted GitHub statuses when finalize still owes posts", () => {
    const record = buildRunRecord({
      ...base,
      state: stateOf([["ci::unit@x86_64-linux", "ok", 0, 1000]]),
      unposted: [
        { context: "ci::unit@x86_64-linux", lastError: "403 rate limited" },
      ],
    });
    expect(record.outcome).toBe("passed");
    expect(record.unposted).toEqual([
      { context: "ci::unit@x86_64-linux", lastError: "403 rate limited" },
    ]);
    expect(decodesAsRecord(record)).toBe(true);
  });

  it("omits unposted when the list is empty", () => {
    const record = buildRunRecord({
      ...base,
      state: stateOf([["ci::unit@x86_64-linux", "ok", 0, 10]]),
      unposted: [],
    });
    expect(record.unposted).toBeUndefined();
  });

  it("writes only platform+host per lane, whatever shape the caller passed", () => {
    // The coordinator feeds this `leasedLanes(header)`, whose elements are
    // `LeasedLane` and therefore also carry `state: "leased"`. Structural typing
    // lets that through the parameter, so a spread would write an undeclared key
    // into every durable `.ci/<sha7>/runs/<seq>.json` lane entry.
    const record = buildRunRecord({
      ...base,
      lanes: leasedLanes({
        lanes: [{ state: "leased", platform: "x86_64-linux", host: "kolu-ci-5" }],
      }),
      state: stateOf([["ci::fmt@x86_64-linux", "ok", 0, 10]]),
    });
    for (const lane of record.lanes) {
      expect(Object.keys(lane).sort()).toEqual(["host", "platform"]);
    }
    expect(record.lanes).toEqual([
      { platform: "x86_64-linux", host: "kolu-ci-5" },
    ]);
    expect(decodesAsRecord(record)).toBe(true);
  });

  it("records a cancelled node as incomplete — never a clean pass", () => {
    const record = buildRunRecord({
      ...base,
      state: stateOf([
        ["ci::fmt@x86_64-linux", "ok", 0, 10],
        ["ci::fmt@aarch64-darwin", "cancelled", null, 5],
      ]),
    });
    expect(record.outcome).toBe("incomplete");
  });
});

describe("formatRunRef", () => {
  it("is the stable <sha7>#<seq> spelling, derived from the full sha", () => {
    expect(formatRunRef({ sha: "26d2c2dabc", seq: 2 })).toBe("26d2c2d#2");
  });
});
