/**
 * BYTE fixtures for odu's wire and disk formats.
 *
 * The zod → Effect Schema swap is invisible to decode-EQUALITY: that check is
 * blind to key presence, to key order, and to a default that accepts a missing
 * key but then fails to emit it. So every assertion here is on the encoded JSON
 * STRING, and every fixture is spelled the way the pre-migration zod encoder
 * spelled it.
 *
 * Four formats are frozen, for three different reasons:
 *
 *   - `PipelineState` crosses the stdio wire to `odu-runner` AND the fan-in
 *     unix socket. `seq` and `posting` are `optionalKey`: absent must stay
 *     absent, never become `null`.
 *   - `NodeLogMessage` is the log stream's frame, discriminated on `kind` (not
 *     `_tag`) on both wires.
 *   - `ConfigureInput` carries `TaskSpec`, whose `needs` has a DECODING default
 *     — the one place the migration is deliberately stricter than zod.
 *   - `RunRecord` is odu's only durable manifest (`.ci/<sha7>/runs/<seq>.json`)
 *     and the ledger reader SKIPS records it cannot parse. A silent encode
 *     change would make every pre-migration record vanish from `odu runs` with
 *     no error at all — which is exactly what a decode-equality test would miss.
 *
 * Each format is tested in both directions: the bytes a writer emits, and the
 * bytes a reader accepts (including the pre-migration spellings that omit an
 * optional key).
 */

import { describe, expect, it } from "bun:test";
import { Result, Schema } from "effect";
import { RunRecordSchema } from "./runRecord";
import { TaskSpecSchema } from "./spec";
import {
  ConfigureInputSchema,
  LeaseClaimOutputSchema,
  LeaseProbeOutputSchema,
  NodeLogMessageSchema,
  PipelineStateSchema,
  UnpostedEntrySchema,
} from "./surface";

/** Decode then re-encode, and hand back the bytes. A format is frozen when this
 *  is the identity function on every spelling a peer may send. */
function roundTrip<T>(schema: Schema.Codec<T, unknown>, json: string): string {
  const decoded = Schema.decodeUnknownSync(schema)(JSON.parse(json));
  return JSON.stringify(Schema.encodeUnknownSync(schema)(decoded));
}

const accepts = <T,>(schema: Schema.Codec<T, unknown>, value: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(value));

const NODE =
  '{"id":"ci::unit@x86_64-linux","name":"ci::unit","command":"just --no-deps ci::unit",' +
  '"needs":["_ci-setup"],"status":"ok","exitCode":0,"startedAt":1700000000000,"durationMs":1234}';

describe("PipelineState — the cell that crosses both wires", () => {
  it("a LANE copy round-trips with seq and posting ABSENT", () => {
    const bytes =
      '{"name":"ci","sha7":"26d2c2d","dirty":false,"order":["ci::unit@x86_64-linux"],' +
      `"nodes":{"ci::unit@x86_64-linux":${NODE}}}`;
    expect(roundTrip(PipelineStateSchema, bytes)).toBe(bytes);
  });

  it("a FAN-IN copy round-trips with seq and posting PRESENT", () => {
    const bytes =
      '{"name":"ci","sha7":"26d2c2d","dirty":true,"seq":3,"order":["ci::unit@x86_64-linux"],' +
      `"nodes":{"ci::unit@x86_64-linux":${NODE}},` +
      '"posting":{"owed":[{"context":"ci::unit@x86_64-linux","lastError":null,"attempts":2}]}}';
    expect(roundTrip(PipelineStateSchema, bytes)).toBe(bytes);
  });

  it("the pre-run EMPTY_STATE shape round-trips", () => {
    const bytes =
      '{"name":"pipeline","sha7":"","dirty":false,"order":[],"nodes":{},"posting":{"owed":[]}}';
    expect(roundTrip(PipelineStateSchema, bytes)).toBe(bytes);
  });

  it("an absent optional key must stay absent, never become null", () => {
    // The failure mode `Schema.optional` (as opposed to `optionalKey`) would
    // introduce: a missing `seq` re-emitted as `"seq":null`.
    const bytes =
      '{"name":"ci","sha7":"26d2c2d","dirty":false,"order":[],"nodes":{}}';
    expect(roundTrip(PipelineStateSchema, bytes)).not.toContain("null");
  });

  it("a present-but-undefined seq is REJECTED on DECODE, not silently dropped", () => {
    // PLAN #17: `optionalKey` is stricter than zod's `.optional()`. Every
    // producer must OMIT the key. This is the assertion that gives that rule
    // teeth — a producer spelling `seq: undefined` fails loudly here.
    expect(
      accepts(PipelineStateSchema, {
        name: "ci",
        sha7: "",
        dirty: false,
        order: [],
        nodes: {},
        seq: undefined,
      }),
    ).toBe(false);
  });

  it("a present-but-undefined seq is REJECTED on ENCODE too", () => {
    // The half that actually bit. `run.ts` used to publish
    // `{ ...state, seq: seq ?? undefined }` onto the fan-in cell, which zod's
    // `.optional()` tolerated; `optionalKey` refuses it in BOTH directions, so
    // on the rare no-reserved-seq path the whole cell became un-encodable and
    // every attach / status / agent read of that run would have died. The
    // producer now spreads the key in only when there is one.
    expect(() =>
      Schema.encodeUnknownSync(PipelineStateSchema)({
        name: "ci",
        sha7: "",
        dirty: false,
        order: [],
        nodes: {},
        seq: undefined,
      }),
    ).toThrow();
  });
});

describe("NodeLogMessage — the log stream's frame", () => {
  it("the snapshot arm keeps its `kind` discriminant", () => {
    const bytes = '{"kind":"snapshot","text":"line one\\nline two\\n"}';
    expect(roundTrip(NodeLogMessageSchema, bytes)).toBe(bytes);
  });

  it("the append arm keeps its `kind` discriminant", () => {
    const bytes = '{"kind":"append","text":"more\\n"}';
    expect(roundTrip(NodeLogMessageSchema, bytes)).toBe(bytes);
  });

  it("`_tag` is not the discriminant on this wire", () => {
    expect(accepts(NodeLogMessageSchema, { _tag: "append", text: "x" })).toBe(
      false,
    );
  });
});

describe("TaskSpec / ConfigureInput — the run.configure payload", () => {
  it("a task that OMITS needs decodes to the empty array (zod's .default([]))", () => {
    const decoded = Schema.decodeUnknownSync(TaskSpecSchema)({
      id: "ci::unit",
      command: "just ci::unit",
    });
    expect(decoded.needs).toEqual([]);
  });

  it("a fully-spelled task round-trips byte-for-byte", () => {
    const bytes =
      '{"id":"ci::unit","name":"ci::unit","command":"just --no-deps ci::unit",' +
      '"needs":["ci::install"],"os":["linux"]}';
    expect(roundTrip(TaskSpecSchema, bytes)).toBe(bytes);
  });

  it("a present-but-undefined needs is REJECTED (stricter than zod, on purpose)", () => {
    // zod's `.default([])` substituted for an explicit `undefined`;
    // `withDecodingDefaultKey` does not. Every in-process producer must omit
    // the key — `just/ingest.ts` builds `needs` and `os` totally.
    expect(
      accepts(TaskSpecSchema, {
        id: "ci::unit",
        command: "x",
        needs: undefined,
      }),
    ).toBe(false);
  });

  it("ConfigureInput round-trips with a task carrying no os attributes", () => {
    const bytes =
      '{"name":"ci","origin":null,"sha":null,"workspace":"/repo",' +
      '"tasks":[{"id":"ci::unit","name":"ci::unit","command":"just ci::unit","needs":[]}]}';
    expect(roundTrip(ConfigureInputSchema, bytes)).toBe(bytes);
  });

  it("an empty task list is refused (zod's .min(1))", () => {
    expect(
      accepts(ConfigureInputSchema, {
        name: "ci",
        origin: null,
        sha: null,
        workspace: "/repo",
        tasks: [],
      }),
    ).toBe(false);
  });
});

describe("lease outputs — the two unions the coordinator narrows on", () => {
  it("claim: every arm round-trips on its `status` discriminant", () => {
    for (const bytes of [
      '{"status":"held"}',
      '{"status":"busy","heldBy":{"holder":"srid","run":"26d2c2d#1","sinceMs":1700000000000}}',
      '{"status":"busy","heldBy":null}',
      '{"status":"error","error":"flock: permission denied"}',
    ]) {
      expect(roundTrip(LeaseClaimOutputSchema, bytes)).toBe(bytes);
    }
  });

  it("probe: every arm round-trips on its `state` discriminant", () => {
    for (const bytes of [
      '{"state":"free","heldBy":null}',
      '{"state":"busy","heldBy":{"holder":"srid","run":null,"sinceMs":1700000000000}}',
      '{"state":"busy","heldBy":null}',
      '{"state":"error","error":"no such file"}',
    ]) {
      expect(roundTrip(LeaseProbeOutputSchema, bytes)).toBe(bytes);
    }
  });
});

describe("RunRecord — the durable ledger manifest", () => {
  const RECORD_NODE =
    '{"id":"ci::unit@x86_64-linux","name":"ci::unit","status":"ok","exitCode":0,"durationMs":1234}';
  const BASE =
    '{"version":1,"repo":"juspay/odu","sha":"26d2c2d0000000000000000000000000000000ab",' +
    '"seq":2,"dirty":false,"pipeline":"ci","outcome":"passed",' +
    '"startedAt":1700000000000,"finishedAt":1700000009999,' +
    '"lanes":[{"platform":"x86_64-linux","host":"localhost"}],' +
    `"nodes":[${RECORD_NODE}]`;

  it("a record with NO unposted debt round-trips byte-for-byte", () => {
    const bytes = `${BASE}}`;
    expect(roundTrip(RunRecordSchema, bytes)).toBe(bytes);
  });

  it("a record WITH unposted debt round-trips byte-for-byte", () => {
    const bytes = `${BASE},"unposted":[{"context":"ci::unit@x86_64-linux","lastError":"403 rate limited","attempts":3}]}`;
    expect(roundTrip(RunRecordSchema, bytes)).toBe(bytes);
  });

  it("an unposted entry written BEFORE `attempts` existed still decodes", () => {
    // The whole reason `attempts` is optional: a reader that finds it absent
    // knows the count was not recorded, rather than being handed a fabricated
    // `0`. If this regressed, every such record would silently vanish from
    // `odu runs` — the ledger reader skips what it cannot parse.
    const bytes = `${BASE},"unposted":[{"context":"ci::unit@x86_64-linux","lastError":"403 rate limited"}]}`;
    expect(roundTrip(RunRecordSchema, bytes)).toBe(bytes);
    expect(accepts(UnpostedEntrySchema, { context: "c", lastError: "e" })).toBe(
      true,
    );
  });

  it("a record from an unknown FUTURE version is refused, not coerced", () => {
    expect(accepts(RunRecordSchema, { ...JSON.parse(`${BASE}}`), version: 2 })).toBe(
      false,
    );
  });
});
