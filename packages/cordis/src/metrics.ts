export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricPoint {
  readonly labels?: MetricLabels;
  readonly value: number;
}

export interface MetricFamily {
  readonly name: string;
  readonly help: string;
  readonly points: readonly MetricPoint[];
}

/** NOT cumulative — the renderer accumulates. */
export interface HistogramPoint {
  readonly labels?: MetricLabels;
  /** Same length and order as the family's `bounds`. */
  readonly counts: readonly number[];
  /** Observations greater than the last bound (`+Inf`'s own share). */
  readonly overflow: number;
  readonly sum: number;
}

export interface HistogramFamily {
  readonly name: string;
  readonly help: string;
  /** Inclusive upper bounds, ascending, in the family's own unit. */
  readonly bounds: readonly number[];
  readonly points: readonly HistogramPoint[];
}

export interface MetricsReading {
  readonly counters?: readonly MetricFamily[];
  readonly gauges?: readonly MetricFamily[];
  readonly histograms?: readonly HistogramFamily[];
}

export interface MetricsContributor {
  readonly name: string;
  read(): MetricsReading | Promise<MetricsReading>;
}

export interface MetricsSources {
  add(contributor: MetricsContributor): () => void;
  /** Every contributor registered so far, in registration order. Read once per
   *  scrape. */
  contributors(): readonly MetricsContributor[];
}

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

export const EXPOSITION_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** `\` and a newline, per the format. Help text may not carry a raw newline. */
const escapeHelp = (text: string): string => text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");

/** A label VALUE also escapes the quote that delimits it. */
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
function mergeFamilies<F extends { name: string; help: string; points: readonly unknown[] }>(
  families: readonly F[],
): Array<{ head: F; points: F["points"][number][] }> {
  const byName = new Map<string, { head: F; points: F["points"][number][] }>();
  for (const family of families) {
    const seen = byName.get(family.name);
    if (seen === undefined) byName.set(family.name, { head: family, points: [...family.points] });
    else seen.points.push(...family.points);
  }
  return [...byName.values()];
}

/** `null` reading means `read()` threw or rejected. */
export interface ContributorReading {
  readonly contributor: string;
  readonly reading: MetricsReading | null;
}

export function renderExposition(readings: readonly ContributorReading[]): string {
  const lines: string[] = [];
  const simple = (
    kind: "counter" | "gauge",
    families: readonly MetricFamily[],
  ): void => {
    for (const { head, points } of mergeFamilies(families)) {
      lines.push(`# HELP ${head.name} ${escapeHelp(head.help)}`);
      lines.push(`# TYPE ${head.name} ${kind}`);
      for (const point of points) {
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

  for (const { head, points } of mergeFamilies(ok.flatMap((one) => one.reading?.histograms ?? []))) {
    lines.push(`# HELP ${head.name} ${escapeHelp(head.help)}`);
    lines.push(`# TYPE ${head.name} histogram`);
    for (const point of points) {
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
