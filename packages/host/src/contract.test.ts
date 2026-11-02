/**
 * THE HOST'S VERSION, HELD TO ITS SURFACE — and the proof that a row moving its
 * own major does not move anybody else's admission.
 *
 * The host's surface is what no row owns: the frozen control fragment it mounts
 * as `control`, the identity cell every client is admitted on (served on the
 * runs' root, versioned here), and the two host routes a face reads before it
 * draws. `PIN` holds `HOST_CONTRACT_VERSION` to a fingerprint of exactly that;
 * the rows hold their own beside their surfaces.
 */

import { describe, expect, it } from "bun:test";
import { controlCoreSurface } from "@kolu/surface-daemon/control-core";
import {
  contractPinMismatch,
  rowShape,
  surfaceFingerprint,
  surfaceTags,
} from "@odu/cordis/contract";
import { SERVICE_DOOR_PATH, SERVICE_ROWS_PATH } from "@odu/cordis/services";
import { ODU_SERVICE_EXPOSE } from "@odu/service-client/verbs";
import { HOST_CONTRACT_VERSION, oduServiceSurface } from "@odu/service-client/surface";

const PIN = { version: "2.5", fingerprint: "f1d5f6253fd77c08" };

/** The identity cell, as the runs' root serves it: its spec entry, its tags
 *  and its exposure — everything `rowShape` omits from the ci row's print. */
function identityCell() {
  const whole = rowShape(oduServiceSurface, ODU_SERVICE_EXPOSE);
  const runs = rowShape(oduServiceSurface, ODU_SERVICE_EXPOSE, ["service"]);
  return {
    spec: oduServiceSurface.spec.cells.service,
    tags: whole.tags.filter((tag) => !runs.tags.includes(tag)),
    expose: ODU_SERVICE_EXPOSE.service,
  };
}

describe("the host's contract", () => {
  it("is pinned to the surface its version describes", () => {
    const cell = identityCell();
    const current = {
      version: HOST_CONTRACT_VERSION,
      fingerprint: surfaceFingerprint({
        spec: {
          control: controlCoreSurface.spec,
          identity: cell.spec,
          routes: [SERVICE_DOOR_PATH, SERVICE_ROWS_PATH],
        },
        tags: [...surfaceTags(controlCoreSurface), ...cell.tags],
        expose: { service: cell.expose },
      }),
    };
    const mismatch = contractPinMismatch("the host", "HOST_CONTRACT_VERSION", current, PIN);
    expect(mismatch, mismatch ?? "").toBeNull();
  });

  it("takes the identity cell out of the runs' print and nothing else", () => {
    // Non-vacuity: the omission must find the cell's tags, or the host would be
    // pinning an empty fragment and the runs a surface that still holds it.
    expect(identityCell().tags.length).toBeGreaterThan(0);
    expect(identityCell().tags.every((tag) => tag.startsWith("surface/service/"))).toBe(true);
  });
});
