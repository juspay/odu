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
    expect(attempt?.logComplete).toBe(false);
    expect(attempt?.logTruncationReason).toContain(".ci");
    expect(attempt?.logTruncationReason).toContain("overwrote it on rerun");
  });

  it("leaves an attempt with no surviving log addressable and empty", () => {
    const repoRoot = legacyCheckout([record()], {});
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
    const finalized = entries.filter((e) => e.event.kind === "finalized");
    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.event).toEqual({ kind: "finalized", outcome: "failed" });
    expect(finalized[0]?.at).toBe(1_700_000_060_000);
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
    importCheckout({ root, repoRoot });

    expect(fingerprint(repoRoot)).toEqual(before);
  });
});
