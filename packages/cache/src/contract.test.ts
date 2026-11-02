/**
 * THE CACHE ROW'S VERSION, HELD TO ITS SURFACE.
 *
 * `PIN` is the version this row publishes and the fingerprint of the surface
 * that version describes (`@odu/cordis/contract`). Change the surface without
 * moving `CACHE_CONTRACT_VERSION` and this fails, naming the bump rule: the MINOR when the
 * surface only grows, the MAJOR when something a reader already uses changes.
 * Then re-pin to the pair the message prints.
 */

import { describe, expect, it } from "bun:test";
import { contractPinMismatch, rowShape, surfaceFingerprint } from "@odu/cordis/contract";
import { CACHE_CONTRACT_VERSION, ODU_CACHE_EXPOSE, oduCacheSurface } from "./surface";

const PIN = { version: "2.4", fingerprint: "ce07c59972729e8e" };

describe("the cache row's contract", () => {
  it("is pinned to the surface its version describes", () => {
    const current = {
      version: CACHE_CONTRACT_VERSION,
      fingerprint: surfaceFingerprint(rowShape(oduCacheSurface, ODU_CACHE_EXPOSE)),
    };
    const mismatch = contractPinMismatch("the cache row", "CACHE_CONTRACT_VERSION", current, PIN);
    expect(mismatch, mismatch ?? "").toBeNull();
  });
});
