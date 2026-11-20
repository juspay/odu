/**
 * The BOARD — every registered run, projected once and kept fresh.
 *
 * **Freshness is a fingerprint, not a clock.** A run's row changes when its
 * files change, so the refresh compares a cheap `stat` of what can move — the
 * journal, the verdict, the ownership record, and the run directory itself —
 * and re-folds only the runs whose fingerprint moved.
 *
 * **The fingerprint comes BEFORE any read, and it is only `stat`s.** It used to
 * be taken after `listRuns` had already opened every run's manifest, owner
 * record, verdict and whole journal — so the check that existed to skip an
 * unchanged run ran after the run had been fully parsed (juspay/odu#113).
 * Discovery is now `listRunIds` (a directory listing) and an unchanged run
 * costs four `stat`s.
 *
 * The directory's own stat is what lets the owner record be skipped too.
 * `currentOwner` is a function of `owner.json` AND the set of epoch claim files
 * (`owner.<epoch>.claim`, created exclusively and never rewritten). The first
 * has its own stat; the second can only change by an entry appearing in or
 * leaving the directory, which moves the directory's mtime. So a run whose four
 * stats are unchanged has the same `currentOwner` it had when it was projected,
 * and the decoded record is cached on the entry rather than re-read per tick.
 *
 * **And OWNER LIVENESS is re-asked every tick while it can matter, because it
 * is not a file.** So each tick recomputes the fence's answer from the CACHED
 * owner record — arithmetic on its heartbeat, plus one `kill(pid, 0)` once the
 * grace has passed — and a changed answer re-projects the run like a moved file
 * would.
 *
 * "While it can matter" is a row that is not `settled`/`expired`, PLUS a
 * settled row that still holds an endpoint. The attention fold decides
 * settlement and expiry BEFORE it consults the fence, so for a finished run
 * that has let its endpoint go the answer cannot change the row.
 *
 * A settled row that still NAMES an endpoint is the exception, and it is not
 * cosmetic: `--linger` leaves exactly that shape, the run's write token is
 * held for as long as something is serving the run (PLAN 4.1), and a
 * coordinator killed -9 after `finalized` never releases the endpoint. Skip
 * it on the strength of `settled` alone and the liveness is computed once,
 * while it is still true, and never asked again.
 *
 * A settled run that resumes appends to its journal, and an expiry writes a
 * file, so either moves the fingerprint and brings the run back into the
 * question regardless.
 */

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

/** The files whose mtime+size decide whether a row is still current. Nothing
 *  else in a run directory can change a row: attempt logs grow, but a row says
 *  nothing about log CONTENT, and the journal is what records that a log was
 *  finalized. The directory itself is stat'd beside them — see the module
 *  header on the claim files it stands in for. */
const FINGERPRINTED = [
  RUN_FILES.events,
  RUN_FILES.verdict,
  RUN_FILES.owner,
] as const;

/** A run directory's observable state, from `stat`s alone — no file is opened.
 *  Missing files contribute a fixed marker rather than being skipped, so a
 *  verdict APPEARING moves the fingerprint just as much as one changing. */
function fingerprint(dir: string): string {
  const parts: string[] = [statPart(dir)];
  for (const file of FINGERPRINTED) parts.push(statPart(join(dir, file)));
  return parts.join("|");
}

function statPart(path: string): string {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "-";
  }
}

interface Entry {
  /** The `stat`s taken BEFORE the files were read. Before, not after: a write
   *  landing between the two then leaves a stale stamp beside fresh content,
   *  which the next tick re-reads — rather than a fresh stamp beside stale
   *  content, which no tick ever would. */
  fingerprint: string;
  /** The ownership record the row was folded against, decoded once. Re-asked
   *  for liveness on every tick without re-reading it — see the module header
   *  on why an unchanged fingerprint means an unchanged owner. */
  owner: Owner | null;
  /** The fence's answer the row was projected with. A tick whose answer
   *  differs re-projects, which is how a dead coordinator's silence reaches
   *  the board. */
  alive: boolean | null;
  row: RunRow;
  /** The run's node list, folded from the same journal read that built the row.
   *  Held beside it because a detail view and a board row are two views of ONE
   *  fold — reading the journal twice would let them disagree about which
   *  attempt a node is on. */
  nodes: RunNode[];
  /** Where the run's work is placed, from that same fold. Held here for the
   *  same reason the nodes are: the environment and the node list are two
   *  readings of one journal, and a caller that got them from two reads could
   *  hold a lane that has landed beside a node that has not started. */
  env: RunEnv;
  /** THE RUN'S PUSH TOKEN ID (PLAN 4.1), off the manifest and deliberately
   *  NOT on the row: a revocation handle is this process's business, not every
   *  browser's. Read through {@link RunRegistry.pushTokenOf}. */
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
      return latest.size === 0 ? "provisioning" : "running";
  }
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
  /** The ROW this environment belongs to — the ONE source of the run's own
   *  facts here. Its clock pair is what `runElapsedMs` subtracts, so the
   *  elapsed time on a projected frame and the one `RunRegistry.env` recomputes
   *  per read come from one object; and its `repo`/`sha` are the same two the
   *  manifest carries, so reading them off the row rather than taking the
   *  manifest alongside leaves nothing here that could describe a different
   *  run than the row does. */
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

/** The phase of a run that never journalled one. One rule, spelled once, and
 *  the same one `boardState` uses to tell `provisioning` from `running`. */
function fallbackPhase(latest: ReadonlyMap<string, AttemptState>): RunPhase {
  return latest.size === 0 ? "provisioning" : "lanes";
}

/**
 * The lane map, on the wire's two-arm union.
 *
 * Sorted by platform so two reads of one journal paint the same matrix — the
 * fold's map is in first-seen order, which is the order lanes happened to be
 * claimed in and is not stable across a resumed run.
 *
 * **A `leased` lane with no host is a TORN record** — the state says the lane
 * landed and the field naming the machine is missing — and it is reported as
 * `claiming`. That is the weaker of the two claims and the only honest one: the
 * union's `leased` arm requires a host, and inventing one (or spelling it as
 * the empty string) would tell a reader the work is on a machine that nothing
 * in the journal names. Whatever pool the line carried is kept, because that is
 * still evidence about where the lane may be.
 */
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

/** Project one run. Reads the journal ONCE and folds it twice — for the row's
 *  counts and for the node list — which is what keeps the two views of one run
 *  from being two readings of it. */
function project(
  handle: RunHandle,
  manifest: RunManifest,
  now: number,
  stamp: string,
): Entry {
  const journal = readJournal(handle);
  const owner = currentOwner(handle.dir);
  // Computed ONCE from the record just read, and stored beside it: the row a
  // reader sees and the answer the next tick compares against are one answer
  // rather than two reads that can straddle the grace boundary.
  const alive = ownerAlive(owner, now);
  // Read ONCE and shared with the environment below: the row's settlement and
  // the moment the elapsed clock stops are the same fact, and two reads of the
  // verdict could straddle the instant it is written.
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
      readExcerpt: () => null,
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
    cursor: formatCursor({ runId: handle.runId, seq: journal.highestSeq }),
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
    // The ROW just built, so the elapsed time on this frame and the one every
    // later read recomputes come from one pair.
    env: envOf(fold, row, now),
    pushTokenId: manifest.push?.target?.tokenId ?? null,
  };
}

/** A row whose STATE the fence's answer can no longer change — see the module
 *  header, and note that the liveness behind a settled row's endpoint can
 *  still change even though its state cannot. */
function terminal(row: RunRow): boolean {
  return row.state === "settled" || row.state === "expired";
}

/** What a refresh changed, so a caller can publish deltas rather than a whole
 *  collection.
 *
 *  ROWS ONLY. A run whose NODES moved is not reported here, and the absence is
 *  deliberate: the nodes stream is per-run and already compares the list it
 *  last sent against the one it is about to (`./nodes`). A second comparison
 *  here would be a second answer to "did this run's work move", kept in step by
 *  nothing — and the subscription's own is the one that can be right, because
 *  it knows what that subscriber has actually seen. */
export interface RegistryDelta {
  upserted: RunRow[];
  removed: string[];
}

/** The board, kept fresh. */
export interface RunRegistry {
  /** Every row, newest run first. */
  rows: () => RunRow[];
  /** One row, or undefined. */
  row: (runId: string) => RunRow | undefined;
  /** One run's node list, or undefined for a run this registry has not seen. */
  nodes: (runId: string) => RunNode[] | undefined;
  /** THE RUN'S PUSH TOKEN ID, or `null` (PLAN 4.1). */
  pushTokenOf: (runId: string) => string | null;
  /** IS THE PROCESS THAT OWNS THIS RUN STILL THERE — the liveness this
   *  projection already computed for the row, published because `endpoint` on
   *  the wire is the RECORDED one and cannot tell a lingering coordinator
   *  from a killed one. A run this registry has not seen is not alive. */
  ownerAliveOf: (runId: string) => boolean;
  /**
   * Where one run's work is placed, or undefined for a run this registry has
   * not seen. `undefined` rather than `UNKNOWN_ENV`, so a caller can tell "no
   * such run here" from "a run whose environment is not established yet".
   */
  env: (runId: string, now?: number) => RunEnv | undefined;
  /**
   * The board, FILTERED — what `run.list` answers from.
   *
   * One pass over the projection in board order (newest first). Filters are
   * ANDed; `rows` is cut at `limit` and `total` counts every match.
   */
  select: (query: RunQuery) => { rows: RunRow[]; total: number };
  /** Re-read the catalog and report what moved. */
  refresh: (now?: number) => RegistryDelta;
  /** How many runs are on the board — without building the rows to count. */
  size: () => number;
  /** The catalog directory this registry is a face onto. */
  catalog: string;
}

/** What `select` filters by. Every field absent means every run. */
export interface RunQuery {
  /** Exact `repoRoot` — the absolute checkout a run was started in. */
  checkout?: string;
  /** A commit PREFIX, compared case-insensitively. */
  sha?: string;
  seq?: number;
  limit?: number;
}

export interface RegistryOptions extends CatalogOptions {
  /** Cap the board. Absent means every run in the catalog. */
  limit?: number;
}

/**
 * Where one run id stands on the board this tick — ONE value per id.
 *
 * One map rather than two keyed alike, so "never both" is a property of the
 * type instead of a pairing every mutation below would have to remember.
 */
type Slot = { kind: "run"; entry: Entry } | { kind: "torn"; stamp: string };

export function createRegistry(opts: RegistryOptions = {}): RunRegistry {
  const slots = new Map<string, Slot>();
  /**
   * Every projected run, NEWEST FIRST — the order every reader of this
   * registry sees, refreshed whole on every pass so a new run appears at the
   * top rather than at the end.
   *
   * Ordered by the ROWS and not by the catalog's directory listing. An id
   * encodes the instant its run started, but not at one width: a minted id
   * pads its base36 timestamp to nine digits and an IMPORTED one to eight
   * (`mintRunId` vs `importedRunId`), so a lexicographic listing sorts every
   * imported run above every minted one and "newest first" quietly becomes
   * "imported first". A board reading `rows[0]` as the run a checkout stands
   * for would then name an ancient import as what is happening now.
   */
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
      // THE SKIP: nothing on disk moved, AND nothing this projection computes
      // from the clock did either.
      //
      // A terminal row is normally immune to the fence's answer — its state
      // is already `settled`, and re-reading a journal to learn that again
      // would be the whole catalog's work on every tick. But a settled row
      // STILL SERVING carries a live endpoint, and whether a process is
      // behind that endpoint is exactly what the clock changes: a `--linger`
      // coordinator projected alive and then killed -9 would never be asked
      // again, and its run's write token would live to its 24 h expiry on a
      // daemon one `kill(0)` away from knowing. So a terminal row is only
      // immune once it has RELEASED its endpoint; while it holds one,
      // liveness is re-asked like any other row's.
      if (
        held?.kind === "run" &&
        held.entry.fingerprint === stamp &&
        ((terminal(held.entry.row) && held.entry.row.endpoint === null) ||
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
    // `newestFirst` and not a local sort: a board's rows and the catalog they
    // came from must agree on which run is the newest, down to the tiebreak.
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

/** Read one run's shape on demand, for a run the registry has not projected. */
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
