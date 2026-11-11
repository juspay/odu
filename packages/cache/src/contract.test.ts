/**
 * THE CACHE ROW'S VERSION, HELD TO ITS SURFACE.
 *
 * `LEDGER` is every version this row has published, in order, each with the
 * fingerprint of the surface it described (`@odu/cordis/contract`). It is
 * APPEND-ONLY: a bump adds a line, and an edited old line is a surface change
 * shipped under an old number. Change the surface without
 * moving `CACHE_CONTRACT_VERSION` and this fails, naming the bump rule: the MINOR when the
 * surface only grows, the MAJOR when something a reader already uses changes.
 * Then append the line the message prints.
 */

import { describe, expect, it } from "bun:test";
import { type ContractLedger, contractLedgerMismatch, rowShape, surfaceFingerprint } from "@odu/cordis/contract";
import { CACHE_CONTRACT_VERSION, ODU_CACHE_EXPOSE, oduCacheSurface } from "./surface";

const LEDGER: ContractLedger = {
  "2.4": "ce07c59972729e8e",
  "3.0": "8988b569266ac6a6",
  "3.1": "585f670f12a0d425",
  // 4.0 shipped on master.
  "4.0": "500e6115015b54b2",
  // 4.1 — PLAN 2.8: `readsFrom` on a bucket row and on `bucket.describe`,
  // `publicUrl` on a declared store, `migration` on a bucket row, and the
  // `bucket.migrate` verb. Every one of them additive.
  "4.1": "75a8d40ef7202061",
  // 4.2 — PLAN 2.9: `writesTo` on a bucket row, the one fact the push
  // negotiation answers from. Additive.
  "4.2": "0d639bc2b90f11e8",
  // 4.3 — `bucket.delete`: a bucket, its objects, its tokens and its pins
  // taken away in one verb. Additive.
  "4.3": "95162ed3ed6003ad",
  // 4.4 — PLAN 2.7's open item: `gc.plan` takes a `retentionDays` to plan
  // with, which `gc.run` deliberately does not. Additive.
  "4.4": "7922ebb8aef0d7da",
  // 4.5 — `bucket.paths` takes `group`, `name`, `sort` and `descending`, and
  // answers `groups` beside `paths`: a bucket grouped by package and ordered
  // BY THE ROW, counted over the whole of it rather than over whichever page
  // a reader happens to hold. Additive.
  "4.5": "37e28294bbd765b7",
  // 4.6 — PLAN 4.1: `label` on a token, so the bucket page's Tokens list can
  // say `run <id>` for a credential odu minted for a run rather than leaving
  // an operator to wonder who issued it. An optional output field; additive.
  "4.6": "fe3f87418079d1b7",
  // 4.7 — PLAN 4.2: `run` and `commit` on a path and on a package's newest
  // version, so a bucket page can say which run put a path there and which
  // commit it was built from. Two optional output fields, opaque to the
  // cache; additive.
  "4.7": "346ebeaeb97365c8",
};

describe("the cache row's contract", () => {
  it("is the last line of its ledger, and the surface is that line's", () => {
    const current = {
      version: CACHE_CONTRACT_VERSION,
      fingerprint: surfaceFingerprint(rowShape(oduCacheSurface, ODU_CACHE_EXPOSE)),
    };
    const mismatch = contractLedgerMismatch("the cache row", "CACHE_CONTRACT_VERSION", current, LEDGER);
    expect(mismatch, mismatch ?? "").toBeNull();
  });

  /**
   * THE SPLIT IS THE GUARANTEE, so it is held here rather than described in a
   * doc: `gc.plan` takes a retention to ask WITH, and `gc.run` has no such
   * field on the wire at all. A caller cannot hand a collection a retention
   * it would then evict by, whatever any handler does with its input.
   */
  it("offers a retention to plan with, and none to collect by", () => {
    const fieldsOf = (schema: unknown): string[] =>
      Object.keys((schema as { fields: Record<string, unknown> }).fields);
    const gc = oduCacheSurface.spec.procedures.gc;
    expect(fieldsOf(gc.plan.input)).toContain("retentionDays");
    expect(fieldsOf(gc.run.input)).not.toContain("retentionDays");
  });
});
