import { describe, expect, it } from "bun:test";
import { Result, Schema } from "effect";
import { pushTotals } from "@odu/run-client/surface";
import { foldJournal } from "./attention";
import {
  JournalEntrySchema,
  type NodePush,
  RunEventSchema,
  RunManifestSchema,
} from "./schema";

const decodes = (schema: Schema.Codec<unknown, unknown>, value: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(value));

const MANIFEST = {
  version: 1,
  runId: "0000000b-0002",
  repo: "juspay/odu",
  sha: "a".repeat(40),
  seq: 3,
  pipeline: "ci",
  repoRoot: "/checkouts/odu",
  createdAt: 1_700_000_000_000,
  scope: { selectors: [], platforms: [], noDeps: false },
  snapshot: { mode: "strict", expectedSha: "a".repeat(40), dirty: false, retryable: true },
  build: { oduVersion: "0.1.0", self: null, runnerFlake: null },
  registeredBy: {
    epoch: 1,
    pid: 1,
    host: "box",
    claimedAt: 1,
    heartbeatAt: 1,
    endpoint: "/tmp/odu.sock",
  },
  parentRunId: null,
  requestId: null,
};

describe("the manifest's push record", () => {
  it("round-trips a run that pushed, carrying the token id and NOT the token", () => {
    const push = {
      target: {
        substituter: "https://cache.kolu.dev/kolu-r2",
        bucket: "kolu-r2",
        tokenId: "0123456789abcdef",
      },
      skipped: null,
      keyWarning: null,
    };
    const decoded = Schema.decodeUnknownSync(RunManifestSchema)({ ...MANIFEST, push });
    expect(decoded.push).toEqual(push);
    const encoded = Schema.encodeUnknownSync(RunManifestSchema)(decoded) as {
      push: unknown;
    };
    expect(JSON.stringify(encoded.push)).not.toContain("odu_");
  });

  it("round-trips a run that pushed NOWHERE, with the reason it carried", () => {
    const push = {
      target: null,
      skipped: "no substituter in flake.nix nixConfig is a cache this odu serves",
      keyWarning: null,
    };
    expect(Schema.decodeUnknownSync(RunManifestSchema)({ ...MANIFEST, push }).push).toEqual(push);
  });

  it("still decodes a manifest written before the field, as ABSENT", () => {
    const decoded = Schema.decodeUnknownSync(RunManifestSchema)(MANIFEST);
    expect("push" in decoded).toBe(false);
  });

  it("refuses a push record with no target key at all", () => {
    expect(decodes(RunManifestSchema, { ...MANIFEST, push: { skipped: "x" } })).toBe(false);
  });
});

describe("the journal's three push events", () => {
  const node = "ci::build@x86_64-linux";
  const event = {
    kind: "pushed",
    node,
    bucket: "kolu-r2",
    paths: 12,
    bytes: 4_194_304,
    durationMs: 2_500,
  } as const;
  const began = { kind: "pushing", node, bucket: "kolu-r2" } as const;
  const broke = {
    kind: "push_failed",
    node,
    bucket: "kolu-r2",
    message: "odu: 1 path could not be pushed to kolu-r2 — 413 too large",
    durationMs: 900,
  } as const;

  it("round-trip as their own arms of the event union", () => {
    for (const one of [event, began, broke]) {
      const bytes = JSON.stringify(one);
      const decoded = Schema.decodeUnknownSync(RunEventSchema)(JSON.parse(bytes));
      expect(JSON.stringify(Schema.encodeUnknownSync(RunEventSchema)(decoded))).toBe(bytes);
    }
  });

  it("are journal entries like any other", () => {
    expect(decodes(JournalEntrySchema, { seq: 7, at: 1, event })).toBe(true);
    expect(decodes(JournalEntrySchema, { seq: 8, at: 2, event: began })).toBe(true);
    expect(decodes(JournalEntrySchema, { seq: 9, at: 3, event: broke })).toBe(true);
  });

  it("folds to one state per node, newest write winning", () => {
    const fold = foldJournal([
      { seq: 1, at: 1, event },
      {
        seq: 2,
        at: 2,
        event: { ...event, node: "ci::docs@x86_64-linux", paths: 1, bytes: 10 },
      },
      { seq: 3, at: 3, event: { ...event, paths: 13, bytes: 5_000_000, durationMs: 40 } },
    ]);
    expect([...fold.push.entries()]).toEqual([
      [
        node,
        { state: "pushed", bucket: "kolu-r2", stored: 13, present: 0, bytes: 5_000_000, durationMs: 40 },
      ],
      [
        "ci::docs@x86_64-linux",
        { state: "pushed", bucket: "kolu-r2", stored: 1, present: 0, bytes: 10, durationMs: 2_500 },
      ],
    ]);
  });

  it("tells STORED from PRESENT, and reads a line without the count as all-stored", () => {
    const split = foldJournal([
      { seq: 1, at: 1, event: { ...event, paths: 69, present: 66, bytes: 3_100 } },
    ]);
    expect(split.push.get(node)).toEqual({
      state: "pushed",
      bucket: "kolu-r2",
      stored: 3,
      present: 66,
      bytes: 3_100,
      durationMs: 2_500,
    });

    const legacy = foldJournal([{ seq: 1, at: 1, event }]);
    expect(legacy.push.get(node)).toEqual({
      state: "pushed",
      bucket: "kolu-r2",
      stored: 12,
      present: 0,
      bytes: 4_194_304,
      durationMs: 2_500,
    });
  });

  it("carries a push that is still RUNNING, until the line that ends it", () => {
    expect([...foldJournal([{ seq: 1, at: 1, event: began }]).push.entries()]).toEqual([
      [node, { state: "pushing", bucket: "kolu-r2" }],
    ]);
    expect(
      [
        ...foldJournal([
          { seq: 1, at: 1, event: began },
          { seq: 2, at: 2, event },
        ]).push.entries(),
      ],
    ).toEqual([
      [
        node,
        {
          state: "pushed",
          bucket: "kolu-r2",
          stored: 12,
          present: 0,
          bytes: 4_194_304,
          durationMs: 2_500,
        },
      ],
    ]);
  });

  it("carries the RECIPE's duration on the line that opens the push", () => {
    const placement = { platform: "x86_64-linux", host: "box" };
    const fold = foldJournal([
      { seq: 1, at: 1, event: { kind: "attempt_started", node, attempt: 1, placement } },
      {
        seq: 2,
        at: 2,
        event: {
          kind: "node_status",
          node,
          attempt: 1,
          status: "running",
          exitCode: null,
          durationMs: null,
          placement,
        },
      },
      { seq: 3, at: 3, event: { ...began, durationMs: 90_000 } },
    ]);
    expect(fold.latest.get(node)?.durationMs).toBe(90_000);
    expect(fold.latest.get(node)?.status).toBe("running");
    expect([...fold.push.entries()]).toEqual([[node, { state: "pushing", bucket: "kolu-r2" }]]);
  });

  it("never lets a `pushing` line overwrite a duration a STATUS measured", () => {
    const placement = { platform: "x86_64-linux", host: "box" };
    const fold = foldJournal([
      { seq: 1, at: 1, event: { kind: "attempt_started", node, attempt: 1, placement } },
      {
        seq: 2,
        at: 2,
        event: {
          kind: "node_status",
          node,
          attempt: 1,
          status: "ok",
          exitCode: 0,
          durationMs: 1_234,
          placement,
        },
      },
      { seq: 3, at: 3, event: { ...began, durationMs: 90_000 } },
    ]);
    expect(fold.latest.get(node)?.durationMs).toBe(1_234);
  });

  it("still decodes a `pushing` line written before it carried a duration", () => {
    expect(decodes(RunEventSchema, began)).toBe(true);
    expect(decodes(RunEventSchema, { ...began, durationMs: 90_000 })).toBe(true);
    const placement = { platform: "x86_64-linux", host: "box" };
    const fold = foldJournal([
      { seq: 1, at: 1, event: { kind: "attempt_started", node, attempt: 1, placement } },
      { seq: 2, at: 2, event: began },
    ]);
    expect(fold.latest.get(node)?.durationMs).toBeNull();
  });

  it("carries a push that FAILED, with the client's sentence", () => {
    expect(
      [
        ...foldJournal([
          { seq: 1, at: 1, event: began },
          { seq: 2, at: 2, event: broke },
        ]).push.entries(),
      ],
    ).toEqual([
      [
        node,
        {
          state: "failed",
          bucket: "kolu-r2",
          message: broke.message,
          durationMs: 900,
        },
      ],
    ]);
  });

  it("RETRACTS a node's push when a new attempt starts", () => {
    const started = {
      kind: "attempt_started",
      node,
      attempt: 2,
      placement: { platform: "x86_64-linux", host: null },
    } as const;
    expect([
      ...foldJournal([
        { seq: 1, at: 1, event },
        { seq: 2, at: 2, event: started },
      ]).push.entries(),
    ]).toEqual([]);

    expect([
      ...foldJournal([
        { seq: 1, at: 1, event },
        { seq: 2, at: 2, event: started },
        { seq: 3, at: 3, event: { ...event, paths: 2, bytes: 20, durationMs: 7 } },
      ]).push.entries(),
    ]).toEqual([
      [
        node,
        { state: "pushed", bucket: "kolu-r2", stored: 2, present: 0, bytes: 20, durationMs: 7 },
      ],
    ]);
  });
});

describe("what a run put on its bucket, over every node", () => {
  const pushed = (stored: number, present: number, bytes: number): NodePush => ({
    state: "pushed",
    bucket: "kolu-r2",
    stored,
    present,
    bytes,
    durationMs: 10,
  });

  it("sums only the pushes that LANDED, and names the nodes that did not", () => {
    const totals = pushTotals(
      new Map<string, NodePush>([
        ["ci::build@x86_64-linux", pushed(12, 30, 4_000)],
        ["ci::docs@x86_64-linux", { state: "pushing", bucket: "kolu-r2" }],
        [
          "ci::e2e@x86_64-linux",
          {
            state: "failed",
            bucket: "kolu-r2",
            message: "413 too large",
            durationMs: 900,
          },
        ],
        ["ci::nix@aarch64-darwin", pushed(3, 36, 500)],
      ]),
    );
    expect(totals).toEqual({
      stored: 15,
      present: 66,
      bytes: 4_500,
      landed: 2,
      failedOn: ["ci::e2e@x86_64-linux"],
    });
  });

  it("is zero and empty for a run whose nodes pushed nothing", () => {
    expect(pushTotals(new Map())).toEqual({
      stored: 0,
      present: 0,
      bytes: 0,
      landed: 0,
      failedOn: [],
    });
  });
});
