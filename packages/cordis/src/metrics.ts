/**
 * WHAT A ROW CONTRIBUTES TO `/metrics`, and how the host renders it.
 *
 * The host serves one `/metrics` route; the numbers in it belong to the rows.
 * A host that read them would have to open the cache's database and the
 * catalog, which is exactly the reach `@odu/cordis` exists to prevent. So a row
 * REGISTERS a contributor and keeps its own counters; the host collects, renders
 * and authorises, and names no row's internals.
 *
 * **A broker, not an offer.** Every service tag is single-provider, and metrics
 * have MANY contributors (the cache row's hit rates, the runs' durations) with
 * ONE consumer. That is the shape {@link HttpRoutes} already has: the host makes
 * the list, each row `add`s and holds the withdrawal, and the host reads the
 * list at each scrape. A row that fails to apply takes its numbers with it
 * rather than leaving a contributor pointing at a closed database.
 *
 * **Counters are process-local.** They start at zero when the daemon starts, and
 * Prometheus already understands that (`rate()` handles a reset). The durable
 * counts a restart must not lose — a bucket's lifetime reads — are GAUGES read
 * from SQL at scrape time, not counters kept in memory.
 *
 * The exposition is hand-written against the Prometheus text format
 * (`text/plain; version=0.0.4`): one `# HELP`/`# TYPE` per family, one line per
 * sample, label values escaped. It is forty lines and no dependency.
 */

/** A sample's labels. Values are escaped on the way out; names are odu's own. */
export type MetricLabels = Readonly<Record<string, string>>;

/** One sample of a counter or a gauge. */
export interface MetricPoint {
  readonly labels?: MetricLabels;
  readonly value: number;
}

/** One named counter or gauge, with every sample a contributor has for it. */
export interface MetricFamily {
  /** The exposition name, `odu_`-prefixed and already suffixed (`_total` for a
   *  counter, `_seconds` for a duration), because the name a dashboard query
   *  spells must exist in exactly one place. */
  readonly name: string;
  readonly help: string;
  readonly points: readonly MetricPoint[];
}

/** One sample of a histogram: the observations that fell in each bound, those
 *  above the last one, and their sum. NOT cumulative — the renderer accumulates,
 *  so a contributor keeps the simple array it actually counts into. */
export interface HistogramPoint {
  readonly labels?: MetricLabels;
  /** Same length and order as the family's `bounds`. */
  readonly counts: readonly number[];
  /** Observations greater than the last bound (`+Inf`'s own share). */
  readonly overflow: number;
  readonly sum: number;
}

/** One named histogram and the bounds every sample of it shares. */
export interface HistogramFamily {
  readonly name: string;
  readonly help: string;
  /** Inclusive upper bounds, ascending, in the family's own unit. */
  readonly bounds: readonly number[];
  readonly points: readonly HistogramPoint[];
}

/** WHAT ONE ROW ANSWERS AT A SCRAPE. Counters it has been keeping, gauges it
 *  reads now, and histograms of what it has finished. */
export interface MetricsReading {
  readonly counters?: readonly MetricFamily[];
  readonly gauges?: readonly MetricFamily[];
  readonly histograms?: readonly HistogramFamily[];
}

/** A row's registration. `name` labels the contributor's own health metric, so
 *  a scrape says WHICH row went quiet rather than failing whole. */
export interface MetricsContributor {
  readonly name: string;
  read(): MetricsReading | Promise<MetricsReading>;
}

/**
 * THE REGISTRY A ROW REGISTERS INTO — one per tenure, made by whoever owns the
 * tenure, exactly as the route mount is.
 *
 * `add` returns the WITHDRAWAL: a row whose apply fails after registering must
 * not leave a contributor that reads a database it has closed.
 */
export interface MetricsSources {
  add(contributor: MetricsContributor): () => void;
  /** Every contributor registered so far, in registration order. Read once per
   *  scrape. */
  contributors(): readonly MetricsContributor[];
}

/** A registry with nothing registered. With no rows mounted a scrape is a valid
 *  empty exposition, not a refusal. */
export function metricsBroker(): MetricsSources {
  const registered: MetricsContributor[] = [];
  return {
    add(contributor) {
      registered.push(contributor);
      return () => {
        const at = registered.indexOf(contributor);
        if (at !== -1) registered.splice(at, 1);
      };
    },
    contributors: () => registered,
  };
}

// ── the exposition ──────────────────────────────────────────────────────────

/** The content type a Prometheus scrape expects. */
export const EXPOSITION_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** `\` and a newline, per the format. Help text may not carry a raw newline. */
const escapeHelp = (text: string): string => text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");

/** A label VALUE also escapes the quote that delimits it. Bucket names are
 *  `^[a-z0-9-]+$` already; a recipe name or a host is not, so this is real. */
const escapeLabel = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** Prometheus' own spelling of the values JSON has no word for. */
function numberText(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

function labelsText(labels: MetricLabels | undefined, extra?: readonly [string, string]): string {
  const pairs = Object.entries(labels ?? {}).map(
    ([name, value]) => `${name}="${escapeLabel(value)}"`,
  );
  if (extra !== undefined) pairs.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  return pairs.length === 0 ? "" : `{${pairs.join(",")}}`;
}

/** Families of one kind, merged by NAME across contributors: two rows that both
 *  report `odu_build_info` would otherwise emit two `# HELP` lines for one name,
 *  which a scrape rejects. First help text wins; samples keep their order. */
function mergeFamilies<F extends { name: string; help: string }>(
  families: readonly F[],
  points: (family: F) => readonly unknown[],
): Array<{ head: F; points: unknown[] }> {
  const byName = new Map<string, { head: F; points: unknown[] }>();
  for (const family of families) {
    const seen = byName.get(family.name);
    if (seen === undefined) byName.set(family.name, { head: family, points: [...points(family)] });
    else seen.points.push(...points(family));
  }
  return [...byName.values()];
}

/** One contributor's answer, or its silence. `null` reading means `read()` threw
 *  or rejected — the scrape still renders, and says so. */
export interface ContributorReading {
  readonly contributor: string;
  readonly reading: MetricsReading | null;
}

/**
 * RENDER. Counters first, then gauges, then histograms, then the per-contributor
 * health gauge — so the one line that says a row went quiet is always present,
 * even when every reading failed.
 */
export function renderExposition(readings: readonly ContributorReading[]): string {
  const lines: string[] = [];
  const simple = (
    kind: "counter" | "gauge",
    families: readonly MetricFamily[],
  ): void => {
    for (const { head, points } of mergeFamilies(families, (family) => family.points)) {
      lines.push(`# HELP ${head.name} ${escapeHelp(head.help)}`);
      lines.push(`# TYPE ${head.name} ${kind}`);
      for (const point of points as MetricPoint[]) {
        lines.push(`${head.name}${labelsText(point.labels)} ${numberText(point.value)}`);
      }
    }
  };

  const ok = readings.filter((one) => one.reading !== null);
  simple(
    "counter",
    ok.flatMap((one) => one.reading?.counters ?? []),
  );
  simple(
    "gauge",
    ok.flatMap((one) => one.reading?.gauges ?? []),
  );

  for (const { head, points } of mergeFamilies(
    ok.flatMap((one) => one.reading?.histograms ?? []),
    (family) => family.points,
  )) {
    lines.push(`# HELP ${head.name} ${escapeHelp(head.help)}`);
    lines.push(`# TYPE ${head.name} histogram`);
    for (const point of points as HistogramPoint[]) {
      let running = 0;
      head.bounds.forEach((bound, at) => {
        running += point.counts[at] ?? 0;
        lines.push(
          `${head.name}_bucket${labelsText(point.labels, ["le", numberText(bound)])} ${running}`,
        );
      });
      running += point.overflow;
      lines.push(`${head.name}_bucket${labelsText(point.labels, ["le", "+Inf"])} ${running}`);
      lines.push(`${head.name}_sum${labelsText(point.labels)} ${numberText(point.sum)}`);
      lines.push(`${head.name}_count${labelsText(point.labels)} ${running}`);
    }
  }

  if (readings.length > 0) {
    lines.push(
      "# HELP odu_metrics_contributor_up Whether a row answered this scrape (1) or failed it (0).",
    );
    lines.push("# TYPE odu_metrics_contributor_up gauge");
    for (const one of readings) {
      lines.push(
        `odu_metrics_contributor_up${labelsText({ contributor: one.contributor })} ${
          one.reading === null ? 0 : 1
        }`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * COLLECT AND RENDER. One contributor's failure is ONE zero in the exposition,
 * never a 500: a scrape that goes away the moment a row is unhappy is a
 * monitoring surface that is absent when it is needed.
 */
export async function scrape(sources: MetricsSources): Promise<string> {
  const readings = await Promise.all(
    sources.contributors().map(async (contributor): Promise<ContributorReading> => {
      try {
        return { contributor: contributor.name, reading: await contributor.read() };
      } catch {
        return { contributor: contributor.name, reading: null };
      }
    }),
  );
  return renderExposition(readings);
}
