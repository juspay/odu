import { describe, expect, it } from "bun:test";
import { type ContractLedger, contractLedgerMismatch, rowShape, surfaceFingerprint } from "@odu/cordis/contract";
import { CI_CONTRACT_VERSION, oduServiceSurface } from "@odu/service-client/surface";
import { ODU_SERVICE_EXPOSE } from "@odu/service-client/verbs";

const LEDGER: ContractLedger = {
  "2.4": "83be116bdd6efc03",
  "2.5": "5b69127e21682efd",
  "2.6": "e2f201e5520f3c25",
  "2.7": "3cf445349a1994c0",
};

describe("the ci row's contract", () => {
  it("is the last line of its ledger, and the surface is that line's", () => {
    const current = {
      version: CI_CONTRACT_VERSION,
      fingerprint: surfaceFingerprint(rowShape(oduServiceSurface, ODU_SERVICE_EXPOSE, ["service"])),
    };
    const mismatch = contractLedgerMismatch("the ci row", "CI_CONTRACT_VERSION", current, LEDGER);
    expect(mismatch, mismatch ?? "").toBeNull();
  });
});
