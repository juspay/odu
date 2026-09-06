/**
 * Importing the old world — reading a checkout's `.ci/` history into the
 * catalog, on purpose and by name.
 *
 * Before this package, odu's durable history was checkout-scoped: a run record
 * at `.ci/<sha7>/runs/<seq>.json` and per-node logs at
 * `.ci/<sha7>/<platform>/<node>.log`. Those files are still readable, still
 * read by `odu runs`, and are NOT rewritten by anything here — the old layout
 * keeps working exactly as it did, which is the compatibility half of this
 * release.
 *
 * What is offered instead is an EXPLICIT import: `odu history import` walks a
 * checkout's `.ci/` and mints a catalog entry per old record, so a
 * long-running checkout's history follows its owner into the per-user catalog
 * rather than being stranded. Explicit because two properties of the old
 * format make an automatic migration dishonest:
 *
 *   - AN OLD RECORD HAS NO ATTEMPTS. `.ci` keeps one log per (commit, node) and
 *     a rerun overwrote it, so an imported run has exactly attempt 1 and its
 *     log is whatever survived. Presenting that as the same kind of evidence a
 *     native run produces would be a claim the bytes cannot support, so an
 *     imported attempt is marked `logComplete: false` with a reason that says
 *     which layout it came from.
 *   - AN OLD RECORD HAS NO JOURNAL. The events below are RECONSTRUCTED from the
 *     record's terminal node list — they are what must have happened, not what
 *     was observed. `importedFrom` on the manifest is how a reader tells the
 *     two apart, and every face that shows an imported run should say so.
 *
 * Nothing here deletes anything. An import that runs twice is a no-op for runs
 * already imported (the run id is derived from the source identity, so the
 * second pass finds the directory already there).
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { logPathFor } from "@odu/run-client/nodeId";
import { writeAtomic } from "./atomic";
import { encodeNodeKey, shortSha } from "./ids";
import { readLedger } from "./legacy/ledger";
import type { RunRecord } from "./legacy/record";
import { ATTEMPT_FILES, attemptDir, RUN_FILES } from "./paths";
import {
  type AttemptRecord,
  type JournalEntry,
  RUN_RECORD_FORMAT,
  type RunManifest,
  type RunVerdict,
} from "./schema";
import {
  type CatalogOptions,
  catalogPath,
  handleFor,
  readManifest,
  type RunHandle,
} from "./store";

/**
 * The run id an imported record gets.
 *
 * DERIVED from the source identity rather than minted, and that is what makes
 * the import idempotent: the same `.ci` record always lands on the same run id,
 * so a second import finds the directory and skips it instead of producing a
 * duplicate history that grows every time somebody runs the command.
 *
 * The time half is the run's own `startedAt`, so an imported run sorts into the
 * catalog at the moment it actually happened — which is the whole point of
 * importing it rather than appending it.
 */
export function importedRunId(record: RunRecord): string {
  const ts = Math.floor(record.startedAt).toString(36).padStart(8, "0");
  // A stable tail from the record's own identity: same commit + same ordinal =
  // same id, different ones never collide. Hashed to base36 so the id keeps the
  // shape `isRunId` accepts.
  let hash = 0x811c9dc5;
  for (const ch of `${record.repo ?? ""}|${record.sha}|${record.seq}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${ts}-i${hash.toString(36).padStart(7, "0")}`;
}

export interface ImportOptions extends CatalogOptions {
  /** The checkout to read `.ci/` from. */
  repoRoot: string;
  /** Report what would be imported and write nothing. */
  dryRun?: boolean;
  now?: number;
}

export interface ImportReport {
  /** Run ids created by this pass. */
  imported: { runId: string; ref: string }[];
  /** Records already present in the catalog. */
  skipped: { runId: string; ref: string }[];
  /** Where the catalog is, so a caller can say what it wrote to. */
  catalog: string;
}

/** Import every legacy record in a checkout. */
export function importCheckout(opts: ImportOptions): ImportReport {
  const report: ImportReport = {
    imported: [],
    skipped: [],
    catalog: catalogPath(opts),
  };
  for (const record of readLedger(opts.repoRoot)) {
    const runId = importedRunId(record);
    const ref = `${shortSha(record.sha)}#${record.seq}`;
    const handle = handleFor(runId, opts);
    if (readManifest(handle) !== null) {
      report.skipped.push({ runId, ref });
      continue;
    }
    if (!opts.dryRun) importOne(handle, record, opts);
    report.imported.push({ runId, ref });
  }
  return report;
}

/**
 * Write one legacy record into the catalog.
 *
 * No ownership epoch is claimed: an imported run is finished by definition, so
 * there is nothing to fence and claiming would leave a corpse owner behind.
 * The manifest's `owner` records the import itself — epoch 1, no endpoint, a
 * heartbeat at the import instant — which is what a reader needs to see that
 * nothing is serving this run and nothing ever will.
 */
function importOne(
  handle: RunHandle,
  record: RunRecord,
  opts: ImportOptions,
): void {
  const now = opts.now ?? Date.now();
  const sha7 = shortSha(record.sha);
  mkdirSync(handle.dir, { recursive: true });

  const manifest: RunManifest = {
    version: RUN_RECORD_FORMAT,
    runId: handle.runId,
    repo: record.repo,
    sha: record.sha,
    seq: record.seq,
    pipeline: record.pipeline,
    repoRoot: opts.repoRoot,
    createdAt: record.startedAt,
    scope: { selectors: [], platforms: [], noDeps: false },
    snapshot: {
      mode: record.dirty ? "live" : "strict",
      expectedSha: record.sha,
      dirty: record.dirty,
      // Never: the old layout kept no snapshot inputs, so a retry of an
      // imported run has nothing to replay. Refusing is the honest answer and
      // this field is where it is decided.
      retryable: false,
    },
    build: { oduVersion: "imported", self: null, runnerFlake: null },
    owner: {
      epoch: 1,
      pid: 0,
      host: "",
      claimedAt: now,
      heartbeatAt: 0,
      endpoint: null,
    },
    parentRunId: null,
    requestId: null,
    importedFrom: join(opts.repoRoot, ".ci", sha7, "runs", `${record.seq}.json`),
  };
  writeAtomic(
    join(handle.dir, RUN_FILES.manifest),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  // The reconstructed journal. Every line is stamped with the record's own
  // clock rather than the import's, so a face that renders event times shows
  // when the run happened; the events themselves are marked as reconstructed by
  // the manifest's `importedFrom`, not by a per-event flag nobody would read.
  const entries: JournalEntry[] = [];
  let seq = 0;
  const push = (at: number, event: JournalEntry["event"]): void => {
    seq += 1;
    entries.push({ seq, at, event });
  };
  push(record.startedAt, {
    kind: "registered",
    scope: manifest.scope,
  });
  push(record.startedAt, {
    kind: "roster",
    order: record.nodes.map((n) => n.id),
  });
  for (const lane of record.lanes) {
    push(record.startedAt, {
      kind: "lane",
      platform: lane.platform,
      state: "leased",
      host: lane.host,
    });
  }
  for (const node of record.nodes) {
    const placement = {
      platform: platformOf(node.id),
      host: hostFor(record, node.id),
    };
    push(record.startedAt, {
      kind: "attempt_started",
      node: node.id,
      attempt: 1,
      placement,
    });
    push(record.finishedAt, {
      kind: "node_status",
      node: node.id,
      attempt: 1,
      status: node.status,
      exitCode: node.exitCode,
      durationMs: node.durationMs,
      placement,
    });
  }
  for (const owed of record.unposted ?? []) {
    push(record.finishedAt, {
      kind: "posting_debt",
      context: owed.context,
      lastError: owed.lastError,
      attempts: owed.attempts ?? 0,
    });
  }

  // Copy the evidence and stamp each attempt, THEN write the journal — so a
  // reader that finds a `log_finalized` line always finds the bytes it
  // describes. (The loop below appends those lines as it copies.)
  for (const node of record.nodes) {
    const source = join(opts.repoRoot, logPathFor(sha7, node.id));
    const dir = attemptDir(handle.dir, encodeNodeKey(node.id), 1);
    mkdirSync(dir, { recursive: true });
    let bytes = 0;
    if (existsSync(source)) {
      try {
        copyFileSync(source, join(dir, ATTEMPT_FILES.log));
        bytes = statSync(join(dir, ATTEMPT_FILES.log)).size;
      } catch {
        bytes = 0;
      }
    } else {
      writeAtomic(join(dir, ATTEMPT_FILES.log), "");
    }
    const reason =
      "imported from the checkout-scoped `.ci` layout, which kept one log per " +
      "(commit, node) and overwrote it on rerun — completeness was never recorded";
    const attempt: AttemptRecord = {
      version: RUN_RECORD_FORMAT,
      node: node.id,
      attempt: 1,
      placement: {
        platform: platformOf(node.id),
        host: hostFor(record, node.id),
      },
      startedAt: record.startedAt,
      endedAt: record.finishedAt,
      status: node.status,
      exitCode: node.exitCode,
      signal: null,
      logBytes: bytes,
      logComplete: false,
      logTruncationReason: reason,
    };
    writeAtomic(
      join(dir, ATTEMPT_FILES.record),
      `${JSON.stringify(attempt, null, 2)}\n`,
    );
    seq += 1;
    entries.push({
      seq,
      at: record.finishedAt,
      event: {
        kind: "log_finalized",
        node: node.id,
        attempt: 1,
        bytes,
        complete: false,
        reason,
      },
    });
  }
  // The terminal LAST, after every `log_finalized` the copy loop appended.
  // `foldJournal` is order-insensitive, but a cursor reader is not: events
  // delivered after a `finalized` line would be a run still talking about
  // itself past its own ending.
  push(record.finishedAt, { kind: "finalized", outcome: record.outcome });
  entries.sort((a, b) => a.seq - b.seq);
  writeAtomic(
    join(handle.dir, RUN_FILES.events),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );

  const verdict: RunVerdict = {
    version: RUN_RECORD_FORMAT,
    runId: handle.runId,
    outcome: record.outcome,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    failed: record.nodes.filter((n) => n.status === "failed").map((n) => n.id),
    errored: record.nodes.filter((n) => n.status === "errored").map((n) => n.id),
    cancelled: record.nodes
      .filter((n) => n.status === "cancelled")
      .map((n) => n.id),
    unposted: (record.unposted ?? []).map((u) => ({
      context: u.context,
      lastError: u.lastError,
      attempts: u.attempts ?? 0,
    })),
  };
  writeAtomic(
    join(handle.dir, RUN_FILES.verdict),
    `${JSON.stringify(verdict, null, 2)}\n`,
  );
}

function platformOf(nodeId: string): string {
  const at = nodeId.lastIndexOf("@");
  return at > 0 ? nodeId.slice(at + 1) : "unknown";
}

function hostFor(record: RunRecord, nodeId: string): string | null {
  const platform = platformOf(nodeId);
  return record.lanes.find((l) => l.platform === platform)?.host ?? null;
}
