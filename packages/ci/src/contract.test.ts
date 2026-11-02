/**
 * THE CI ROW'S VERSION, HELD TO ITS SURFACE.
 *
 * `PIN` is the version this row publishes and the fingerprint of the surface
 * that version describes (`@odu/cordis/contract`). Change the surface without
 * moving `CI_CONTRACT_VERSION` and this fails, naming the bump rule: the MINOR when the
 * surface only grows, the MAJOR when something a reader already uses changes.
 * Then re-pin to the pair the message prints.
 *
 * The identity cell (`service`) is SERVED on this surface but is the host's
 * fact, so it is left out here and pinned in `packages/host/src/contract.test.ts`
 * against the host's version — each fact is versioned once.
 */

import { describe, expect, it } from "bun:test";
import { contractPinMismatch, rowShape, surfaceFingerprint } from "@odu/cordis/contract";
import { CI_CONTRACT_VERSION, oduServiceSurface } from "@odu/service-client/surface";
import { ODU_SERVICE_EXPOSE } from "@odu/service-client/verbs";

const PIN = { version: "2.4", fingerprint: "83be116bdd6efc03" };

describe("the ci row's contract", () => {
  it("is pinned to the surface its version describes", () => {
    const current = {
      version: CI_CONTRACT_VERSION,
      fingerprint: surfaceFingerprint(rowShape(oduServiceSurface, ODU_SERVICE_EXPOSE, ["service"])),
    };
    const mismatch = contractPinMismatch("the ci row", "CI_CONTRACT_VERSION", current, PIN);
    expect(mismatch, mismatch ?? "").toBeNull();
  });
});
