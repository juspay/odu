/**
 * The BOARD — every registered run, projected once and kept fresh.
 *
 * The catalog is the truth. This is a projection of it, and the distinction is
 * load-bearing: nothing here is written, nothing here is authoritative, and a
 * row that disagrees with the run's own files is a bug in this file rather than
 * a second opinion a reader has to reconcile. The projection exists for one
 * reason — a surface `collection` is READ on every subscribe and every publish,
 * and re-folding forty runs' journals on each of those is a cost the browser
 * would pay in latency and the disk would pay in reads.
 *
 * **Freshness is a fingerprint, not a clock.** A run's row changes when its
 * files change, so the refresh compares a cheap `stat` of what can move — the
 * journal, the verdict, the ownership record, and the run directory itself —
 * and re-folds only the runs whose fingerprint moved. A settled run from last
 * week is stat'd and skipped; a run that is executing is re-folded every tick.
 * That is what keeps a large catalog affordable without a cache that can go
 * stale, because there is nothing to invalidate: the fingerprint IS the
 * invalidation.
 *
 * **The fingerprint comes BEFORE any read, and it is only `stat`s.** It used to
 * be taken after `listRuns` had already opened every run's manifest, owner
 * record, verdict and whole journal — so the check that existed to skip an
 * unchanged run ran after the run had been fully parsed. At seven hundred runs
 * that was a second of synchronous work per 250 ms tick, a daemon loop busy
 * full-time, and every RPC queued behind it (juspay/odu#113). Discovery is now
 * `listRunIds` (a directory listing) and an unchanged run costs four `stat`s.
 *
 * The directory's own stat is what lets the owner record be skipped too.
 * `currentOwner` is a function of `owner.json` AND the set of epoch claim files
 * (`owner.<epoch>.claim`, created exclusively and never rewritten). The first
 * has its own stat; the second can only change by an entry appearing in or
 * leaving the directory, which moves the directory's mtime. So a run whose four
 * stats are unchanged has the same `currentOwner` it had when it was projected,
 * and the decoded record is cached on the entry rather than re-read per tick.
 *
 * **And OWNER LIVENESS is re-asked every tick, because it is not a file.**
 * A coordinator that crashes stops writing — which means it stops moving the
 * very files a "did anything change?" check reads. Its heartbeat then ages past
 * the ownership grace and the run becomes `owner_lost`, and nothing on disk
 * moved to say so. Fingerprinting the files alone left such a row reading
 * `running` forever. So each tick recomputes the fence's answer from the CACHED
 * owner record — arithmetic on its heartbeat, plus one `kill(pid, 0)` once the
 * grace has passed — and a changed answer re-projects the run like a moved file
 * would.
 *
 * **No partial or time-budgeted refresh, on purpose.** A warm tick over ten
 * thousand runs is forty thousand `stat`s — tens of milliseconds. Chunking the
 * walk would buy nothing measurable and cost a board that is sometimes half
 * fresh; measure before adding it. The poller (`./poller`) guarantees an idle
 * gap between ticks regardless, so a slow disk degrades freshness, never RPCs.
 *
 * **Discovery is the catalog and only the catalog.** `listRunIds` walks the
 * per-user run directory, so a run started by `odu run` in a terminal before
 * this service existed appears on the board the moment the service starts —
 * without scanning arbitrary filesystem paths for `.ci` directories, which is
 * the thing a per-user catalog was introduced to stop anyone having to do.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { attentionFor, type AttemptState, foldJournal } from "@odu/run-history/attention";
import { formatCursor } from "@odu/run-history/ids";
import { currentOwner, ownerAlive } from "@odu/run-history/owner";
import { RUN_FILES, runDir } from "@odu/run-history/paths";
import type { Owner, RunManifest } from "@odu/run-history/schema";
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
import { formatLogKey } from "@odu/service-client/logKey";
import type {
  RunBoardState,
  RunEnv,
  RunLane,
  RunNode,
  RunPhase,
  RunRow,
} from "@odu/service-client/surface";

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

/** One run's projection, plus what it was projected from. */
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
  /** When the run stopped, or null while it has not. The ANCHOR the elapsed
   *  clock is re-read against — see `RunRegistry.env`. */
  finishedAt: number | null;
}

/**
 * Where a run stands, as a board says it.
 *
 * `provisioning` is the one state the attention fold does not name, and it is
 * not a new fact: a run is provisioning when it is still_running and no node
 * has started yet, which is precisely the window where a lane is claiming a
 * machine. Told apart HERE rather than stored, because it is derived from the
 * fold and a stored copy would be a second thing that could disagree with it.
 *
 * On a cold host that window is a multi-minute `nix copy` with nothing
 * executing behind it, and reporting "running" about a run with nothing running
 * is how a slow provision reads as a hang.
 */
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

/** The node list, from the fold the row was built from. */
function nodesOf(
  runId: string,
  roster: readonly string[],
  latest: ReadonlyMap<string, AttemptState>,
): RunNode[] {
  // The ROSTER's order, because that is the schedule a dashboard paints. A node
  // the fold saw but the roster does not list is appended: a run whose roster
  // event is missing (a torn journal, or a build older than the roster event)
  // still has its work shown rather than an empty detail view.
  const ordered = [...roster];
  const seen = new Set(ordered);
  for (const node of latest.keys()) if (!seen.has(node)) ordered.push(node);
  const out: RunNode[] = [];
  for (const id of ordered) {
    const attempt = latest.get(id);
    if (attempt === undefined) {
      // On the roster, never started. A `pending` row with attempt 0 — not a
      // fabricated attempt 1, which would name evidence that does not exist.
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
    out.push({
      id,
      // A started attempt with no status line yet IS running: the journal's
      // `attempt_started` is what "it began" means, and calling it pending
      // until the first status would show a node as not-yet-started while its
      // process is producing output.
      status: attempt.status ?? "running",
      attempt: attempt.attempt,
      exitCode: attempt.exitCode,
      startedAt: attempt.startedAt,
      durationMs: attempt.durationMs,
      host: attempt.placement.host,
      logKey: formatLogKey({ runId, node: id, attempt: attempt.attempt }),
    });
  }
  return out;
}

/**
 * The run's ENVIRONMENT, folded out of the same journal the row came from.
 *
 * Every field here used to be answerable only by dialling the checkout's
 * `.ci/odu.sock`: the coordinator journalled `lane` and `phase` lines all along
 * and `foldJournal` hit `default: break` on both arms, so the live process was
 * the only thing that could say which lane was on which box. Read from the
 * catalog instead, the same answer survives the coordinator — a run that
 * finished last week, or whose owner was killed, still says where it ran.
 */
function envOf(
  manifest: RunManifest,
  fold: ReturnType<typeof foldJournal>,
  /** When the run stopped, from its verdict — or null while it is still going,
   *  which is what makes `elapsedMs` a live clock rather than a fixed one. */
  finishedAt: number | null,
  now: number,
): RunEnv {
  return {
    // A record written before odu journalled phases says nothing about its own
    // lifecycle, and the fallback is the SAME reading `boardState` makes:
    // nothing started yet is a provision, anything else means work was placed.
    // Never `no_lanes` — that is the coordinator's own word for "the selection
    // matched nothing", and inferring it from silence would invent a reason the
    // journal never gave.
    phase: fold.phase ?? fallbackPhase(fold.latest),
    elapsedMs: elapsedOf(manifest.createdAt, finishedAt, now),
    lanes: lanesOf(fold.lanes),
    hostsSource: fold.hostsSource,
    // `owner/repo` or null — the manifest records the slug the coordinator
    // parsed from the origin, so a checkout with no GitHub remote has no forge
    // page and says so rather than assembling a URL that 404s.
    commitUrl:
      manifest.repo === null
        ? null
        : `https://github.com/${manifest.repo}/commit/${manifest.sha}`,
    // In the journal's own order — the order the posts were attempted — which
    // is the order an operator reads them in. The same debt `reportingDebt`
    // counts: a count says something is wrong, this says which context and why.
    owed: [...fold.debt.values()].map((row) => ({
      context: row.context,
      lastError: row.lastError,
      attempts: row.attempts,
    })),
  };
}

/**
 * How long the run has been going, and when that stops.
 *
 * STOPS AT THE VERDICT. An elapsed time that kept counting after a run finished
 * would make every settled row's age a function of when somebody looked at it,
 * which is the one thing a durable record is supposed to be free of.
 *
 * `Math.max` guards the single way this can go backwards: a verdict stamped on
 * a lane host whose clock is behind the one that registered the run. A negative
 * duration is not a fact about anything, and zero is the honest floor.
 */
function elapsedOf(
  createdAt: number,
  finishedAt: number | null,
  now: number,
): number {
  return Math.max(0, (finishedAt ?? now) - createdAt);
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
      // A BOARD ROW carries no excerpts, so the log is never opened: a refresh
      // that read forty failing runs' tails to produce four counters would be
      // paying the whole diagnosis bill to draw a badge. The excerpt belongs to
      // `run.wait`, which is the call that was asked for one.
      readExcerpt: () => null,
    },
    // One event is the floor the fold enforces anyway; the row wants none of
    // them, only the counts and the state around them.
    { limit: 1, excerptBytes: 0 },
  );
  const fold = foldJournal(journal.entries);
  const state = boardState(attention.state, fold.latest);
  return {
    fingerprint: stamp,
    owner,
    alive,
    row: {
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
      // The cursor a caller resumes from if it starts watching HERE. The
      // journal's highest sequence rather than the attention payload's own
      // cursor: that one advances only through events actually delivered, and
      // this read delivered none.
      cursor: formatCursor({ runId: handle.runId, seq: journal.highestSeq }),
    },
    nodes: nodesOf(handle.runId, fold.roster, fold.latest),
    env: envOf(manifest, fold, verdict?.finishedAt ?? null, now),
    finishedAt: verdict?.finishedAt ?? null,
  };
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

/**
 * The board, kept fresh.
 *
 * Deliberately NOT an Effect service and NOT reactive: it is a plain object
 * whose `refresh` is called by whoever owns the clock (the service's poller in
 * production, a test's own loop in a suite). Time is the one thing a projection
 * must not own, because a projection that ticked on its own could not be
 * asked "what would you say about this catalog right now".
 */
export interface RunRegistry {
  /** Every row, newest run first. */
  rows: () => RunRow[];
  /** One row, or undefined. */
  row: (runId: string) => RunRow | undefined;
  /** One run's node list, or undefined for a run this registry has not seen. */
  nodes: (runId: string) => RunNode[] | undefined;
  /**
   * Where one run's work is placed, or undefined for a run this registry has
   * not seen. `undefined` rather than `UNKNOWN_ENV`, so a caller can tell "no
   * such run here" from "a run whose environment is not established yet" —
   * those call for opposite next moves.
   *
   * Takes the clock the way `refresh` does, and for one reason: `elapsedMs` is
   * the only field here that moves without any file moving. A run in a cold
   * host's multi-minute `nix copy` writes NOTHING, so its fingerprint does not
   * change and it is never re-folded — and an elapsed time captured at the last
   * fold would sit still for exactly the window a reader is watching it
   * hardest. So the fold is cached and the clock is not.
   */
  env: (runId: string, now?: number) => RunEnv | undefined;
  /**
   * The board, FILTERED — what `run.list` answers from.
   *
   * One pass over the projection in board order (newest first). Filters are
   * ANDed; `rows` is cut at `limit` and `total` counts every match, so a caller
   * asking for one row still learns how many there were. Validation of the
   * query is the procedure's job, not this one's: this matches what it is given.
   */
  select: (query: RunQuery) => { rows: RunRow[]; total: number };
  /** Re-read the catalog and report what moved. */
  refresh: (now?: number) => RegistryDelta;
  /** The catalog directory this registry is a face onto — what an identity
   *  cell reports, so a caller can see WHICH catalog it is looking at. */
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
  /** Cap the board. Absent means every run in the catalog; retention already
   *  bounds that, and a face that silently showed a prefix would report a
   *  missing run as a missing run rather than as a truncated list. */
  limit?: number;
}

export function createRegistry(opts: RegistryOptions = {}): RunRegistry {
  const entries = new Map<string, Entry>();
  /** Insertion order is the catalog's order (newest first), refreshed whole on
   *  every pass — so a new run appears at the top rather than at the end. */
  let order: string[] = [];

  /** Directories with no readable manifest, by the fingerprint they were
   *  skipped at — so a torn directory costs its `stat`s per tick like any other
   *  unchanged run, rather than a manifest read. A manifest appearing moves the
   *  directory's mtime, which is what brings it back. */
  const skipped = new Map<string, string>();

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
      const held = entries.get(runId);
      if (
        held !== undefined &&
        held.fingerprint === stamp &&
        ownerAlive(held.owner, now) === held.alive
      ) {
        continue;
      }
      if (held === undefined && skipped.get(runId) === stamp) continue;
      // A row without a manifest is barely a row: the run id exists, but
      // nothing can be said about which commit it is or where it ran. Skipped
      // rather than shown as a row of blanks — `odu history list` over the
      // catalog is the face that reports a torn record as one.
      const manifest = readManifest(handle);
      if (manifest === null) {
        skipped.set(runId, stamp);
        if (held !== undefined) {
          entries.delete(runId);
          removed.push(runId);
        }
        continue;
      }
      skipped.delete(runId);
      const entry = project(handle, manifest, now, stamp);
      entries.set(runId, entry);
      upserted.push(entry.row);
    }

    for (const runId of entries.keys()) {
      if (!seen.has(runId)) removed.push(runId);
    }
    for (const runId of removed) entries.delete(runId);
    for (const runId of skipped.keys()) {
      if (!seen.has(runId)) skipped.delete(runId);
    }
    order = nextOrder.filter((id) => entries.has(id));
    return { upserted, removed };
  };

  const select = (query: RunQuery): { rows: RunRow[]; total: number } => {
    const sha = query.sha?.toLowerCase();
    const rows: RunRow[] = [];
    let total = 0;
    for (const id of order) {
      const row = entries.get(id)?.row;
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
        .map((id) => entries.get(id)?.row)
        .filter((row): row is RunRow => row !== undefined),
    row: (runId) => entries.get(runId)?.row,
    nodes: (runId) => entries.get(runId)?.nodes,
    env: (runId, now = Date.now()) => {
      const held = entries.get(runId);
      if (held === undefined) return undefined;
      return {
        ...held.env,
        elapsedMs: elapsedOf(held.row.createdAt, held.finishedAt, now),
      };
    },
    select,
    refresh,
    catalog: catalogPath(opts),
  };
}

/** Read one run's shape on demand, for a run the registry has not projected
 *  (a detail view opened on a run that arrived between refreshes). Same fold,
 *  so a run read this way and one read off the board agree. */
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
