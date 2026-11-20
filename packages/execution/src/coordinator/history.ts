import type { NodeStatus } from "@odu/run-client/surface";
import { type LogStream, splitFanId } from "@odu/run-client/nodeId";
import { signalFromExit } from "@odu/run-history/exit";
import { mintRunId } from "@odu/run-history/ids";
import {
  HEARTBEAT_INTERVAL_MS,
  heartbeat,
  releaseOwnership,
  type OwnershipToken,
} from "@odu/run-history/owner";
import { isResumptionEvent } from "@odu/run-history/schema";
import type { Placement, RunEvent, RunScope } from "@odu/run-history/schema";
import {
  appendAttemptLog,
  locateAttempt,
  readAttemptLog,
  type JournalWriter,
  openJournal,
  type RunHandle,
  readAttemptRecord,
  registerRun,
  sealAttempt,
  startAttempt,
  writeAttemptLog,
  writeVerdict,
} from "@odu/run-history/store";

const IN_FLIGHT: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  "pending",
  "running",
]);

export interface RunHistoryInit {
  repoRoot: string;
  repo: string | null;
  branch?: string | null;
  sha: string;
  seq: number | null;
  pipeline: string;
  scope: RunScope;
  hostPins: readonly string[];
  hostsFile: string;
  snapshotMode: "strict" | "live";
  contentSha?: string;
  overlay?: { count: number; paths: string[] };
  dirty: boolean;
  runnerFlake: string | null;
  oduVersion: string;
  endpoint: string;
  parentRunId?: string | null;
  requestId?: string | null;
  actor?: string;
  runId?: string;

  push?: {
    target: { substituter: string; bucket: string; tokenId: string } | null;
    skipped: string | null;
    keyWarning: string | null;
  };
  catalogRoot?: string;
  now?: () => number;
}

export interface RunHistory {
  readonly runId: string | null;
  readonly fenced: boolean;
  roster: (order: readonly string[]) => void;
  phase: (phase: "provisioning" | "lanes" | "no_lanes") => void;
  lane: (
    platform: string,
    state: "claiming" | "leased",
    host: string | null,
    pool: readonly string[],
    hostsSource: string | null,
  ) => void;
  nodeStatus: (
    node: string,
    status: NodeStatus,
    outcome: {
      exitCode: number | null;
      durationMs: number | null;
      host: string | null;
    },
  ) => void;
  log: (
    node: string,
    text: string,
    host?: string | null,
    stream?: LogStream,
  ) => void;
  logFinalized: (node: string, complete: boolean, reason: string | null) => void;
  replaceLog: (
    node: string,
    text: string,
    host?: string | null,
    stream?: LogStream,
  ) => void;
  resetNode: (node: string, reason: string) => void;
  postingDebt: (
    rows: readonly { context: string; lastError: string; attempts: number }[],
  ) => void;
  pushing: (fact: {
    node: string;
    bucket: string;
    durationMs?: number | undefined;
  }) => void;
  pushed: (fact: {
    node: string;
    bucket: string;
    paths: number;
    present: number;
    bytes: number;
    durationMs: number;
  }) => void;
  pushFailed: (fact: {
    node: string;
    bucket: string;
    message: string;
    durationMs: number;
  }) => void;
  currentAttempt: (node: string) => number;
  retryAccepted: (accepted: {
    requestId: string;
    inputDigest: string;
    roots: readonly string[];
    resetDependants: readonly string[];
  }) => boolean;
  retryApplied: (resolved: {
    requestId: string;
    node: string;
    applied: boolean;
  }) => void;
  finalize: (verdict: {
    outcome: "passed" | "failed" | "incomplete";
    startedAt: number;
    finishedAt: number;
    failed: readonly string[];
    errored: readonly string[];
    cancelled: readonly string[];
    unposted: readonly { context: string; lastError: string; attempts: number }[];
  }) => void;
  close: () => void;
}

export const NO_HISTORY: RunHistory = {
  runId: null,
  fenced: false,
  roster: () => {},
  phase: () => {},
  lane: () => {},
  nodeStatus: () => {},
  log: () => {},
  logFinalized: () => {},
  replaceLog: () => {},
  resetNode: () => {},
  postingDebt: () => {},
  pushing: () => {},
  pushed: () => {},
  pushFailed: () => {},
  currentAttempt: () => 0,
  retryAccepted: () => false,
  retryApplied: () => {},
  finalize: () => {},
  close: () => {},
};

interface OpenAttempt {
  attempt: number;
  placement: Placement;
  outcome?: { status: NodeStatus; exitCode: number | null };
  log?: { complete: boolean; reason: string | null };
}

export function openRunHistory(init: RunHistoryInit): RunHistory {
  const now = init.now ?? Date.now;
  const opts = init.catalogRoot === undefined ? {} : { root: init.catalogRoot };
  let handle: RunHandle;
  let token: OwnershipToken;
  try {
    const registered = registerRun(
      {
        runId: init.runId ?? mintRunId(now()),
        repo: init.repo,
        sha: init.sha,
        seq: init.seq,
        pipeline: init.pipeline,
        ...(init.branch === undefined || init.branch === null
          ? {}
          : { branch: init.branch }),
        repoRoot: init.repoRoot,
        createdAt: now(),
        scope: init.scope,
        hostPins: [...init.hostPins],
        hostsFile: init.hostsFile,
        snapshot: {
          mode: init.snapshotMode,
          ...(init.contentSha === undefined ? {} : { contentSha: init.contentSha }),
          ...(init.overlay === undefined ? {} : { overlay: init.overlay }),
          expectedSha: init.sha,
          dirty: init.dirty,
          retryable: init.snapshotMode === "strict" && !init.dirty,
        },
        build: {
          oduVersion: init.oduVersion,
          self: process.env.ODU_SELF ?? null,
          runnerFlake: init.runnerFlake,
        },
        parentRunId: init.parentRunId ?? null,
        requestId: init.requestId ?? null,
        ...(init.actor === undefined ? {} : { actor: init.actor }),
        ...(init.push === undefined ? {} : { push: init.push }),
      },
      { ...opts, endpoint: init.endpoint, now: now() },
    );
    if (!registered.ok) return NO_HISTORY;
    handle = registered.handle;
    token = registered.token;
  } catch {
    return NO_HISTORY;
  }

  const journal: JournalWriter = openJournal(handle, token);
  let fenced = false;
  let finalized = false;
  let resumedSinceFinalized = false;
  const open = new Map<string, OpenAttempt>();
  const highest = new Map<string, number>();
  const said = new Map<string, { complete: boolean; reason: string | null }>();
  const attemptKey = (node: string, attempt: number): string =>
    `${node}#${attempt}`;

  const emit = (event: RunEvent): void => {
    if (fenced) return;
    if (finalized && isResumptionEvent(event)) resumedSinceFinalized = true;
    try {
      if (journal.append(event, now()) === null) fenced = true;
    } catch {
    }
  };

  const placementOf = (node: string, host: string | null): Placement => ({
    platform: splitFanId(node).platform,
    host,
  });

  const seal = (
    node: string,
    current: OpenAttempt,
    fallbackReason: string | null,
  ): void => {
    open.delete(node);
    if (fenced) return;
    const log = current.log;
    try {
      sealAttempt(handle, token, node, current.attempt, {
        endedAt: now(),
        status: current.outcome?.status ?? null,
        exitCode: current.outcome?.exitCode ?? null,
        signal: signalFromExit(current.outcome?.exitCode ?? null),
        logComplete: log?.complete ?? false,
        logTruncationReason:
          log === undefined
            ? (fallbackReason ?? "no producer said this log was finished")
            : log.reason,
      });
    } catch {
    }
  };

  const sealIfComplete = (node: string): void => {
    const current = open.get(node);
    if (current === undefined) return;
    if (current.outcome === undefined || current.log === undefined) return;
    seal(node, current, null);
  };

  const beginAttempt = (node: string, host: string | null): void => {
    if (fenced) return;
    if (open.has(node)) return;
    const attempt = (highest.get(node) ?? 0) + 1;
    const placement = placementOf(node, host);
    try {
      if (
        !startAttempt(handle, token, {
          node,
          attempt,
          placement,
          startedAt: now(),
        })
      ) {
        return;
      }
    } catch {
      return;
    }
    highest.set(node, attempt);
    open.set(node, { attempt, placement });
    emit({ kind: "attempt_started", node, attempt, placement });
  };

  const amendSealedLog = (
    node: string,
    attempt: number,
    complete: boolean,
    reason: string | null,
  ): void => {
    if (fenced) return;
    try {
      const existing = readAttemptRecord(handle, node, attempt);
      if (existing === null) return;
      sealAttempt(handle, token, node, attempt, {
        endedAt: existing.endedAt ?? now(),
        status: existing.status,
        exitCode: existing.exitCode,
        signal: existing.signal,
        logComplete: complete,
        logTruncationReason: reason,
      });
    } catch {
    }
  };

  const heart = setInterval(() => {
    if (fenced) return;
    try {
      if (!heartbeat(token, now())) fenced = true;
    } catch {
    }
  }, HEARTBEAT_INTERVAL_MS);
  heart.unref?.();

  return {
    get runId() {
      return handle.runId;
    },
    get fenced() {
      return fenced;
    },
    roster: (order) => emit({ kind: "roster", order: [...order] }),
    phase: (phase) => emit({ kind: "phase", phase }),
    lane: (platform, state, host, pool, hostsSource) =>
      emit({ kind: "lane", platform, state, host, pool: [...pool], hostsSource }),
    nodeStatus: (node, status, outcome) => {
      if (status !== "pending") beginAttempt(node, outcome.host);
      const current = open.get(node);
      if (current?.placement.host === null && outcome.host !== null) {
        const placement = placementOf(node, outcome.host);
        try {
          if (locateAttempt(handle, token, node, current.attempt, placement))
            current.placement = placement;
        } catch {
        }
      }
      const attempt = current?.attempt ?? highest.get(node) ?? 1;
      emit({
        kind: "node_status",
        node,
        attempt,
        status,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        placement: placementOf(node, outcome.host),
      });
      if (IN_FLIGHT.has(status) || current === undefined) return;
      current.outcome = { status, exitCode: outcome.exitCode };
      sealIfComplete(node);
    },
    log: (node, text, host = null, stream = "recipe") => {
      if (fenced) return;
      if (!open.has(node)) beginAttempt(node, host);
      const attempt = open.get(node)?.attempt;
      if (attempt === undefined) return;
      appendAttemptLog(handle, node, attempt, text, stream);
    },
    logFinalized: (node, complete, reason) => {
      const current = open.get(node);
      const attempt = current?.attempt ?? highest.get(node);
      if (attempt === undefined) return;
      const key = attemptKey(node, attempt);
      if (said.has(key)) return;
      said.set(key, { complete, reason });
      emit({ kind: "log_finalized", node, attempt, bytes: 0, complete, reason });
      if (current === undefined) {
        amendSealedLog(node, attempt, complete, reason);
        return;
      }
      current.log = { complete, reason };
      sealIfComplete(node);
    },
    replaceLog: (node, text, host = null, stream = "recipe") => {
      if (fenced) return;
      if (!open.has(node)) beginAttempt(node, host);
      const attempt = open.get(node)?.attempt;
      if (attempt === undefined) return;
      const held = readAttemptLog(handle, node, attempt, {}, stream)?.text ?? "";
      if (held !== "" && held.endsWith(text)) {
        return;
      }
      const overlap = longestOverlap(held, text);
      if (overlap > 0 || held === "") {
        appendAttemptLog(handle, node, attempt, text.slice(overlap), stream);
        return;
      }
      writeAttemptLog(
        handle,
        node,
        attempt,
        held === ""
          ? text
          :
            "[odu] log truncated: this node's output ran ahead of the recorder" +
              " — what follows does not continue what precedes it\n" +
              text,
        stream,
      );
    },
    resetNode: (node, reason) => {
      const current = open.get(node);
      if (current === undefined) return;
      seal(node, current, reason);
    },
    postingDebt: (rows) => {
      for (const row of rows) {
        emit({
          kind: "posting_debt",
          context: row.context,
          lastError: row.lastError,
          attempts: row.attempts,
        });
      }
    },
    pushing: ({ node, bucket, durationMs }) =>
      emit({
        kind: "pushing",
        node,
        bucket,
        ...(durationMs === undefined ? {} : { durationMs }),
      }),
    pushed: ({ node, bucket, paths, present, bytes, durationMs }) =>
      emit({ kind: "pushed", node, bucket, paths, present, bytes, durationMs }),
    pushFailed: ({ node, bucket, message, durationMs }) =>
      emit({ kind: "push_failed", node, bucket, message, durationMs }),
    currentAttempt: (node) => highest.get(node) ?? 0,
    retryAccepted: ({ requestId, inputDigest, roots, resetDependants }) => {
      if (fenced) return false;
      emit({
        kind: "retry_accepted",
        requestId,
        effectiveRunId: handle.runId,
        roots: [...roots],
        resetDependants: [...resetDependants],
        inputDigest,
      });
      return !fenced;
    },
    retryApplied: ({ requestId, node, applied }) => {
      if (fenced) return;
      emit({ kind: "retry_applied", requestId, node, applied });
    },
    finalize: (verdict) => {
      if (fenced) return;
      for (const [node, current] of [...open.entries()]) {
        seal(
          node,
          current,
          "the run ended before this node's output was complete",
        );
      }
      try {
        writeVerdict(handle, token, {
          runId: handle.runId,
          outcome: verdict.outcome,
          startedAt: verdict.startedAt,
          finishedAt: verdict.finishedAt,
          failed: [...verdict.failed],
          errored: [...verdict.errored],
          cancelled: [...verdict.cancelled],
          unposted: verdict.unposted.map((u) => ({ ...u })),
        });
      } catch {
      }
      if (!finalized || resumedSinceFinalized) {
        finalized = true;
        resumedSinceFinalized = false;
        emit({ kind: "finalized", outcome: verdict.outcome });
      }
    },
    close: () => {
      clearInterval(heart);
      if (fenced) return;
      try {
        releaseOwnership(token, now());
      } catch {
      }
    },
  };
}

export function longestOverlap(held: string, snapshot: string): number {
  const most = Math.min(held.length, snapshot.length);
  for (let n = most; n > 0; n -= 1) {
    if (held.endsWith(snapshot.slice(0, n))) return n;
  }
  return 0;
}
