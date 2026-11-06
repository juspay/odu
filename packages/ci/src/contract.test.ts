/**
 * THE CI ROW'S VERSION, HELD TO ITS SURFACE.
 *
 * `LEDGER` is every version this row has published, in order, each with the
 * fingerprint of the surface it described (`@odu/cordis/contract`). It is
 * APPEND-ONLY: a bump adds a line, and an edited old line is a surface change
 * shipped under an old number. Change the surface without
 * moving `CI_CONTRACT_VERSION` and this fails, naming the bump rule: the MINOR when the
 * surface only grows, the MAJOR when something a reader already uses changes.
 * Then append the line the message prints.
 *
 * The identity cell (`service`) is SERVED on this surface but is the host's
 * fact, so it is left out here and pinned in `packages/host/src/contract.test.ts`
 * against the host's version — each fact is versioned once.
 */

import { describe, expect, it } from "bun:test";
import { type ContractLedger, contractLedgerMismatch, rowShape, surfaceFingerprint } from "@odu/cordis/contract";
import { CI_CONTRACT_VERSION, oduServiceSurface } from "@odu/service-client/surface";
import { ODU_SERVICE_EXPOSE } from "@odu/service-client/verbs";

const LEDGER: ContractLedger = {
  "2.4": "83be116bdd6efc03",
  // 2.5 — PLAN 4.1: `push` on a run row and on a wait/read answer (where this
  // run pushes, why it does not, and what it warmed), and `pushed` on a node
  // — its paths, its bytes and the push's own time. Optional output fields;
  // additive.
  "2.5": "5b69127e21682efd",
  // 2.6 — PLAN 4.4: `actor` on a run row and on a wait/read answer — who
  // started the run, a login or `@local` for a loopback caller. One optional
  // output field in two places; additive.
  "2.6": "e4a1146a4226f81d",
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
