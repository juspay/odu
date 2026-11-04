/**
 * THE RUNS' SCRAPE, over a REAL catalog.
 *
 * Every run here is written by the catalog's own writers — `registerRun`, a
 * journal, a verdict — because the whole class of bug this module can have is a
 * disagreement between what a coordinator writes and what a scrape reads. A
 * fixture that assembled the numbers in memory would test a stand-in for the
 * records and would have agreed with any reading at all.
 *
 * The three things worth stating:
 *
 *   - WHAT IS COUNTED. A run with no verdict has no outcome, and a histogram
 *     bucket is an inclusive upper edge — a 45-second run is a minute's run,
 *     not half a minute's.
 *   - WHAT IS NOT OBSERVED. `durationMs: null` is a transition that measured
 *     nothing; counting it would pile every node's start into the first bucket.
 *   - WHAT IS ABSENT. With nothing probed there are no lane gauges at all,
 *     rather than lanes reported as unreachable.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { MetricFamily, MetricsReading } from "@odu/cordis/metrics";
import { openJournal, writeVerdict } from "@odu/run-history/store";
import {
  makeWorld,
  registerFixtureRun,
  type World,
} from "@odu/service/fixture.testlib";
import type { VenueRowFacts } from "@odu/service/ports";
import type { VenueReading } from "@odu/service-client/surface";
import { DURATION_BOUNDS, runMetricsReader } from "./runMetrics";

const worlds: World[] = [];

function world(): World {
  const made = makeWorld();
  worlds.push(made);
  return made;
}

afterEach(() => {
  for (const w of worlds.splice(0)) w.dispose();
});

const REPO = "/tmp/odu-metrics-fixture";
const T0 = 1_700_000_000_000;

/** A finalized run: a verdict with a known duration, and the node events of
 *  its journal. `durationMs: null` is spelled by a caller passing null. */
function finishedRun(
  w: World,
  opts: {
    outcome: "passed" | "failed" | "incomplete";
    tookMs: number;
    nodes?: readonly {
      id: string;
      status: "ok" | "failed" | "errored" | "cancelled" | "running";
      durationMs: number | null;
      platform: string;
    }[];
  },
): void {
  const { handle, token } = registerFixtureRun(w, { repoRoot: REPO, sha: "a".repeat(40) });
  const journal = openJournal(handle, token);
  for (const node of opts.nodes ?? []) {
    journal.append(
      {
        kind: "node_status",
        node: node.id,
        attempt: 1,
        status: node.status,
        exitCode: node.status === "ok" ? 0 : 1,
        durationMs: node.durationMs,
        placement: { platform: node.platform, host: "localhost" },
      },
      T0,
    );
  }
  journal.append({ kind: "finalized", outcome: opts.outcome }, T0 + opts.tookMs);
  writeVerdict(handle, token, {
    runId: handle.runId,
    outcome: opts.outcome,
    startedAt: T0,
    finishedAt: T0 + opts.tookMs,
    failed: [],
    errored: [],
    cancelled: [],
    unposted: [],
  });
}

const family = (
  families: readonly MetricFamily[] | undefined,
  name: string,
): MetricFamily | undefined => families?.find((f) => f.name === name);

const valueFor = (reading: MetricsReading, name: string, labels: Record<string, string>) =>
  [
    ...(family(reading.counters, name)?.points ?? []),
    ...(family(reading.gauges, name)?.points ?? []),
  ].find((p) => Object.entries(labels).every(([k, v]) => (p.labels ?? {})[k] === v))?.value;

/** The bound an observation of `seconds` belongs in — spelled here so a test
 *  asserts an INDEX it derived from the published bounds rather than a magic
 *  number that would keep passing if the bounds moved. */
const bucketOf = (seconds: number) => DURATION_BOUNDS.findIndex((b) => seconds <= b);

const venueRow = (row: Partial<VenueRowFacts> & { host: string }): VenueRowFacts => ({
  platform: "x86_64-linux",
  slot: 0,
  slots: 1,
  state: "free",
  heldBy: null,
  error: null,
  ...row,
});

const probed = (rows: readonly VenueRowFacts[]): VenueReading => ({
  at: T0,
  platforms: [],
  source: "/tmp/hosts",
  warnings: [],
  rows,
});

describe("the runs' metrics reading", () => {
  it("counts every outcome, and counts a run with no verdict as none of them", () => {
    const w = world();
    finishedRun(w, { outcome: "passed", tookMs: 45_000 });
    finishedRun(w, { outcome: "failed", tookMs: 5_000 });
    // Registered and still going: no verdict, so no outcome.
    registerFixtureRun(w, { repoRoot: REPO, sha: "b".repeat(40) });

    const reading = runMetricsReader({ catalog: w.catalogRoot, venues: () => null })();

    expect(valueFor(reading, "odu_runs_total", { outcome: "passed" })).toBe(1);
    expect(valueFor(reading, "odu_runs_total", { outcome: "failed" })).toBe(1);
    // Present at zero rather than absent: a series that appears the first time
    // it is non-zero reads as a series starting, not as a run going red.
    expect(valueFor(reading, "odu_runs_total", { outcome: "incomplete" })).toBe(0);
  });

  it("puts a 45 second run in the minute bucket, not the half-minute one", () => {
    const w = world();
    finishedRun(w, { outcome: "passed", tookMs: 45_000 });

    const reading = runMetricsReader({ catalog: w.catalogRoot, venues: () => null })();
    const histogram = reading.histograms?.find((h) => h.name === "odu_run_duration_seconds");
    expect(histogram?.bounds).toEqual(DURATION_BOUNDS);
    const point = histogram?.points.find((p) => p.labels?.outcome === "passed");

    expect(point?.sum).toBe(45);
    expect(point?.overflow).toBe(0);
    expect(point?.counts[bucketOf(45)]).toBe(1);
    expect(point?.counts[bucketOf(30)]).toBe(0);
    // Per-bound and not cumulative: exactly one bucket carries the one run.
    expect(point?.counts.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("buckets node attempts by recipe, platform and status, and never observes a null duration", () => {
    const w = world();
    finishedRun(w, {
      outcome: "failed",
      tookMs: 60_000,
      nodes: [
        { id: "ci::unit@x86_64-linux", status: "ok", durationMs: 20_000, platform: "x86_64-linux" },
        {
          id: "ci::e2e@aarch64-darwin",
          status: "failed",
          durationMs: 400_000,
          platform: "aarch64-darwin",
        },
        // A node that only announced it was running: nothing was measured.
        { id: "ci::unit@x86_64-linux", status: "running", durationMs: null, platform: "x86_64-linux" },
      ],
    });

    const reading = runMetricsReader({ catalog: w.catalogRoot, venues: () => null })();
    const histogram = reading.histograms?.find((h) => h.name === "odu_node_duration_seconds");
    const points = histogram?.points ?? [];

    expect(points.map((p) => p.labels).sort((a, b) => (a?.recipe ?? "").localeCompare(b?.recipe ?? ""))).toEqual([
      { recipe: "ci::e2e", platform: "aarch64-darwin", outcome: "failed" },
      { recipe: "ci::unit", platform: "x86_64-linux", outcome: "ok" },
    ]);
    // The null-duration event produced no sample AT ALL — not a label set, not
    // a zero-second observation.
    expect(points.some((p) => p.labels?.outcome === "running")).toBe(false);

    const unit = points.find((p) => p.labels?.recipe === "ci::unit");
    expect(unit?.sum).toBe(20);
    expect(unit?.counts[bucketOf(20)]).toBe(1);
    expect(unit?.counts.reduce((a, b) => a + b, 0)).toBe(1);

    const e2e = points.find((p) => p.labels?.recipe === "ci::e2e");
    expect(e2e?.sum).toBe(400);
    expect(e2e?.counts[bucketOf(400)]).toBe(1);
  });

  it("has no lane gauges at all until something has probed", () => {
    const w = world();
    const reading = runMetricsReader({ catalog: w.catalogRoot, venues: () => null })();

    expect(family(reading.gauges, "odu_lane_reachable")).toBeUndefined();
    expect(family(reading.gauges, "odu_lane_held")).toBeUndefined();
    // The rest of the scrape is unaffected: an unprobed fleet is not an error.
    expect(family(reading.counters, "odu_runs_total")).toBeDefined();
  });

  it("folds a host's slots into one sample each, and reads down as unreachable", () => {
    const w = world();
    const reading = runMetricsReader({
      catalog: w.catalogRoot,
      venues: () =>
        probed([
          venueRow({
            host: "mac",
            platform: "aarch64-darwin",
            slot: 0,
            slots: 2,
            state: "busy",
            heldBy: { holder: "srid", run: null, sinceMs: T0 },
          }),
          venueRow({ host: "mac", platform: "aarch64-darwin", slot: 1, slots: 2, state: "free" }),
          venueRow({ host: "box", state: "down", error: "ssh: connect timed out" }),
        ]),
    })();

    const reachable = family(reading.gauges, "odu_lane_reachable");
    const held = family(reading.gauges, "odu_lane_held");

    // One sample per label set. Two samples for `mac` would be a duplicate
    // label set, which fails the whole scrape rather than one metric.
    expect(reachable?.points.length).toBe(2);
    expect(held?.points.length).toBe(2);

    expect(valueFor(reading, "odu_lane_reachable", { host: "mac", platform: "aarch64-darwin" })).toBe(1);
    expect(valueFor(reading, "odu_lane_reachable", { host: "box", platform: "x86_64-linux" })).toBe(0);
    // Held by the fold's own rule: ONE held slot makes the host held.
    expect(valueFor(reading, "odu_lane_held", { host: "mac" })).toBe(1);
    expect(valueFor(reading, "odu_lane_held", { host: "box" })).toBe(0);
  });

  it("reads at most `limit` runs, newest first", () => {
    const w = world();
    finishedRun(w, { outcome: "passed", tookMs: 1_000 });
    finishedRun(w, { outcome: "failed", tookMs: 1_000 });

    const reading = runMetricsReader({
      catalog: w.catalogRoot,
      venues: () => null,
      limit: 1,
    })();

    const total = (family(reading.counters, "odu_runs_total")?.points ?? []).reduce(
      (sum, p) => sum + p.value,
      0,
    );
    // A scrape is bounded work: one run read, one run counted.
    expect(total).toBe(1);
  });

  it("reuses one catalog walk until its freshness window expires", () => {
    const w = world();
    finishedRun(w, { outcome: "passed", tookMs: 1_000 });

    let clock = T0;
    const read = runMetricsReader({
      catalog: w.catalogRoot,
      venues: () => null,
      freshMs: 10_000,
      now: () => clock,
    });

    expect(valueFor(read(), "odu_runs_total", { outcome: "passed" })).toBe(1);

    finishedRun(w, { outcome: "passed", tookMs: 1_000 });
    // Inside the window: the second scrape costs no files, and says what the
    // first one did.
    clock = T0 + 9_999;
    expect(valueFor(read(), "odu_runs_total", { outcome: "passed" })).toBe(1);

    clock = T0 + 10_000;
    expect(valueFor(read(), "odu_runs_total", { outcome: "passed" })).toBe(2);
  });

  it("still reports the lanes from the current probe while the walk is reused", () => {
    const w = world();
    let clock = T0;
    let rows: readonly VenueRowFacts[] = [venueRow({ host: "box", state: "down" })];
    const read = runMetricsReader({
      catalog: w.catalogRoot,
      venues: () => probed(rows),
      freshMs: 10_000,
      now: () => clock,
    });

    expect(valueFor(read(), "odu_lane_reachable", { host: "box" })).toBe(0);

    rows = [venueRow({ host: "box", state: "free" })];
    clock = T0 + 1;
    // The venue reading is already in memory, so it is never the thing being
    // reused: a machine that came back is visible on the very next scrape.
    expect(valueFor(read(), "odu_lane_reachable", { host: "box" })).toBe(1);
  });
});
