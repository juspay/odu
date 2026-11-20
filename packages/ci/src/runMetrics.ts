import type {
  HistogramFamily,
  HistogramPoint,
  MetricFamily,
  MetricLabels,
  MetricsReading,
} from "@odu/cordis/metrics";
import { splitFanId } from "@odu/run-client/nodeId";
import { handleFor, listRuns, readJournal } from "@odu/run-history/store";
import type { VenueReading } from "@odu/service-client/surface";

const RUN_OUTCOMES = ["passed", "failed", "incomplete"] as const;

export const DURATION_BOUNDS = [10, 30, 60, 120, 300, 600, 1800, 3600, 7200] as const;

export const DEFAULT_SCRAPE_LIMIT = 200;

export const DEFAULT_FRESH_MS = 10_000;

interface Tally {
  counts: number[];
  overflow: number;
  sum: number;
}

const emptyTally = (): Tally => ({
  counts: DURATION_BOUNDS.map(() => 0),
  overflow: 0,
  sum: 0,
});

function observe(tally: Tally, seconds: number): void {
  if (!Number.isFinite(seconds)) return;
  const value = seconds < 0 ? 0 : seconds;
  tally.sum += value;
  for (let i = 0; i < DURATION_BOUNDS.length; i += 1) {
    if (value <= (DURATION_BOUNDS[i] as number)) {
      tally.counts[i] = (tally.counts[i] ?? 0) + 1;
      return;
    }
  }
  tally.overflow += 1;
}

/** A labelled tally, keyed by its own label set. A duplicate label set in a
 *  family is a scrape error that takes the whole exposition with it. */
type TallyBook = Map<string, { labels: MetricLabels; tally: Tally }>;

function tallyFor(book: TallyBook, labels: MetricLabels): Tally {
  const key = Object.values(labels).join("\u0000");
  const found = book.get(key);
  if (found !== undefined) return found.tally;
  const made = { labels, tally: emptyTally() };
  book.set(key, made);
  return made.tally;
}

const pointsOf = (book: TallyBook): HistogramPoint[] =>
  [...book.values()].map(({ labels, tally }) => ({
    labels,
    counts: [...tally.counts],
    overflow: tally.overflow,
    sum: tally.sum,
  }));

/**
 * `odu_runs_total` and both histograms are COUNTERS on the wire, and a counter
 * that goes down is read as a reset, so each run is folded ONCE and the totals
 * only ever grow.
 */
interface Accumulated {
  readonly runs: Map<string, number>;
  readonly runDurations: TallyBook;
  readonly nodeDurations: TallyBook;
  readonly cursor: TerminalCursor;
}

class TerminalCursor {
  private readonly folded = new Map<string, { seq: number; ends: number }>();

  /** Journal seq already folded into the node histogram; 0 for an unseen run. */
  since(runId: string): number {
    return this.folded.get(runId)?.seq ?? 0;
  }

  /** Record this pass's watermark and answer whether one run end is owed now. */
  track(runId: string, lastSeq: number, finalized: number | null): boolean {
    const prev = this.folded.get(runId);
    if (finalized === null) {
      this.folded.set(runId, { seq: lastSeq, ends: prev?.ends ?? 0 });
      return false;
    }
    const ends = Math.max(1, finalized);
    const counted = prev === undefined ? ends - 1 : prev.ends;
    const owed = ends > counted;
    this.folded.set(runId, { seq: lastSeq, ends: owed ? counted + 1 : counted });
    return owed;
  }

  /** Forget runs that rolled out of the catalog window. */
  retain(present: ReadonlySet<string>): void {
    for (const runId of this.folded.keys()) {
      if (!present.has(runId)) this.folded.delete(runId);
    }
  }
}

const emptyAccumulated = (): Accumulated => ({
  runs: new Map(RUN_OUTCOMES.map((outcome) => [outcome, 0])),
  runDurations: new Map(),
  nodeDurations: new Map(),
  cursor: new TerminalCursor(),
});

function foldCatalog(state: Accumulated, catalog: string, limit: number): void {
  const present = new Set<string>();
  const cursor = state.cursor;

  for (const row of listRuns({ root: catalog, limit })) {
    present.add(row.runId);
    const since = cursor.since(row.runId);
    const handle = handleFor(row.runId, { root: catalog });

    const entries = readJournal(handle).entries;
    for (const entry of entries.filter((one) => one.seq > since)) {
      const event = entry.event;
      if (event.kind !== "node_status") continue;
      if (event.durationMs === null) continue;
      const labels: MetricLabels = {
        recipe: splitFanId(event.node).namepath,
        platform: event.placement.platform,
        outcome: event.status,
      };
      observe(tallyFor(state.nodeDurations, labels), event.durationMs / 1000);
    }

    const verdict = row.verdict;
    const owed = cursor.track(
      row.runId,
      entries.at(-1)?.seq ?? since,
      verdict === null ? null : entries.filter((one) => one.event.kind === "finalized").length,
    );
    if (verdict === null || !owed) continue;
    state.runs.set(verdict.outcome, (state.runs.get(verdict.outcome) ?? 0) + 1);
    observe(
      tallyFor(state.runDurations, { outcome: verdict.outcome }),
      (verdict.finishedAt - verdict.startedAt) / 1000,
    );
  }

  cursor.retain(present);
}

/**
 * The lane gauges, folded PER HOST from the last probe.
 *
 * A machine with four slots is four rows in a probe, and emitting one sample
 * per row would put four identical `{host,platform}` label sets in one family —
 * which a scrape rejects outright, taking every other metric with it.
 */
function laneGauges(reading: VenueReading): MetricFamily[] {
  if (reading === null) return [];
  const reachable = new Map<string, { labels: MetricLabels; value: number }>();
  const held = new Map<string, { labels: MetricLabels; value: number }>();

  for (const row of reading.rows) {
    const key = `${row.host}\u0000${row.platform}`;
    const up = row.state === "down" ? 0 : 1;
    const seenUp = reachable.get(key);
    if (seenUp === undefined) {
      reachable.set(key, { labels: { host: row.host, platform: row.platform }, value: up });
    } else if (up === 1) {
      seenUp.value = 1;
    }

    const holding = row.heldBy === null ? 0 : 1;
    const seenHeld = held.get(row.host);
    if (seenHeld === undefined) {
      held.set(row.host, { labels: { host: row.host }, value: holding });
    } else if (holding === 1) {
      seenHeld.value = 1;
    }
  }

  return [
    {
      name: "odu_lane_reachable",
      help: "1 when odu's last probe found a lane on this host and platform in any state but down.",
      points: [...reachable.values()],
    },
    {
      name: "odu_lane_held",
      help: "1 when any slot on this host was held at odu's last probe.",
      points: [...held.values()],
    },
  ];
}

export interface RunMetricsOptions {
  readonly catalog: string;
  readonly venues: () => VenueReading;
  readonly limit?: number;
  readonly freshMs?: number;
  readonly now?: () => number;
}

export function runMetricsReader(opts: RunMetricsOptions): () => MetricsReading {
  const limit = opts.limit ?? DEFAULT_SCRAPE_LIMIT;
  const freshMs = opts.freshMs ?? DEFAULT_FRESH_MS;
  const now = opts.now ?? Date.now;

  const state = emptyAccumulated();
  let walkedAt = Number.NEGATIVE_INFINITY;

  return () => {
    const at = now();
    if (at - walkedAt >= freshMs) {
      foldCatalog(state, opts.catalog, limit);
      walkedAt = at;
    }

    const histograms: HistogramFamily[] = [
      {
        name: "odu_run_duration_seconds",
        help: "How long a finalized run took, from its verdict's startedAt to its finishedAt.",
        bounds: DURATION_BOUNDS,
        points: pointsOf(state.runDurations),
      },
      {
        name: "odu_node_duration_seconds",
        help: "How long one node attempt took, as its journal recorded it.",
        bounds: DURATION_BOUNDS,
        points: pointsOf(state.nodeDurations),
      },
    ];

    return {
      counters: [
        {
          name: "odu_runs_total",
          help:
            "Runs this daemon has seen reach each outcome, counted once each " +
            "since it started.",
          points: RUN_OUTCOMES.map((outcome) => ({
            labels: { outcome },
            value: state.runs.get(outcome) ?? 0,
          })),
        },
      ],
      gauges: laneGauges(opts.venues()),
      histograms,
    };
  };
}
