import { describe, expect, it } from "bun:test";
import { type ContractLedger, contractLedgerMismatch, rowShape, surfaceFingerprint } from "@odu/cordis/contract";
import { CACHE_CONTRACT_VERSION, ODU_CACHE_EXPOSE, oduCacheSurface } from "./surface";

const LEDGER: ContractLedger = {
  "2.4": "ce07c59972729e8e",
  "3.0": "8988b569266ac6a6",
  "3.1": "585f670f12a0d425",
  "4.0": "500e6115015b54b2",
  "4.1": "75a8d40ef7202061",
  "4.2": "0d639bc2b90f11e8",
  "4.3": "95162ed3ed6003ad",
  "4.4": "7922ebb8aef0d7da",
  "4.5": "37e28294bbd765b7",
  "4.6": "fe3f87418079d1b7",
  "4.7": "a318983ddb5cebdb",
  "4.8": "a5bb71441d42f75f",
  "4.9": "2ebaa92b37473d69",
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

  it("offers a retention to plan with, and none to collect by", () => {
    const fieldsOf = (schema: unknown): string[] =>
      Object.keys((schema as { fields: Record<string, unknown> }).fields);
    const gc = oduCacheSurface.spec.procedures.gc;
    expect(fieldsOf(gc.plan.input)).toContain("retentionDays");
    expect(fieldsOf(gc.run.input)).not.toContain("retentionDays");
  });
});
