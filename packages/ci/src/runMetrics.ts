/**
 * WHAT THE RUNS CONTRIBUTE TO `/metrics` — read from the CATALOG ON DISK.
 *
 * The host serves one `/metrics` and reads no row's storage; a row registers a
 * contributor and answers a reading when it is scraped (`@odu/cordis/metrics`).
 * This is the `ci` row's answer.
 *
 * ## The catalog is the source, not the coordinator
 *
 * Every number here is derived from the run records a coordinator WROTE —
 * manifests, verdicts and journals — never from a live coordinator's memory. A
 * run is counted because its verdict is on disk, so a scrape says the same
 * thing whether the coordinator that produced it is still alive, was replaced,
 * or died an hour ago. The opposite arrangement would make the counts a
 * property of this daemon's uptime rather than of the work that happened.
 *
 * A run with NO verdict yet is not counted at all: it has no outcome, and
 * inventing one (or folding it into `incomplete`, which is a real terminal
 * outcome) would make a run that is still going look like a run that failed to
 * finish.
 *
 * ## A scrape is BOUNDED WORK, not the whole catalog
 *
 * `listRuns` opens several files per run and `readJournal` opens one more. A
 * poller that walked the whole catalog four times a second burned an event loop
 * (juspay/odu#113), and a scrape is the same walk on somebody else's schedule —
 * so it reads at most {@link DEFAULT_SCRAPE_LIMIT} runs, newest first, and the
 * answer is reused for {@link DEFAULT_FRESH_MS}. Two Prometheus servers
 * scraping the same daemon therefore cost one walk, and a catalog with ten
 * thousand runs costs exactly what one with two hundred does. The price is
 * honest and stated here: these are the RECENT runs, not all of history.
 *
 * ## The lanes are the service's LAST PROBE, and nothing else
 *
 * `odu_lane_*` is folded from the venue reading the service already keeps (the
 * answer of the most recent `venue.probe` of its own fleet). A scrape NEVER
 * dials a machine: an ssh fan-out on a monitoring system's timer is a way to
 * take a fleet down with a dashboard. If nothing has probed since the daemon
 * started, the lane gauges are simply ABSENT from this scrape — absent, not
 * zero, because "no machine is reachable" and "nobody has looked" call for
 * opposite actions and a fabricated zero would page somebody for the wrong one.
 */

import type {
  HistogramFamily,
  HistogramPoint,
  MetricFamily,
  MetricLabels,
  MetricPoint,
  MetricsReading,
} from "@odu/cordis/metrics";
import { splitFanId } from "@odu/run-client/nodeId";
import { handleFor, listRuns, readJournal } from "@odu/run-history/store";
import type { VenueReading } from "@odu/service-client/surface";

/** The three terminal outcomes a verdict can carry (`RunVerdict.outcome`).
 *  Every one is emitted every scrape, including the zeroes: a counter that
 *  appears only once it is non-zero makes a dashboard's first failure look like
 *  a series starting rather than a run going red. */
const RUN_OUTCOMES = ["passed", "failed", "incomplete"] as const;

/**
 * The bucket bounds, in SECONDS, shared by both duration histograms.
 *
 * Ten seconds to two hours, because that is the range odu's work actually
 * occupies: a cheap lint recipe is seconds and a cold `nix build` on a remote
 * lane is tens of minutes. Shared by the run histogram and the node one so a
 * dashboard can put them side by side without re-bucketing either.
 */
export const DURATION_BOUNDS = [10, 30, 60, 120, 300, 600, 1800, 3600, 7200] as const;

/** How many runs one scrape reads, newest first. */
export const DEFAULT_SCRAPE_LIMIT = 200;

/** How long one catalog walk is reused. Shorter than a normal scrape interval,
 *  so a single scraper still sees fresh numbers; long enough that a second
 *  scraper, or a human reloading the page, costs nothing. */
export const DEFAULT_FRESH_MS = 10_000;

/** One histogram sample under construction. `counts` is PER-BOUND and not
 *  cumulative — the renderer accumulates, so this keeps what it counts. */
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

/** Record one duration, in seconds. The bound is the INCLUSIVE upper edge, so a
 *  45s observation lands in the 60s bucket and a 60s one lands there too; above
 *  the last bound it is an overflow, which `+Inf` will carry. */
function observe(tally: Tally, seconds: number): void {
  if (!Number.isFinite(seconds)) return;
  // A verdict whose `finishedAt` precedes its `startedAt` is a clock that moved,
  // not a negative duration: clamped rather than dropped, so the run is still
  // counted somewhere.
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

/** A labelled tally, keyed by its label set. The key is the label VALUES joined
 *  by a byte no label value can contain, so two different label sets can never
 *  collide into one sample — duplicate or merged label sets in one family are a
 *  scrape error, not a rounding. */
type TallyBook = Map<string, { labels: MetricLabels; tally: Tally }>;

function tallyFor(book: TallyBook, key: string, labels: MetricLabels): Tally {
  const found = book.get(key);
  if (found !== undefined) return found.tally;
  const made = { labels, tally: emptyTally() };
  book.set(key, made);
  return made.tally;
}

const pointsOf = (book: TallyBook): HistogramPoint[] =>
  [...book.values()].map(({ labels, tally }) => ({
    labels,
    counts: tally.counts,
    overflow: tally.overflow,
    sum: tally.sum,
  }));

/** What one catalog walk produced — everything a scrape can answer WITHOUT
 *  touching the venues, which is exactly the part worth caching. */
interface CatalogReading {
  runs: MetricPoint[];
  runDurations: HistogramPoint[];
  nodeDurations: HistogramPoint[];
}

/**
 * Walk the newest `limit` runs and fold them.
 *
 * One pass, three folds: how many runs reached each outcome, how long those
 * runs took, and how long each node attempt within them took. The journal is
 * read per run because node durations live nowhere else — that is the expensive
 * half of this function, and the reason `limit` exists.
 */
function walkCatalog(catalog: string, limit: number): CatalogReading {
  const counted = new Map<string, number>(RUN_OUTCOMES.map((o) => [o, 0]));
  const runDurations: TallyBook = new Map();
  const nodeDurations: TallyBook = new Map();

  for (const row of listRuns({ root: catalog, limit })) {
    const handle = handleFor(row.runId, { root: catalog });

    // The journal is read even for a run with no verdict: its nodes have
    // finished attempts with real durations long before the run itself is
    // finalized, and a histogram that waited for the verdict would go quiet for
    // exactly as long as a slow run is interesting.
    for (const entry of readJournal(handle).entries) {
      const event = entry.event;
      if (event.kind !== "node_status") continue;
      // `durationMs: null` is a transition that measured nothing — `pending`
      // and `running` carry no duration — so it is NOT an observation. Counting
      // it as zero would pile every start of every node into the first bucket.
      if (event.durationMs === null) continue;
      const recipe = splitFanId(event.node).namepath;
      const platform = event.placement.platform;
      const labels: MetricLabels = { recipe, platform, outcome: event.status };
      observe(
        tallyFor(nodeDurations, `${recipe}\u0000${platform}\u0000${event.status}`, labels),
        event.durationMs / 1000,
      );
    }

    const verdict = row.verdict;
    // No verdict, no outcome. A run that is still going is not an outcome this
    // row can report, and folding it into one would be a lie a dashboard draws.
    if (verdict === null) continue;
    counted.set(verdict.outcome, (counted.get(verdict.outcome) ?? 0) + 1);
    observe(
      tallyFor(runDurations, verdict.outcome, { outcome: verdict.outcome }),
      (verdict.finishedAt - verdict.startedAt) / 1000,
    );
  }

  return {
    runs: RUN_OUTCOMES.map((outcome) => ({
      labels: { outcome },
      value: counted.get(outcome) ?? 0,
    })),
    runDurations: pointsOf(runDurations),
    nodeDurations: pointsOf(nodeDurations),
  };
}

/**
 * The lane gauges, folded PER HOST from the last probe.
 *
 * A machine with four slots is four rows in a probe, and emitting one sample
 * per row would put four identical `{host,platform}` label sets in one family —
 * which a scrape rejects outright, taking every other metric with it. So the
 * slots are FOLDED, and the fold is a definition rather than an implementation
 * detail:
 *
 *   - `odu_lane_reachable{host,platform}` is 1 when ANY slot of that host on
 *     that platform is in a state other than `down`. A host is reachable if odu
 *     can reach it at all; `busy` is reachable, and so is `local`.
 *   - `odu_lane_held{host}` is 1 when ANY slot of that host has a holder. A
 *     hold is what blocks other work from landing, and one held slot is enough
 *     for an operator to want to know who has it.
 *
 * Reachability keeps `platform` because the same host can serve more than one;
 * a hold does not, because a hold is taken on the machine.
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
  /** The catalog directory to read — `OduService.registry.catalog`. */
  readonly catalog: string;
  /** The service's last venue probe, or `null` if nothing has probed. Read at
   *  every scrape, because it is already in memory and costs nothing. */
  readonly venues: () => VenueReading;
  /** How many runs one walk reads, newest first. */
  readonly limit?: number;
  /** How long one walk's answer stays fresh. `0` reads every time. */
  readonly freshMs?: number;
  /** The clock, so the reuse window is testable without sleeping. */
  readonly now?: () => number;
}

/**
 * The `ci` row's metrics reading, as a function the row registers.
 *
 * Returns a closure rather than a value: a contributor is asked at every
 * scrape, and the reuse window it carries is what keeps that affordable.
 */
export function runMetricsReader(opts: RunMetricsOptions): () => MetricsReading {
  const limit = opts.limit ?? DEFAULT_SCRAPE_LIMIT;
  const freshMs = opts.freshMs ?? DEFAULT_FRESH_MS;
  const now = opts.now ?? Date.now;

  let kept: CatalogReading | null = null;
  let keptAt = 0;

  return () => {
    const at = now();
    if (kept === null || at - keptAt >= freshMs) {
      kept = walkCatalog(opts.catalog, limit);
      keptAt = at;
    }
    const catalog = kept;

    const histograms: HistogramFamily[] = [
      {
        name: "odu_run_duration_seconds",
        help: "How long a finalized run took, from its verdict's startedAt to its finishedAt.",
        bounds: DURATION_BOUNDS,
        points: catalog.runDurations,
      },
      {
        name: "odu_node_duration_seconds",
        help: "How long one node attempt took, as its journal recorded it.",
        bounds: DURATION_BOUNDS,
        points: catalog.nodeDurations,
      },
    ];

    return {
      counters: [
        {
          name: "odu_runs_total",
          help: "Runs in the recent catalog that reached each outcome.",
          points: catalog.runs,
        },
      ],
      // Absent, not zero, when nothing has probed — see the module header.
      gauges: laneGauges(opts.venues()),
      histograms,
    };
  };
}
