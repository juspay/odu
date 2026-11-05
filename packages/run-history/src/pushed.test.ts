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
 *   - the journal's `pushed` event, which a fold turns back into per-node
 *     counts. A reader a week later answers "did this run fill the cache"
 *     without the bucket having to be asked.
 *
 * The TOKEN is in neither. The manifest is a durable record of a run, and a
 * credential in one would outlive every bound this design puts on it.
 */

import { describe, expect, it } from "bun:test";
import { Result, Schema } from "effect";
import { foldJournal } from "./attention";
import { JournalEntrySchema, RunEventSchema, RunManifestSchema } from "./schema";

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
      note: null,
    };
    const decoded = Schema.decodeUnknownSync(RunManifestSchema)({ ...MANIFEST, push });
    expect(decoded.push).toEqual(push);
    const encoded = Schema.encodeUnknownSync(RunManifestSchema)(decoded) as {
      push: unknown;
    };
    expect(JSON.stringify(encoded.push)).not.toContain("odu_");
  });

  it("round-trips a run that pushed NOWHERE, with the reason it carried", () => {
    const push = { target: null, note: "no substituter in flake.nix nixConfig is an odu cache" };
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
    expect(decodes(RunManifestSchema, { ...MANIFEST, push: { note: "x" } })).toBe(false);
  });
});

describe("the journal's pushed event", () => {
  const event = {
    kind: "pushed",
    node: "ci::build@x86_64-linux",
    bucket: "kolu-r2",
    paths: 12,
    bytes: 4_194_304,
    durationMs: 2_500,
  } as const;

  it("round-trips as its own arm of the event union", () => {
    const bytes = JSON.stringify(event);
    const decoded = Schema.decodeUnknownSync(RunEventSchema)(JSON.parse(bytes));
    expect(JSON.stringify(Schema.encodeUnknownSync(RunEventSchema)(decoded))).toBe(bytes);
  });

  it("is a journal entry like any other", () => {
    expect(decodes(JournalEntrySchema, { seq: 7, at: 1, event })).toBe(true);
  });

  it("folds to per-node counts, newest write winning", () => {
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
    expect([...fold.pushed.entries()]).toEqual([
      [
        "ci::build@x86_64-linux",
        { bucket: "kolu-r2", paths: 13, bytes: 5_000_000, durationMs: 40 },
      ],
      [
        "ci::docs@x86_64-linux",
        { bucket: "kolu-r2", paths: 1, bytes: 10, durationMs: 2_500 },
      ],
    ]);
  });
});
