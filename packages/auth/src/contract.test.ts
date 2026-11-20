import { describe, expect, it } from "bun:test";
import { type ContractLedger, contractLedgerMismatch, rowShape, surfaceFingerprint } from "@odu/cordis/contract";
import { AUTH_CONTRACT_VERSION, ODU_AUTH_EXPOSE, oduAuthSurface } from "./surface";

const LEDGER: ContractLedger = {
  "2.4": "c7abf8b321276149",
};

describe("the auth row's contract", () => {
  it("is the last line of its ledger, and the surface is that line's", () => {
    const current = {
      version: AUTH_CONTRACT_VERSION,
      fingerprint: surfaceFingerprint(rowShape(oduAuthSurface, ODU_AUTH_EXPOSE)),
    };
    const mismatch = contractLedgerMismatch("the auth row", "AUTH_CONTRACT_VERSION", current, LEDGER);
    expect(mismatch, mismatch ?? "").toBeNull();
  });
});
