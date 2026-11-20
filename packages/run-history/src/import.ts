import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { logPathFor } from "@odu/run-client/nodeId";
import { writeAtomic } from "./atomic";
import { shortSha } from "@odu/run-client/nodeId";
import { encodeNodeKey } from "./ids";
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
 * the import idempotent: the same `.ci` record always lands on the same run id.
 */
export function importedRunId(
  record: Pick<RunRecord, "repo" | "sha" | "seq" | "startedAt">,
): string {
  const ts = Math.floor(record.startedAt).toString(36).padStart(8, "0");
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
      retryable: false,
    },
    build: { oduVersion: "imported", self: null, runnerFlake: null },
    registeredBy: {
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
