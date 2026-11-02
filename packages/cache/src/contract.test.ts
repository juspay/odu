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
});
