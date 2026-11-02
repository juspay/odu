/**
 * ADMISSION PER ROW — `admitService` judges the host's contract and then only
 * the rows a client NEEDS. These tests pin the four answers it gives (adopt, a
 * host refusal, a row refusal, an absent row) and the reading of a daemon from
 * before 2.5, which publishes no `rows`.
 */

import { describe, expect, it } from "bun:test";
import {
  admitService,
  CI_CONTRACT_VERSION,
  CI_NEEDS,
  CI_ROW,
  HOST_CONTRACT_VERSION,
  ifMounted,
  requires,
  type ServiceCell,
  skewNote,
  UNKNOWN_SERVICE,
} from "./surface";

const WHERE = "http://127.0.0.1:18440";

function daemon(protocolVersion: string, rows?: Record<string, string>): ServiceCell {
  return {
    ...UNKNOWN_SERVICE,
    identity: {
      ...UNKNOWN_SERVICE.identity,
      protocolVersion,
      ...(rows === undefined ? {} : { rows }),
    },
  };
}

/** A daemon whose cache has moved a major past the runs. */
const MOVED = daemon(HOST_CONTRACT_VERSION, { [CI_ROW]: CI_CONTRACT_VERSION, other: "3.0" });

describe("admitService, per row", () => {
  it("adopts a runs-only client whatever another row speaks", () => {
    expect(admitService(MOVED, WHERE, CI_NEEDS).kind).toBe("adopt");
  });

  it("refuses a client that needs the moved row, naming it", () => {
    const verdict = admitService(MOVED, WHERE, { ...CI_NEEDS, other: requires("2.4") });
    expect(verdict).toMatchObject({
      kind: "refuse",
      on: "row",
      row: "other",
      speaks: "3.0",
      expected: "2.4",
    });
    if (verdict.kind === "refuse") expect(verdict.message).toContain("other");
  });

  it("refuses a needed row the daemon does not mount, with that fact", () => {
    const verdict = admitService(MOVED, WHERE, { absent: requires("1.0") });
    expect(verdict).toMatchObject({ kind: "refuse", on: "absent", row: "absent" });
    expect(verdict).not.toHaveProperty("speaks");
    if (verdict.kind === "refuse") expect(verdict.message).toContain("does not mount the absent row");
  });

  it("passes an `ifMounted` row that is absent, and judges it when present", () => {
    expect(admitService(MOVED, WHERE, { absent: ifMounted("1.0") }).kind).toBe("adopt");
    expect(admitService(MOVED, WHERE, { other: ifMounted("2.4") })).toMatchObject({
      kind: "refuse",
      row: "other",
    });
  });

  it("refuses on the host's major before it looks at a row", () => {
    const verdict = admitService(daemon("3.0", { [CI_ROW]: CI_CONTRACT_VERSION }), WHERE, CI_NEEDS);
    expect(verdict).toMatchObject({ kind: "refuse", on: "host", speaks: "3.0" });
    expect(verdict).not.toHaveProperty("row");
  });

  it("reads a daemon from before 2.5 as speaking its one number for every row", () => {
    // The composed-wire era: `protocolVersion` covered every row at once.
    expect(admitService(daemon("2.4"), WHERE, CI_NEEDS).kind).toBe("adopt");
    expect(admitService(daemon("2.4"), WHERE, { other: requires("3.0") })).toMatchObject({
      kind: "refuse",
      row: "other",
      speaks: "2.4",
    });
  });

  it("notes, per row, every needed row whose minor is behind", () => {
    const behind = daemon(HOST_CONTRACT_VERSION, { [CI_ROW]: "2.1", other: "2.0" });
    const note = skewNote(behind, WHERE, { [CI_ROW]: requires("2.4"), other: requires("2.0") });
    expect(note).toContain(`${CI_ROW} 2.1 (this build 2.4)`);
    expect(note).not.toContain("other");
    expect(skewNote(MOVED, WHERE, CI_NEEDS)).toBeNull();
  });
});
