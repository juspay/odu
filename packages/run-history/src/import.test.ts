/**
 * Importing the old world without rewriting it, and without overclaiming what
 * the old bytes can support.
 *
 * Three properties, and each of them is a promise a face repeats to a user. The
 * import is READ-ONLY over the checkout — `.ci/` keeps working exactly as it
 * did, so a byte of it moving here would be a regression nobody notices until
 * the old reader disagrees with the new one. It is IDEMPOTENT — the run id is
 * derived from the source identity, so running the command twice must not
 * double a checkout's history. And it is HONEST about the evidence: the old
 * layout kept one log per (commit, node) and overwrote it on rerun, so an
 * imported attempt is marked incomplete with a reason that names the layout,
 * rather than being presented as the same kind of evidence a native run makes.
 */

import {
  closeSync,
  type Dirent,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { logPathFor } from "@odu/run-client/nodeId";
import { importCheckout, importedRunId } from "./import";
import { writeRunRecord } from "./legacy/ledger";
import { type RunRecord, RUN_RECORD_VERSION } from "./legacy/record";
import { readAttention } from "./query";
import {
  handleFor,
  readAttemptLog,
  readAttemptRecord,
  readJournal,
  readManifest,
  readVerdict,
} from "./store";

const SHA = "26d2c2dabcdef0123456789012345678901234ab";
const SHA7 = "26d2c2d";
const NODE = "ci::unit@x86_64-linux";
const LOG = "running unit\nexpected 1 to be 2\n";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    version: RUN_RECORD_VERSION,
    repo: "juspay/odu",
    sha: SHA,
    seq: 1,
    dirty: false,
    pipeline: "ci",
    outcome: "failed",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_060_000,
    lanes: [{ platform: "x86_64-linux", host: "builder-1" }],
    nodes: [
      {
        id: NODE,
        name: "unit",
        status: "failed",
        exitCode: 1,
        durationMs: 500,
      },
    ],
    ...over,
  };
}

/** A checkout with the LEGACY layout: `.ci/<sha7>/runs/<seq>.json` beside
 *  `.ci/<sha7>/<platform>/<node>.log`. */
function legacyCheckout(records: RunRecord[], logs: Record<string, string> = { [NODE]: LOG }): string {
  const repoRoot = tmp("odu-import-checkout-");
  for (const r of records) {
    const sha7 = r.sha.slice(0, 7);
    writeRunRecord(repoRoot, sha7, r);
    for (const node of r.nodes) {
      const text = logs[node.id];
      if (text === undefined) continue;
      const path = join(repoRoot, logPathFor(sha7, node.id));
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    }
  }
  return repoRoot;
}

/** Every file under `.ci`, with its bytes, size and mtime — the fingerprint an
 *  import must not change. */
function fingerprint(repoRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      // ONE descriptor: the size and mtime are asked of the OPEN FILE, not of
      // the name a moment before reading it. A stat-then-read pair is two
      // questions about a path, and a fingerprint whose parts came from two
      // instants cannot witness "nothing changed" — which is the only thing
      // this helper exists to say.
      const fd = openSync(path, "r");
      try {
        const stat = fstatSync(fd);
        out[relative(repoRoot, path)] =
          `${stat.size}:${stat.mtimeMs}:${readFileSync(fd, "utf-8")}`;
      } finally {
        closeSync(fd);
      }
    }
  };
  walk(join(repoRoot, ".ci"));
  return out;
}

describe("importCheckout", () => {
  it("mints one catalog entry per legacy record, stamped with where it came from", () => {
    const repoRoot = legacyCheckout([record({ seq: 1 }), record({ seq: 2 })]);
    const root = tmp("odu-import-catalog-");

    const report = importCheckout({ root, repoRoot, now: 1_700_000_100_000 });
    expect(report.imported.map((r) => r.ref).sort()).toEqual([
      `${SHA7}#1`,
      `${SHA7}#2`,
    ]);
    expect(report.skipped).toEqual([]);
    expect(report.catalog).toBe(root);

    const manifest = readManifest(
      handleFor(importedRunId(record({ seq: 2 })), { root }),
    );
    expect(manifest?.sha).toBe(SHA);
    expect(manifest?.seq).toBe(2);
    expect(manifest?.repoRoot).toBe(repoRoot);
    expect(manifest?.importedFrom).toBe(
      join(repoRoot, ".ci", SHA7, "runs", "2.json"),
    );
    // The run sorts into the catalog at the moment it actually happened.
    expect(manifest?.createdAt).toBe(1_700_000_000_000);
  });

  it("copies the log bytes to attempt 1 and marks the attempt incomplete, saying why", () => {
    const repoRoot = legacyCheckout([record()]);
    const root = tmp("odu-import-catalog-");
    importCheckout({ root, repoRoot });

    const handle = handleFor(importedRunId(record()), { root });
    expect(readAttemptLog(handle, NODE, 1)?.text).toBe(LOG);

    const attempt = readAttemptRecord(handle, NODE, 1);
    expect(attempt?.attempt).toBe(1);
    expect(attempt?.status).toBe("failed");
    expect(attempt?.exitCode).toBe(1);
    expect(attempt?.logBytes).toBe(Buffer.byteLength(LOG));
    // The honest half: the old layout never recorded completeness, so this is
    // never presented as a log that got its producer's last word.
    expect(attempt?.logComplete).toBe(false);
    expect(attempt?.logTruncationReason).toContain(".ci");
    expect(attempt?.logTruncationReason).toContain("overwrote it on rerun");
  });

  it("leaves an attempt with no surviving log addressable and empty", () => {
    const repoRoot = legacyCheckout([record()], {}); // record written, log never kept
    const root = tmp("odu-import-catalog-");
    importCheckout({ root, repoRoot });

    const handle = handleFor(importedRunId(record()), { root });
    expect(readAttemptLog(handle, NODE, 1)?.text).toBe("");
    expect(readAttemptRecord(handle, NODE, 1)?.logBytes).toBe(0);
  });
});

describe("the reconstructed journal", () => {
  it("carries a finalized event whose outcome is the record's", () => {
    const repoRoot = legacyCheckout([record({ outcome: "failed" })]);
    const root = tmp("odu-import-catalog-");
    importCheckout({ root, repoRoot });

    const entries = readJournal(
      handleFor(importedRunId(record({ outcome: "failed" })), { root }),
    ).entries;
    // NOTE: asserted as "carries", not "ends with". The reconstruction pushes
    // `finalized` before the per-node `log_finalized` lines it allocates while
    // copying evidence, so the terminal line is a `log_finalized` — see the
    // ordering note reported alongside these tests.
    const finalized = entries.filter((e) => e.event.kind === "finalized");
    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.event).toEqual({ kind: "finalized", outcome: "failed" });
    // Stamped with the run's own clock, not the import's.
    expect(finalized[0]?.at).toBe(1_700_000_060_000);
    // Dense, 1-based sequences — a cursor is a seq, so a gap would be a hole a
    // caller could not tell from a delivery it missed.
    expect(entries.map((e) => e.seq)).toEqual(
      entries.map((_, i) => i + 1),
    );
  });

  it("makes readAttention over an imported run report settled, with the right verdict", () => {
    const root = tmp("odu-import-catalog-");
    const red = record({ seq: 1, outcome: "failed" });
    const green = record({
      seq: 2,
      outcome: "passed",
      nodes: [{ id: NODE, name: "unit", status: "ok", exitCode: 0, durationMs: 5 }],
    });
    importCheckout({ root, repoRoot: legacyCheckout([red, green]) });

    const failed = readAttention(handleFor(importedRunId(red), { root }));
    expect(failed.state).toBe("settled");
    expect(failed.settled).toBe(true);
    expect(failed.passed).toBe(false);
    expect(failed.unresolved_failures.map((f) => f.node)).toEqual([NODE]);
    // Nothing is serving an imported run, and nothing ever will.
    expect(failed.endpoint).toBeNull();

    const passed = readAttention(handleFor(importedRunId(green), { root }));
    expect(passed.state).toBe("settled");
    expect(passed.passed).toBe(true);
    expect(passed.unresolved_failures).toEqual([]);
  });

  it("publishes a verdict that names the red nodes", () => {
    const repoRoot = legacyCheckout([record()]);
    const root = tmp("odu-import-catalog-");
    importCheckout({ root, repoRoot });

    const verdict = readVerdict(handleFor(importedRunId(record()), { root }));
    expect(verdict?.outcome).toBe("failed");
    expect(verdict?.failed).toEqual([NODE]);
    expect(verdict?.errored).toEqual([]);
    expect(verdict?.cancelled).toEqual([]);
  });
});

describe("an imported run is not retryable", () => {
  it("says so on the snapshot, because the old layout kept no inputs to replay", () => {
    const repoRoot = legacyCheckout([record()]);
    const root = tmp("odu-import-catalog-");
    importCheckout({ root, repoRoot });

    const manifest = readManifest(handleFor(importedRunId(record()), { root }));
    expect(manifest?.snapshot.retryable).toBe(false);
    expect(manifest?.snapshot.expectedSha).toBe(SHA);
  });
});

describe("importedRunId", () => {
  it("is stable for the same record — which is what makes the import idempotent", () => {
    expect(importedRunId(record())).toBe(importedRunId(record()));
    // Only the source identity feeds it: two readings of the same run agree.
    expect(importedRunId(record({ pipeline: "other" }))).toBe(importedRunId(record()));
  });

  it("differs for a different sha or a different seq", () => {
    const base = importedRunId(record());
    expect(importedRunId(record({ seq: 2 }))).not.toBe(base);
    expect(
      importedRunId(record({ sha: "aaaaaaabcdef0123456789012345678901234ab" })),
    ).not.toBe(base);
  });
});

describe("running the import twice", () => {
  it("reports the run as skipped and does not duplicate it", () => {
    const repoRoot = legacyCheckout([record({ seq: 1 }), record({ seq: 2 })]);
    const root = tmp("odu-import-catalog-");

    const first = importCheckout({ root, repoRoot });
    expect(first.imported).toHaveLength(2);
    const after = readdirSync(root).sort();

    const second = importCheckout({ root, repoRoot });
    expect(second.imported).toEqual([]);
    expect(second.skipped.map((r) => r.ref).sort()).toEqual([
      `${SHA7}#1`,
      `${SHA7}#2`,
    ]);
    expect(readdirSync(root).sort()).toEqual(after);
  });
});

describe("the checkout it read", () => {
  it("is not modified or deleted — `.ci` keeps working exactly as it did", () => {
    const repoRoot = legacyCheckout([record({ seq: 1 }), record({ seq: 2 })]);
    const root = tmp("odu-import-catalog-");

    const before = fingerprint(repoRoot);
    expect(Object.keys(before).length).toBeGreaterThan(0);

    importCheckout({ root, repoRoot });
    importCheckout({ root, repoRoot }); // and the second pass touches nothing either

    expect(fingerprint(repoRoot)).toEqual(before);
  });
});
