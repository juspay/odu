/**
 * THE ADDRESS `odu ci run` HANDS OUT, read back by the thing that opens it.
 *
 * The printer and the reader are two halves of one spelling (`runHash` ·
 * `parseRunHash` in `@odu/service-client/routes`), and this line is the only
 * place a terminal mints one. It printed `<origin>/runs/<id>` for a while —
 * a bare pathname the board answers with its run LIST — so the assertion is
 * not on the text but on the round trip: whatever is printed must parse back
 * to the run it is about.
 */

import { describe, expect, it } from "bun:test";
import { parseRunHash } from "@odu/service-client/routes";
import type { StartReceipt } from "@odu/service-client/surface";
import { renderStart } from "./serviceCommands";

const RUN_ID = "0mwazpqpb-v6yd6b6p";

function receipt(extra: Partial<StartReceipt> = {}): StartReceipt {
  return {
    accepted: true,
    runId: RUN_ID,
    requestId: "req-1",
    replayed: false,
    sha: "3cbac8697a1f0c2d4e5b6a7980c1d2e3f4a5b6c7",
    scope: { selectors: [], platforms: [], noDeps: false },
    endpoint: null,
    cursor: "0",
    ...extra,
  };
}

/** The one printed line that carries a URL. */
function address(out: string): string {
  const found = out
    .split("\n")
    .map((line) => line.replace(/^odu · /, ""))
    .filter((line) => line.includes("://"));
  expect(found).toHaveLength(1);
  return found[0] as string;
}

describe("renderStart", () => {
  it("prints an address the board reads back as this run", () => {
    const out = renderStart(receipt(), "https://odu-k3s.example.ts.net");
    const url = address(out);
    expect(url).toBe(`https://odu-k3s.example.ts.net/#/run/${RUN_ID}`);
    expect(parseRunHash(new URL(url).hash)).toEqual({ runId: RUN_ID, log: null });
  });

  it("addresses the run it points at when one is already going there", () => {
    const out = renderStart(
      receipt({ accepted: false, existing: { runId: RUN_ID, sha: "3cbac86" } }),
      "http://127.0.0.1:18440",
    );
    expect(out).toContain("a run is already going in this checkout");
    expect(parseRunHash(new URL(address(out)).hash)).toEqual({
      runId: RUN_ID,
      log: null,
    });
  });

  it("joins an origin the caller typed with a trailing slash", () => {
    const url = address(renderStart(receipt(), "http://127.0.0.1:18440/"));
    expect(url).toBe(`http://127.0.0.1:18440/#/run/${RUN_ID}`);
    expect(parseRunHash(new URL(url).hash)?.runId).toBe(RUN_ID);
  });
});
