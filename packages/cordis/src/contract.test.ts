/**
 * THE LEDGER'S SENTENCES — one per way a version and its surface can disagree.
 */

import { describe, expect, it } from "bun:test";
import { contractLedgerMismatch } from "./contract";

const LEDGER = { "2.4": "aaaa", "3.0": "bbbb" };
const judge = (version: string, fingerprint: string, ledger: Record<string, string> = LEDGER) =>
  contractLedgerMismatch("the cache row", "CACHE_CONTRACT_VERSION", { version, fingerprint }, ledger);

describe("contractLedgerMismatch", () => {
  it("agrees when the version is the last line and the surface is that line's", () => {
    expect(judge("3.0", "bbbb")).toBeNull();
  });

  it("asks for a bump and an APPENDED line when the surface moved under the same version", () => {
    const said = judge("3.0", "cccc");
    expect(said).toContain("surface changed but CACHE_CONTRACT_VERSION is still 3.0");
    expect(said).toContain("APPEND");
    expect(said).toContain("Never rewrite the 3.0 line");
  });

  it("asks for a new last line when the version moved past the ledger", () => {
    expect(judge("3.1", "cccc")).toContain('APPEND "3.1": "cccc"');
    // …and calls a bump with nothing to version what it is.
    expect(judge("3.1", "bbbb")).toContain("a bump with nothing to version is a lie");
  });

  it("refuses a version that moved backwards onto an older line", () => {
    expect(judge("2.4", "aaaa")).toContain("an OLDER line");
  });

  it("refuses a ledger out of order", () => {
    expect(judge("2.4", "aaaa", { "3.0": "bbbb", "2.4": "aaaa" })).toContain("out of order");
  });
});
