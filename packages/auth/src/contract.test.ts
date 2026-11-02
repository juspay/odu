/**
 * THE AUTH ROW'S VERSION, HELD TO ITS SURFACE.
 *
 * `LEDGER` is every version this row has published, in order, each with the
 * fingerprint of the surface it described (`@odu/cordis/contract`). It is
 * APPEND-ONLY: a bump adds a line, and an edited old line is a surface change
 * shipped under an old number. Change the surface without
 * moving `AUTH_CONTRACT_VERSION` and this fails, naming the bump rule: the MINOR when the
 * surface only grows, the MAJOR when something a reader already uses changes.
 * Then append the line the message prints.
 */

import { describe, expect, it } from "bun:test";
import { type ContractLedger, contractLedgerMismatch, rowShape, surfaceFingerprint } from "@odu/cordis/contract";
import { AUTH_CONTRACT_VERSION, ODU_AUTH_EXPOSE, oduAuthSurface } from "./surface";

const LEDGER: ContractLedger = {
  "2.4": "a567ba5fcc47b5ee",
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
