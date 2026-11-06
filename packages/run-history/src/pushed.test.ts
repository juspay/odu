/**
 * WHAT A RUN WARMED, ON DISK (PLAN 4.1).
 *
 * Two durable shapes, and both outlive the coordinator that wrote them — which
 * is the whole reason they are here rather than only on a live run's cell:
 *
 *   - the manifest's `push`, which says where this run pushed and what it said
 *     about doing so. `optionalKey`, so every record written before this stays
 *     decodable — the journal reader SKIPS a line it cannot parse, so a
 *     required field would silently erase history rather than failing loudly.
 *   - the journal's three `push*` events, which a fold turns back into one
 *     state per node. A reader a week later answers "did this run fill the
 *     cache" — and "which node failed to" — without the bucket having to be
 *     asked.
 *
 * THREE events rather than one, because a push is a step with a beginning: a
 * `pushing` line is what lets a reader see a minute-long upload while it is
 * happening, and a `push_failed` line is what stops a finished run from
 * showing a red recipe where the recipe in fact passed. The fold is where
 * they become the one answer a face paints.
 *
 * The TOKEN is in neither shape. The manifest is a durable record of a run,
 * and a credential in one would outlive every bound this design puts on it.
 */

import { describe, expect, it } from "bun:test";
import { Result, Schema } from "effect";
import { foldJournal } from "./attention";
import {
  JournalEntrySchema,
  type NodePush,
  pushTotals,
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
    // Not `{target: null}`: a record that predates this says nothing either
    // way, and reading it as "this run pushed nowhere" would be a claim the
    // writer never made.
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
      // A RE-RUN pushed again. The reader asking "what did this node warm"
      // means the attempt that stands, so the later line replaces the first.
      { seq: 3, at: 3, event: { ...event, paths: 13, bytes: 5_000_000, durationMs: 40 } },
    ]);
    expect([...fold.push.entries()]).toEqual([
      [
        node,
        { state: "pushed", bucket: "kolu-r2", paths: 13, bytes: 5_000_000, durationMs: 40 },
      ],
      [
        "ci::docs@x86_64-linux",
        { state: "pushed", bucket: "kolu-r2", paths: 1, bytes: 10, durationMs: 2_500 },
      ],
    ]);
  });

  it("carries a push that is still RUNNING, until the line that ends it", () => {
    // The run page reads a fold of this journal, live run included — so a
    // `pushing` that never reached a line here would be invisible, and a
    // minute-long upload would appear, finished, out of nothing.
    expect([...foldJournal([{ seq: 1, at: 1, event: began }]).push.entries()]).toEqual([
      [node, { state: "pushing", bucket: "kolu-r2" }],
    ]);
    // SUPERSEDED by what happened next. A `pushing` left standing as a
    // node's last push line means the lane died mid-upload, which is exactly
    // what a reader should be shown — and is not this case.
    expect(
      [
        ...foldJournal([
          { seq: 1, at: 1, event: began },
          { seq: 2, at: 2, event },
        ]).push.entries(),
      ],
    ).toEqual([
      [node, { state: "pushed", bucket: "kolu-r2", paths: 12, bytes: 4_194_304, durationMs: 2_500 }],
    ]);
  });

  it("carries a push that FAILED, with the client's sentence", () => {
    // A red node alone cannot say WHICH half failed: without this line a
    // reader of a finished run would see a red recipe where the recipe in
    // fact passed.
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
    // A rerun's push often finds nothing new — every path the recipe builds
    // is already on the bucket from the attempt before — and the old counts
    // would then stand for good over an attempt that pushed nothing: the
    // board and `run_read` claiming `pushed 12 paths` for a node that is
    // still running. A new attempt is exactly the moment the claim stops
    // being about the node a reader is looking at.
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

    // AND A RERUN THAT DOES PUSH says so again, so the retraction is not a
    // one-way door.
    expect([
      ...foldJournal([
        { seq: 1, at: 1, event },
        { seq: 2, at: 2, event: started },
        { seq: 3, at: 3, event: { ...event, paths: 2, bytes: 20, durationMs: 7 } },
      ]).push.entries(),
    ]).toEqual([
      [node, { state: "pushed", bucket: "kolu-r2", paths: 2, bytes: 20, durationMs: 7 }],
    ]);
  });
});

describe("what a run put on its bucket, over every node", () => {
  const pushed = (paths: number, bytes: number): NodePush => ({
    state: "pushed",
    bucket: "kolu-r2",
    paths,
    bytes,
    durationMs: 10,
  });

  it("sums only the pushes that LANDED, and names the nodes that did not", () => {
    // "Green means warmed" is a claim a failed push withdraws, so its bytes
    // are not the run's: counting them would let a run report a cache it
    // never filled. The failure is reported as a NAME instead — what a
    // reader needs to go and look at the node.
    const totals = pushTotals(
      new Map<string, NodePush>([
        ["ci::build@x86_64-linux", pushed(12, 4_000)],
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
        ["ci::nix@aarch64-darwin", pushed(3, 500)],
      ]),
    );
    expect(totals).toEqual({
      paths: 15,
      bytes: 4_500,
      failedOn: ["ci::e2e@x86_64-linux"],
    });
  });

  it("is zero and empty for a run whose nodes pushed nothing", () => {
    expect(pushTotals(new Map())).toEqual({ paths: 0, bytes: 0, failedOn: [] });
  });
});
