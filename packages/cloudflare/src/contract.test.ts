import { describe, expect, it } from "bun:test";
import { type ContractLedger, contractLedgerMismatch, rowShape, surfaceFingerprint } from "@odu/cordis/contract";
import { CLOUDFLARE_CONTRACT_VERSION, ODU_CLOUDFLARE_EXPOSE, oduCloudflareSurface } from "./surface";

const LEDGER: ContractLedger = {
  "2.4": "660b6c1d98a3651a",
};

describe("the cloudflare row's contract", () => {
  it("is the last line of its ledger, and the surface is that line's", () => {
    const current = {
      version: CLOUDFLARE_CONTRACT_VERSION,
      fingerprint: surfaceFingerprint(rowShape(oduCloudflareSurface, ODU_CLOUDFLARE_EXPOSE)),
    };
    const mismatch = contractLedgerMismatch("the cloudflare row", "CLOUDFLARE_CONTRACT_VERSION", current, LEDGER);
    expect(mismatch, mismatch ?? "").toBeNull();
  });
});
