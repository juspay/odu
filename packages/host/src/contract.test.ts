/**
 * THE HOST'S VERSION, HELD TO ITS SURFACE — and the proof that a row moving its
 * own major does not move anybody else's admission.
 *
 * The host's surface is what no row owns: the frozen control fragment it mounts
 * as `control`, the identity cell every client is admitted on (served on the
 * runs' root, versioned here), and the two host routes a face reads before it
 * draws. `LEDGER` holds `HOST_CONTRACT_VERSION` to a fingerprint of exactly that
 * (append-only, as every row's is);
 * the rows hold their own beside their surfaces.
 */

import { describe, expect, it } from "bun:test";
import { controlCoreSurface } from "@kolu/surface-daemon/control-core";
import {
  type ContractLedger,
  contractLedgerMismatch,
  rowShape,
  surfaceFingerprint,
  surfaceTags,
} from "@odu/cordis/contract";
import { SERVICE_DOOR_PATH, SERVICE_ROWS_PATH } from "@odu/cordis/services";
import { ODU_SERVICE_EXPOSE } from "@odu/service-client/verbs";
import {
  admitService,
  CI_CONTRACT_VERSION,
  CI_NEEDS,
  CI_ROW,
  HOST_CONTRACT_VERSION,
  oduServiceSurface,
  requires,
  type ServiceCell,
  UNKNOWN_SERVICE,
} from "@odu/service-client/surface";
import { CACHE_CONTRACT_VERSION, CACHE_KEY, CACHE_NEEDS } from "@odu/cache/surface";

const LEDGER: ContractLedger = {
  "2.5": "ede33df851613ad9",
};

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
  it("is the last line of its ledger, and the surface is that line's", () => {
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
    const mismatch = contractLedgerMismatch("the host", "HOST_CONTRACT_VERSION", current, LEDGER);
    expect(mismatch, mismatch ?? "").toBeNull();
  });

  it("takes the identity cell out of the runs' print and nothing else", () => {
    // Non-vacuity: the omission must find the cell's tags, or the host would be
    // pinning an empty fragment and the runs a surface that still holds it.
    expect(identityCell().tags.length).toBeGreaterThan(0);
    expect(identityCell().tags.every((tag) => tag.startsWith("surface/service/"))).toBe(true);
  });
});

/**
 * THE PROOF, on this build's own numbers: the cache row has taken two majors
 * of its own (3.0 when `held` went, 4.0 when retention moved to `lastWanted`)
 * while the host stayed on 2.x — so a reader of the runs is adopted and a
 * reader of an older cache is refused, by name.
 */
describe("this daemon, after the cache row's own major", () => {
  /** What this build's daemon publishes: the host's version, and each mounted
   *  row's own, as the roster gathers them. */
  const THIS_DAEMON: ServiceCell = {
    ...UNKNOWN_SERVICE,
    identity: {
      ...UNKNOWN_SERVICE.identity,
      protocolVersion: HOST_CONTRACT_VERSION,
      rows: { [CI_ROW]: CI_CONTRACT_VERSION, [CACHE_KEY]: CACHE_CONTRACT_VERSION },
    },
  };

  it("moved the cache a major and left the host and the runs on 2.x", () => {
    expect(CACHE_CONTRACT_VERSION.split(".")[0]).toBe("4");
    expect(HOST_CONTRACT_VERSION.split(".")[0]).toBe("2");
    expect(CI_CONTRACT_VERSION.split(".")[0]).toBe("2");
  });

  it("adopts a client that needs only the runs at 2.x — kolu's padi", () => {
    expect(admitService(THIS_DAEMON, "here", CI_NEEDS).kind).toBe("adopt");
    expect(admitService(THIS_DAEMON, "here", { [CI_ROW]: requires("2.0") }).kind).toBe("adopt");
  });

  it("adopts the client that SHIPS with this build — `odu cache`'s own needs", () => {
    // `CACHE_NEEDS` is what `src/main.ts` dials the cache with, and the board
    // is this build's own bundle. A major bump that left a shipped client
    // behind would be a daemon nobody here can talk to, which is the whole
    // thing per-row versions exist to make visible.
    expect(admitService(THIS_DAEMON, "here", CACHE_NEEDS).kind).toBe("adopt");
    // Non-vacuity: those needs really do name the new major, so this is not
    // a tautology about a constant that could have stayed at 3.1.
    expect(CACHE_NEEDS[CACHE_KEY].requires.split(".")[0]).toBe("4");
  });

  it("refuses a client pinned to the cache this build replaced", () => {
    // The previous major, by name: a client that hard-coded `3.1` reads
    // `lastAccessed`, which 4.0 removed.
    expect(admitService(THIS_DAEMON, "here", { [CACHE_KEY]: requires("3.1") })).toMatchObject({
      kind: "refuse",
      on: "row",
      row: CACHE_KEY,
      speaks: CACHE_CONTRACT_VERSION,
      expected: "3.1",
    });
    // And kolu, which admits on `ci` alone, does not notice any of it.
    expect(admitService(THIS_DAEMON, "here", CI_NEEDS).kind).toBe("adopt");
  });

  it("refuses a client that needs a 2.x cache, naming the cache row", () => {
    const verdict = admitService(THIS_DAEMON, "here", { [CACHE_KEY]: requires("2.4") });
    expect(verdict).toMatchObject({
      kind: "refuse",
      on: "row",
      row: CACHE_KEY,
      speaks: CACHE_CONTRACT_VERSION,
      expected: "2.4",
    });
  });
});
