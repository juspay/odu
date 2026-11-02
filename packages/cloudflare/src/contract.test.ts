/**
 * THE CLOUDFLARE ROW'S VERSION, HELD TO ITS SURFACE.
 *
 * `PIN` is the version this row publishes and the fingerprint of the surface
 * that version describes (`@odu/cordis/contract`). Change the surface without
 * moving `CLOUDFLARE_CONTRACT_VERSION` and this fails, naming the bump rule: the MINOR when the
 * surface only grows, the MAJOR when something a reader already uses changes.
 * Then re-pin to the pair the message prints.
 */

import { describe, expect, it } from "bun:test";
import { contractPinMismatch, rowShape, surfaceFingerprint } from "@odu/cordis/contract";
import { CLOUDFLARE_CONTRACT_VERSION, ODU_CLOUDFLARE_EXPOSE, oduCloudflareSurface } from "./surface";

const PIN = { version: "2.4", fingerprint: "660b6c1d98a3651a" };

describe("the cloudflare row's contract", () => {
  it("is pinned to the surface its version describes", () => {
    const current = {
      version: CLOUDFLARE_CONTRACT_VERSION,
      fingerprint: surfaceFingerprint(rowShape(oduCloudflareSurface, ODU_CLOUDFLARE_EXPOSE)),
    };
    const mismatch = contractPinMismatch("the cloudflare row", "CLOUDFLARE_CONTRACT_VERSION", current, PIN);
    expect(mismatch, mismatch ?? "").toBeNull();
  });
});
