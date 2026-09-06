/**
 * Receipts — the property that a mutation asked for twice is performed once.
 *
 * The failure this file exists for is not a race. It is an agent whose reply
 * was lost asking again, and getting a SECOND run for one request. So the
 * claim, not the result, is what has to be exclusive, and the interesting
 * assertions are all about the second caller:
 *
 *   - EXACTLY ONE CLAIMANT. `claimReceipt` returns `claimed` once and never
 *     again for that id; the loser is told `in_flight` or `replay`, which are
 *     different instructions and must not be confused.
 *   - A FILE IT CANNOT READ IS NOT FREE. A torn receipt reports `in_flight`
 *     with nothing to reconcile against — the one case where "I don't know"
 *     has to beat "go ahead", because going ahead is the duplicate run.
 *   - THE FIRST ANSWER WINS. `completeReceipt` on an already-completed receipt
 *     leaves the first result in place, so a reconciler racing the original
 *     caller cannot rewrite what was already told to somebody.
 *   - A REQUEST ID BECOMES A FILENAME. `isRequestId` is therefore a gate and
 *     not a nicety: a caller that can name a file can name any file.
 *
 * Easy to get wrong because every one of these is invisible on the happy path
 * — a suite that only claims once and completes once passes with the exclusion
 * removed. Every test writes into a catalog root of its own; a suite that
 * touched the developer's real `~/.local/state/odu` is a suite nobody can run
 * twice.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  claimReceipt,
  completeReceipt,
  digestOf,
  isRequestId,
  listReceipts,
  readReceipt,
} from "./receipts";
import { RUN_RECORD_FORMAT, type RunManifest } from "./schema";
import { registerRun, type RunHandle } from "./store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = 1_700_000_000_000;
const SHA = "26d2c2dabcdef0123456789012345678901234ab";
const RUN_ID = "0000000a-0001";
const PLANNED = "0000000b-0002";

type ManifestInput = Omit<RunManifest, "version" | "registeredBy">;

/** A registered run of our own, in a catalog of our own. Receipts live beside
 *  a run's journal, so a receipt needs a run before it needs anything else. */
function aRun(): RunHandle {
  const root = mkdtempSync(join(tmpdir(), "odu-receipts-"));
  dirs.push(root);
  const input: ManifestInput = {
    runId: RUN_ID,
    repo: "juspay/odu",
    sha: SHA,
    seq: 1,
    pipeline: "ci",
    repoRoot: "/checkouts/odu",
    createdAt: T0,
    scope: { selectors: ["e2e"], platforms: [], noDeps: false },
    snapshot: { mode: "strict", expectedSha: SHA, dirty: false, retryable: true },
    build: { oduVersion: "0.1.0", self: null, runnerFlake: null },
    parentRunId: null,
    requestId: null,
  };
  const result = registerRun(input, { root, endpoint: null, now: T0 });
  if (!result.ok) throw new Error(`registration refused: ${result.refusal.reason}`);
  return result.handle;
}

/** The claim every test starts from, so a test states only what it varies. */
function claim(
  handle: RunHandle,
  over: Partial<Parameters<typeof claimReceipt>[1]> = {},
) {
  return claimReceipt(handle, {
    requestId: "req-1",
    kind: "retry",
    digest: digestOf([RUN_ID, "unit"]),
    plannedRunId: PLANNED,
    journalAtAccept: 0,
    now: T0,
    ...over,
  });
}

/** Where a receipt file actually lands, for the tests that have to corrupt
 *  one. Spelled here rather than exported: a test that had to import the path
 *  builder would be testing the builder. */
function receiptFile(handle: RunHandle, requestId: string): string {
  return join(handle.dir, "receipts", `${requestId}.json`);
}

describe("claiming a request id", () => {
  it("hands the id to exactly one caller and tells the loser to wait", () => {
    const handle = aRun();

    const first = claim(handle);
    expect(first?.kind).toBe("claimed");
    expect(first?.receipt.state).toBe("accepted");
    expect(first?.receipt.plannedRunId).toBe(PLANNED);
    expect(first?.receipt.result).toBeNull();
    expect(first?.receipt.version).toBe(RUN_RECORD_FORMAT);

    // The same request arriving again while the first has not finished. NOT
    // `claimed` — a second `claimed` is a second run for one request — and not
    // `replay` either, because there is no answer to replay yet.
    const second = claim(handle);
    expect(second?.kind).toBe("in_flight");
    expect(second?.receipt.plannedRunId).toBe(PLANNED);
  });

  it("replays the recorded result once the work is known to have happened", () => {
    const handle = aRun();
    claim(handle);
    completeReceipt(handle, "req-1", { mode: "relaunched", run: PLANNED }, T0 + 5);

    const again = claim(handle);
    expect(again?.kind).toBe("replay");
    expect(again?.receipt.state).toBe("completed");
    expect(again?.receipt.completedAt).toBe(T0 + 5);
    // Verbatim: two asks must not get two different descriptions of one action.
    expect(again?.receipt.result).toEqual({ mode: "relaunched", run: PLANNED });
  });

  it("refuses the same id carrying different input", () => {
    // Two requests wearing one id is a caller bug, and answering it with
    // either outcome would be worse than saying so.
    const handle = aRun();
    claim(handle);

    const other = claim(handle, { digest: digestOf([RUN_ID, "e2e"]) });
    expect(other?.kind).toBe("conflict");
    // The refusal carries what is ON DISK, so a caller can see what the id was
    // spent on rather than being shown its own rejected request back.
    expect(other?.receipt.digest).toBe(digestOf([RUN_ID, "unit"]));
  });

  it("treats a receipt it cannot read as taken, never as free", () => {
    // A torn write, or a record from a build that knew a field this one does
    // not. Reading it as free would do the work twice — the single failure the
    // whole mechanism exists to prevent — so "I don't know" beats "go ahead".
    const handle = aRun();
    mkdirSync(join(handle.dir, "receipts"), { recursive: true });
    writeFileSync(receiptFile(handle, "req-1"), '{"version":1,"requestId":"req-1"');

    expect(readReceipt(handle, "req-1")).toBeNull();

    const outcome = claim(handle);
    expect(outcome?.kind).toBe("in_flight");
    // And with an empty planned id: there is nothing to reconcile against, so
    // the caller must refuse rather than go looking for a run that has no name.
    expect(outcome?.receipt.plannedRunId).toBe("");
  });

  it("returns null and writes nothing for an id it will not put on a disk", () => {
    const handle = aRun();
    expect(claim(handle, { requestId: "../../etc/passwd" })).toBeNull();
    expect(claim(handle, { requestId: "" })).toBeNull();
    expect(existsSync(join(handle.dir, "receipts"))).toBe(false);
    expect(listReceipts(handle)).toEqual([]);
  });
});

describe("completing a receipt", () => {
  it("keeps the FIRST result when it is completed twice", () => {
    // A reconciler and the original caller can both arrive at a receipt that is
    // accepted-but-not-completed. History has one version.
    const handle = aRun();
    claim(handle);

    const first = completeReceipt(handle, "req-1", { answer: "first" }, T0 + 1);
    const second = completeReceipt(handle, "req-1", { answer: "second" }, T0 + 2);

    expect(first?.result).toEqual({ answer: "first" });
    expect(second?.result).toEqual({ answer: "first" });
    expect(second?.completedAt).toBe(T0 + 1);
    expect(readReceipt(handle, "req-1")?.result).toEqual({ answer: "first" });
  });

  it("has nothing to complete for an id nobody claimed", () => {
    const handle = aRun();
    expect(completeReceipt(handle, "never-claimed", { answer: "x" }, T0)).toBeNull();
  });
});

describe("isRequestId", () => {
  it("refuses every spelling that could name a file other than its own", () => {
    expect(isRequestId("")).toBe(false);
    expect(isRequestId(".")).toBe(false);
    expect(isRequestId("..")).toBe(false);
    expect(isRequestId("a/b")).toBe(false);
    expect(isRequestId("../escape")).toBe(false);
    // Leading `-` is refused too: an id is also a token that lands in argv,
    // and one that starts like a flag is a caller's problem to spell better.
    expect(isRequestId("-leading-dash")).toBe(false);
    expect(isRequestId("x".repeat(129))).toBe(false);
  });

  it("accepts the ids callers actually generate", () => {
    expect(isRequestId("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(true);
    expect(isRequestId("agent.retry.7")).toBe(true);
    expect(isRequestId("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    expect(isRequestId("x".repeat(128))).toBe(true);
  });
});

describe("digestOf", () => {
  it("is stable for the same parts and different for different ones", () => {
    expect(digestOf([RUN_ID, "unit", "", 0])).toBe(digestOf([RUN_ID, "unit", "", 0]));
    expect(digestOf([RUN_ID, "unit", "", 0])).not.toBe(
      digestOf([RUN_ID, "e2e", "", 0]),
    );
    // Order is part of the input, not an accident of it: the same parts in a
    // different order are a different request.
    expect(digestOf(["a", "b"])).not.toBe(digestOf(["b", "a"]));
    // Types are canonicalised, so a caller that spells an ordinal as a number
    // and one that spells it as a string agree.
    expect(digestOf(["a", 1, true])).toBe(digestOf(["a", "1", "true"]));
  });

  it("gives an absent part and an empty one one spelling", () => {
    // The retry policy spells "no expected attempt" as `""` and `0` rather than
    // omitting the parts, so an empty list and a list of empties must not be
    // two different requests.
    expect(digestOf([])).toBe(digestOf([""]));
    expect(digestOf([])).toBe(digestOf([...[]]));
  });
});

describe("listReceipts", () => {
  it("returns every readable receipt, oldest first", () => {
    const handle = aRun();
    claim(handle, { requestId: "third", now: T0 + 300 });
    claim(handle, { requestId: "first", now: T0 + 100 });
    claim(handle, { requestId: "second", now: T0 + 200 });

    expect(listReceipts(handle).map((r) => r.requestId)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("skips what it cannot read rather than failing the whole listing", () => {
    const handle = aRun();
    claim(handle, { requestId: "good", now: T0 + 1 });
    writeFileSync(receiptFile(handle, "torn"), "{not json");

    expect(listReceipts(handle).map((r) => r.requestId)).toEqual(["good"]);
  });

  it("is empty for a run nobody has asked anything of", () => {
    expect(listReceipts(aRun())).toEqual([]);
  });
});
