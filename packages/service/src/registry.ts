import { statSync } from "node:fs";
import { join } from "node:path";
import { attentionFor, type AttemptState, foldJournal } from "@odu/run-history/attention";
import { formatCursor } from "@odu/run-history/ids";
import { currentOwner, ownerAlive } from "@odu/run-history/owner";
import { RUN_FILES, runDir } from "@odu/run-history/paths";
import type {
  NodePush as FoldNodePush,
  Owner,
  RunManifest,
} from "@odu/run-history/schema";
import {
  type CatalogOptions,
  catalogPath,
  handleFor,
  listRunIds,
  readExpiry,
  readJournal,
  readManifest,
  readVerdict,
  type RunHandle,
} from "@odu/run-history/store";
import { newestFirst, runElapsedMs } from "@odu/service-client/board";
import { formatLogKey } from "@odu/service-client/logKey";
import type {
  NodePush,
  RunBoardState,
  RunEnv,
  RunLane,
  RunNode,
  RunPhase,
  RunRow,
} from "@odu/service-client/surface";

function wirePush(push: FoldNodePush): NodePush {
  switch (push.state) {
    case "pushing":
      return { state: "pushing" };
    case "pushed":
      return {
        state: "pushed",
        stored: push.stored,
        present: push.present,
        bytes: push.bytes,
        durationMs: push.durationMs,
      };
    case "failed":
      return { state: "failed", message: push.message, durationMs: push.durationMs };
  }
}

const FINGERPRINTED = [
  RUN_FILES.events,
  RUN_FILES.verdict,
  RUN_FILES.owner,
] as const;

function fingerprint(dir: string): string {
  const parts: string[] = [statPartOrMissing(dir)];
  for (const file of FINGERPRINTED) parts.push(statPartOrMissing(join(dir, file)));
  return parts.join("|");
}

const MISSING_FILE = "-";

function statPartOrMissing(path: string): string {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return MISSING_FILE;
  }
}

interface Entry {
  fingerprint: string;
  owner: Owner | null;
  alive: boolean | null;
  row: RunRow;
  nodes: RunNode[];
  env: RunEnv;
  pushTokenId: string | null;
}

function boardState(
  attentionState: "still_running" | "settled" | "owner_lost" | "expired" | "unknown_run",
  latest: ReadonlyMap<string, AttemptState>,
): RunBoardState {
  switch (attentionState) {
    case "settled":
      return "settled";
    case "owner_lost":
      return "owner_lost";
    case "expired":
    case "unknown_run":
      return "expired";
    case "still_running":
      return hasStartedWork(latest) ? "running" : "provisioning";
  }
}

function hasStartedWork(latest: ReadonlyMap<string, AttemptState>): boolean {
  return latest.size > 0;
}

function nodesOf(
  runId: string,
  roster: readonly string[],
  latest: ReadonlyMap<string, AttemptState>,
  push: ReadonlyMap<string, FoldNodePush>,
): RunNode[] {
  const ordered = [...roster];
  const seen = new Set(ordered);
  for (const node of latest.keys()) if (!seen.has(node)) ordered.push(node);
  const out: RunNode[] = [];
  for (const id of ordered) {
    const attempt = latest.get(id);
    if (attempt === undefined) {
      out.push({
        id,
        status: "pending",
        attempt: 0,
        exitCode: null,
        startedAt: null,
        durationMs: null,
        host: null,
        logKey: "",
      });
      continue;
    }
    const pushed = push.get(id);
    out.push({
      id,
      status: attempt.status ?? "running",
      attempt: attempt.attempt,
      exitCode: attempt.exitCode,
      startedAt: attempt.startedAt,
      durationMs: attempt.durationMs,
      host: attempt.placement.host,
      logKey: formatLogKey({ runId, node: id, attempt: attempt.attempt }),
      ...(pushed === undefined ? {} : { push: wirePush(pushed) }),
    });
  }
  return out;
}

function envOf(
  fold: ReturnType<typeof foldJournal>,
  row: RunRow,
  now: number,
): RunEnv {
  return {
    phase: fold.phase ?? fallbackPhase(fold.latest),
    elapsedMs: runElapsedMs(row, now),
    lanes: lanesOf(fold.lanes),
    hostsSource: fold.hostsSource,
    commitUrl:
      row.repo === null
        ? null
        : `https://github.com/${row.repo}/commit/${row.sha}`,
    owed: [...fold.debt.values()].map((debt) => ({
      context: debt.context,
      lastError: debt.lastError,
      attempts: debt.attempts,
    })),
  };
}

function fallbackPhase(latest: ReadonlyMap<string, AttemptState>): RunPhase {
  return hasStartedWork(latest) ? "lanes" : "provisioning";
}

function lanesOf(
  lanes: ReadonlyMap<
    string,
    { state: "claiming" | "leased"; host: string | null; pool: readonly string[] }
  >,
): RunLane[] {
  const out: RunLane[] = [];
  for (const platform of [...lanes.keys()].sort()) {
    const lane = lanes.get(platform);
    if (lane === undefined) continue;
    if (lane.state === "leased" && lane.host !== null) {
      out.push({ state: "leased", platform, host: lane.host });
      continue;
    }
    out.push({ state: "claiming", platform, pool: [...lane.pool] });
  }
  return out;
}

const NO_EXCERPTS = (): null => null;

function project(
  handle: RunHandle,
  manifest: RunManifest,
  now: number,
  stamp: string,
): Entry {
  const journal = readJournal(handle);
  const owner = currentOwner(handle.dir);
  const alive = ownerAlive(owner, now);
  const verdict = readVerdict(handle);
  const attention = attentionFor(
    {
      runId: handle.runId,
      manifest,
      journal: journal.entries,
      unreadableEvents: journal.unreadable,
      verdict,
      expiry: readExpiry(handle),
      ownerAlive: alive,
      endpoint: owner?.endpoint ?? null,
      readExcerpt: NO_EXCERPTS,
    },
    { limit: 1, excerptBytes: 0 },
  );
  const fold = foldJournal(journal.entries);
  const state = boardState(attention.state, fold.latest);
  const row: RunRow = {
    runId: handle.runId,
    repo: manifest.repo,
    repoRoot: manifest.repoRoot,
    branch: manifest.branch ?? null,
    sha: manifest.sha,
    dirty: manifest.snapshot.dirty,
    ...(manifest.snapshot.contentSha === undefined ? {} : { contentSha: manifest.snapshot.contentSha }),
    seq: manifest.seq,
    pipeline: manifest.pipeline,
    createdAt: manifest.createdAt,
    finishedAt: verdict?.finishedAt ?? null,
    state,
    settled: attention.settled,
    passed: attention.passed,
    outcome: attention.outcome,
    actionable: attention.actionable,
    unresolvedFailures: attention.unresolved_failures_total,
    scope: manifest.scope,
    reportingDebt: fold.debt.size,
    endpoint: attention.endpoint,
    parentRunId: manifest.parentRunId,
    ...(manifest.actor === undefined ? {} : { actor: manifest.actor }),
    cursor: formatCursor(journal.cursor),
    ...(attention.push === undefined
      ? {}
      : {
          push: {
            target: attention.push.target,
            skipped: attention.push.skipped,
            keyWarning: attention.push.keyWarning,
          },
        }),
  };
  return {
    fingerprint: stamp,
    owner,
    alive,
    row,
    nodes: nodesOf(handle.runId, fold.roster, fold.latest, fold.push),
    env: envOf(fold, row, now),
    pushTokenId: manifest.push?.target?.tokenId ?? null,
  };
}

function terminal(row: RunRow): boolean {
  return row.state === "settled" || row.state === "expired";
}

function immuneToClock(row: RunRow): boolean {
  return terminal(row) && row.endpoint === null;
}

export interface RegistryDelta {
  upserted: RunRow[];
  removed: string[];
}

export interface RunRegistry {
  rows: () => RunRow[];
  row: (runId: string) => RunRow | undefined;
  nodes: (runId: string) => RunNode[] | undefined;
  pushTokenOf: (runId: string) => string | null;
  ownerAliveOf: (runId: string) => boolean;
  env: (runId: string, now?: number) => RunEnv | undefined;
  select: (query: RunQuery) => { rows: RunRow[]; total: number };
  refresh: (now?: number) => RegistryDelta;
  size: () => number;
  catalog: string;
}

export interface RunQuery {
  checkout?: string;
  sha?: string;
  seq?: number;
  limit?: number;
}

export interface RegistryOptions extends CatalogOptions {
  limit?: number;
}

type Slot = { kind: "run"; entry: Entry } | { kind: "torn"; stamp: string };

export function createRegistry(opts: RegistryOptions = {}): RunRegistry {
  const slots = new Map<string, Slot>();
  let order: string[] = [];

  const entryOf = (runId: string): Entry | undefined => {
    const slot = slots.get(runId);
    return slot?.kind === "run" ? slot.entry : undefined;
  };

  const refresh = (now: number = Date.now()): RegistryDelta => {
    const upserted: RunRow[] = [];
    const removed: string[] = [];
    const seen = new Set<string>();
    const catalog = catalogPath(opts);
    const nextOrder: string[] = [];

    for (const runId of listRunIds(opts)) {
      nextOrder.push(runId);
      seen.add(runId);
      const handle: RunHandle = { runId, dir: runDir(catalog, runId) };
      const stamp = fingerprint(handle.dir);
      const held = slots.get(runId);
      if (held?.kind === "torn" && held.stamp === stamp) continue;
      if (
        held?.kind === "run" &&
        held.entry.fingerprint === stamp &&
        (immuneToClock(held.entry.row) ||
          ownerAlive(held.entry.owner, now) === held.entry.alive)
      ) {
        continue;
      }
      const manifest = readManifest(handle);
      if (manifest === null) {
        if (held?.kind === "run") removed.push(runId);
        slots.set(runId, { kind: "torn", stamp });
        continue;
      }
      const entry = project(handle, manifest, now, stamp);
      slots.set(runId, { kind: "run", entry });
      upserted.push(entry.row);
    }

    for (const [runId, slot] of slots) {
      if (seen.has(runId)) continue;
      if (slot.kind === "run") removed.push(runId);
      slots.delete(runId);
    }
    order = newestFirst(
      nextOrder
        .map((id) => entryOf(id)?.row)
        .filter((row): row is RunRow => row !== undefined),
    ).map((row) => row.runId);
    return { upserted, removed };
  };

  const select = (query: RunQuery): { rows: RunRow[]; total: number } => {
    const sha = query.sha?.toLowerCase();
    const rows: RunRow[] = [];
    let total = 0;
    for (const id of order) {
      const row = entryOf(id)?.row;
      if (row === undefined) continue;
      if (query.checkout !== undefined && row.repoRoot !== query.checkout) continue;
      if (sha !== undefined && !row.sha.toLowerCase().startsWith(sha)) continue;
      if (query.seq !== undefined && row.seq !== query.seq) continue;
      total += 1;
      if (query.limit === undefined || rows.length < query.limit) rows.push(row);
    }
    return { rows, total };
  };

  return {
    rows: () =>
      order
        .map((id) => entryOf(id)?.row)
        .filter((row): row is RunRow => row !== undefined),
    row: (runId) => entryOf(runId)?.row,
    nodes: (runId) => entryOf(runId)?.nodes,
    pushTokenOf: (runId) => entryOf(runId)?.pushTokenId ?? null,
    ownerAliveOf: (runId) => entryOf(runId)?.alive ?? false,
    env: (runId, now = Date.now()) => {
      const held = entryOf(runId);
      if (held === undefined) return undefined;
      return {
        ...held.env,
        elapsedMs: runElapsedMs(held.row, now),
      };
    },
    select,
    refresh,
    size: () => order.length,
    catalog: catalogPath(opts),
  };
}

export function projectRun(
  runId: string,
  opts: CatalogOptions = {},
  now: number = Date.now(),
): { row: RunRow; nodes: RunNode[]; env: RunEnv } | null {
  const handle = handleFor(runId, opts);
  const manifest = readManifest(handle);
  if (manifest === null) return null;
  const { row, nodes, env } = project(handle, manifest, now, fingerprint(handle.dir));
  return { row, nodes, env };
}
