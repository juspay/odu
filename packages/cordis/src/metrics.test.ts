/**
 * THE EXPOSITION, held to the format a scraper actually parses.
 *
 * Prometheus is unforgiving in two places and silent about both: a label value
 * that carries an unescaped quote or backslash makes the line unparseable, and
 * two `# HELP` lines for one metric name make the whole scrape an error. Neither
 * shows up in a unit that renders one tidy counter, so both are asserted here.
 */

import { describe, expect, it } from "bun:test";
import {
  metricsBroker,
  renderExposition,
  scrape,
  type MetricsReading,
} from "./metrics";

/** The lines of a rendered exposition, blank tail dropped. */
const linesOf = (text: string): string[] => text.split("\n").filter((line) => line !== "");

describe("the Prometheus text exposition", () => {
  it("renders a counter and a gauge with their help, type and labels", () => {
    const reading: MetricsReading = {
      counters: [
        {
          name: "odu_cache_requests_total",
          help: "Protocol requests served.",
          points: [
            { labels: { bucket: "main", kind: "narinfo", outcome: "hit" }, value: 3 },
            { labels: { bucket: "main", kind: "narinfo", outcome: "miss" }, value: 1 },
          ],
        },
      ],
      gauges: [
        { name: "odu_cache_paths", help: "Paths stored.", points: [{ labels: { bucket: "main" }, value: 7 }] },
      ],
    };

    expect(linesOf(renderExposition([{ contributor: "cache", reading }]))).toEqual([
      "# HELP odu_cache_requests_total Protocol requests served.",
      "# TYPE odu_cache_requests_total counter",
      'odu_cache_requests_total{bucket="main",kind="narinfo",outcome="hit"} 3',
      'odu_cache_requests_total{bucket="main",kind="narinfo",outcome="miss"} 1',
      "# HELP odu_cache_paths Paths stored.",
      "# TYPE odu_cache_paths gauge",
      'odu_cache_paths{bucket="main"} 7',
      "# HELP odu_metrics_contributor_up Whether a row answered this scrape (1) or failed it (0).",
      "# TYPE odu_metrics_contributor_up gauge",
      'odu_metrics_contributor_up{contributor="cache"} 1',
    ]);
  });

  it("escapes the three characters that would make a line unparseable", () => {
    const rendered = renderExposition([
      {
        contributor: "ci",
        reading: {
          gauges: [
            {
              name: "odu_lane_reachable",
              help: 'A lane\\host, and a\nsecond line.',
              points: [{ labels: { host: 'bu"ilder\\one', platform: "x86_64-linux" }, value: 1 }],
            },
          ],
        },
      },
    ]);
    expect(rendered).toContain("# HELP odu_lane_reachable A lane\\\\host, and a\\nsecond line.");
    expect(rendered).toContain('odu_lane_reachable{host="bu\\"ilder\\\\one",platform="x86_64-linux"} 1');
    // The escaped forms, and no raw newline anywhere but at a line end.
    expect(rendered.split("\n").filter((line) => line.startsWith("second line"))).toEqual([]);
  });

  it("emits one HELP and TYPE per name when two contributors share one", () => {
    const family = (value: number) => ({
      name: "odu_shared_total",
      help: "Shared.",
      points: [{ labels: { row: String(value) }, value }],
    });
    const lines = linesOf(
      renderExposition([
        { contributor: "a", reading: { counters: [family(1)] } },
        { contributor: "b", reading: { counters: [family(2)] } },
      ]),
    );
    expect(lines.filter((line) => line === "# HELP odu_shared_total Shared.")).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("# TYPE odu_shared_total"))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("odu_shared_total{"))).toHaveLength(2);
  });

  it("accumulates a histogram's buckets and closes it with +Inf, sum and count", () => {
    const lines = linesOf(
      renderExposition([
        {
          contributor: "ci",
          reading: {
            histograms: [
              {
                name: "odu_run_duration_seconds",
                help: "How long a run took.",
                bounds: [10, 60, 600],
                points: [
                  { labels: { outcome: "passed" }, counts: [1, 2, 0], overflow: 1, sum: 900.5 },
                ],
              },
            ],
          },
        },
      ]),
    );
    expect(lines).toEqual([
      "# HELP odu_run_duration_seconds How long a run took.",
      "# TYPE odu_run_duration_seconds histogram",
      'odu_run_duration_seconds_bucket{outcome="passed",le="10"} 1',
      'odu_run_duration_seconds_bucket{outcome="passed",le="60"} 3',
      'odu_run_duration_seconds_bucket{outcome="passed",le="600"} 3',
      'odu_run_duration_seconds_bucket{outcome="passed",le="+Inf"} 4',
      'odu_run_duration_seconds_sum{outcome="passed"} 900.5',
      'odu_run_duration_seconds_count{outcome="passed"} 4',
      "# HELP odu_metrics_contributor_up Whether a row answered this scrape (1) or failed it (0).",
      "# TYPE odu_metrics_contributor_up gauge",
      'odu_metrics_contributor_up{contributor="ci"} 1',
    ]);
  });

  it("is a valid empty exposition when no row has registered", async () => {
    expect(await scrape(metricsBroker())).toBe("\n");
  });
});

describe("a contributor that fails", () => {
  it("costs its own numbers and nothing else", async () => {
    const sources = metricsBroker();
    sources.add({
      name: "cache",
      read: () => {
        throw new Error("the database is closed");
      },
    });
    sources.add({
      name: "ci",
      read: () => ({ gauges: [{ name: "odu_runs", help: "Runs.", points: [{ value: 2 }] }] }),
    });

    const rendered = await scrape(sources);
    expect(rendered).toContain("odu_runs 2");
    expect(rendered).toContain('odu_metrics_contributor_up{contributor="cache"} 0');
    expect(rendered).toContain('odu_metrics_contributor_up{contributor="ci"} 1');
  });

  it("is awaited, so a rejected promise is the same zero", async () => {
    const sources = metricsBroker();
    sources.add({ name: "cache", read: () => Promise.reject(new Error("gone")) });
    expect(await scrape(sources)).toContain('odu_metrics_contributor_up{contributor="cache"} 0');
  });
});

describe("the registry", () => {
  it("withdraws only the contributor that registered", () => {
    const sources = metricsBroker();
    const first = sources.add({ name: "cache", read: () => ({}) });
    sources.add({ name: "ci", read: () => ({}) });
    first();
    expect(sources.contributors().map((one) => one.name)).toEqual(["ci"]);
  });
});
