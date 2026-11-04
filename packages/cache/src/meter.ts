/**
 * WHAT THE CACHE ROW CONTRIBUTES TO `/metrics`.
 *
 * Two halves, and they are counted in two different places on purpose.
 *
 * THE COUNTERS ARE THE LOG, READ TWICE. The cache already writes one
 * structured line per operational fact — a NAR served, a request refused, an
 * upload recorded, a collection run — and that line is the single place where
 * every one of those facts is known. So the meter does not instrument the
 * serving path a second time: the row tees its logger through
 * {@link CacheMeter.observe} and the same `(event, fields)` that becomes a log
 * line becomes a counter. One choke point, one truth, and a test can drive the
 * meter by hand with the event names the code really emits.
 *
 * They are PROCESS-LOCAL and reset when the daemon restarts, which is what a
 * Prometheus counter is allowed to do (the scrape notices the reset). Nothing
 * here is persisted; a count that must survive a restart is a SQL gauge below.
 *
 * THE GAUGES ARE SQL, READ AT SCRAPE TIME. How many paths a bucket holds, how
 * many bytes, how many pins — those are rows, counted by the database when
 * somebody asks, never accumulated in memory where a restart or a second
 * writer would make them a lie.
 *
 * FIELD READS ARE DEFENSIVE. The log is stringly typed end to end: a field is
 * `unknown`, and a meter that threw on a line whose shape it did not expect
 * would take down the serving path it is only supposed to watch.
 */

import type { MetricFamily, MetricLabels, MetricsReading } from "@odu/cordis/metrics";
import type { BucketGauge } from "./db";
import { NARINFO_SUFFIX, PUSH_API } from "./paths";

export type { BucketGauge };

/** The row's half of `/metrics`: a sink for the logger's events, and the
 *  reading the contributor answers with. The gauges arrive as an ARGUMENT
 *  rather than through a held `Cache`, because the meter is built before the
 *  cache is (the logger it tees is passed into `createCache`). */
export interface CacheMeter {
  /** One operational event. Unknown events are ignored — the log carries many
   *  lines that are not metrics, and new ones arrive without this file. */
  observe(event: string, fields: Record<string, unknown>): void;
  /** Everything this row reports, given what SQL says now. */
  reading(gauges: readonly BucketGauge[]): MetricsReading;
}

/** A number field, or null when the line did not carry one. */
const numberOf = (fields: Record<string, unknown>, key: string): number | null => {
  const value = fields[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/** A string field, or null. */
const textOf = (fields: Record<string, unknown>, key: string): string | null => {
  const value = fields[key];
  return typeof value === "string" ? value : null;
};

/**
 * THE BUCKET A REFUSAL NAMES, OR THE EMPTY STRING. `cache.request.refused` is
 * logged BEFORE the bucket is known for the two refusals that are about the
 * name itself (an unknown bucket, a malformed hash), and those are exactly the
 * refusals an operator most wants to see. Dropping them would make the
 * counter silent about the failure mode it exists for, so they count under
 * `bucket=""` — one documented, greppable value rather than a hidden sample.
 */
const bucketOf = (fields: Record<string, unknown>): string => textOf(fields, "bucket") ?? "";

/**
 * WHICH PROTOCOL FILE A REFUSED REQUEST WAS AFTER, from its path — the event
 * carries no `kind`, and the path is what the client actually asked for.
 * `other` is the ONE spelling for everything else (an upload, an unknown route
 * under the mount, `nix-cache-info`): refusals that are neither a narinfo nor a
 * NAR read are still refusals and still belong in the total.
 *
 * THE PUSH API IS TESTED FIRST, and that is not a nicety: its routes are
 * `/_odu/v1/buckets/<b>/nar/<file>/{parts,complete,upload}`, so a refused push
 * — a stale write token, an unknown bucket — would otherwise land in
 * `{kind="nar", outcome="refused"}`, the same series as a refused NAR READ, and
 * page whoever watches reads for a pusher's expired credential. The prefixes
 * are the row's own constants rather than literals, so the grammar is spelled
 * once (`./paths`).
 */
function kindOfPath(path: string | null): string {
  if (path === null) return "other";
  const bare = path.split("?")[0] ?? path;
  if (bare.startsWith(`${PUSH_API}/`)) return "other";
  if (bare.includes("/nar/")) return "nar";
  if (bare.endsWith(NARINFO_SUFFIX)) return "narinfo";
  return "other";
}

/** One labelled counter, summed per distinct label set. The key is the label
 *  VALUES in the family's own fixed order, so it is built once per bump and
 *  never sorted. */
class Tally {
  private readonly points = new Map<string, { labels: MetricLabels; value: number }>();

  add(labels: MetricLabels, by: number): void {
    const key = JSON.stringify(Object.values(labels));
    const found = this.points.get(key);
    if (found === undefined) this.points.set(key, { labels, value: by });
    else found.value += by;
  }

  family(name: string, help: string): MetricFamily {
    return { name, help, points: [...this.points.values()] };
  }
}

/**
 * THE ROW'S METER. `now` is injectable because the last-collection gauge is a
 * wall-clock timestamp and a test must be able to say what it is.
 */
export function cacheMeter(now: () => number = Date.now): CacheMeter {
  const requests = new Tally();
  const bytes = new Tally();
  const uploads = new Tally();
  const evicted = new Tally();
  let gcRuns = 0;
  /** Epoch ms of the last collection THIS PROCESS ran, 0 when none since
   *  boot. Zero rather than absent: a missing sample makes an alert on "the
   *  cache has not collected in a day" unevaluable, and 0 makes it fire. */
  let lastGc = 0;

  return {
    observe(event, fields) {
      switch (event) {
        case "cache.narinfo.served": {
          // THE ONE EVENT THE METER ASKED FOR. A narinfo answered is the hit
          // rate of the whole cache, and before this there was no line for it
          // at all — the serving path logged only what went wrong.
          requests.add(
            { bucket: bucketOf(fields), kind: "narinfo", outcome: fields["hit"] === true ? "hit" : "miss" },
            1,
          );
          return;
        }
        case "cache.nar.served": {
          const bucket = bucketOf(fields);
          const source = textOf(fields, "source") ?? "object";
          // A REDIRECT IS NOT A HIT: odu answered 307 and the store will serve
          // the bytes, so counting it as a hit would claim bytes this daemon
          // never moved. The byte counter keeps them apart by `mode` for the
          // same reason — a redirect's `bytes` is 0 and says so.
          requests.add(
            { bucket, kind: "nar", outcome: source === "redirect" ? "redirect" : "hit" },
            1,
          );
          bytes.add({ bucket, direction: "served", mode: source }, numberOf(fields, "bytes") ?? 0);
          return;
        }
        case "cache.request.refused": {
          requests.add(
            { bucket: bucketOf(fields), kind: kindOfPath(textOf(fields, "path")), outcome: "refused" },
            1,
          );
          return;
        }
        case "cache.nar.uploaded": {
          const bucket = bucketOf(fields);
          const mode = textOf(fields, "mode") ?? "unknown";
          uploads.add({ bucket, mode, outcome: "recorded" }, 1);
          bytes.add({ bucket, direction: "uploaded", mode }, numberOf(fields, "bytes") ?? 0);
          return;
        }
        case "cache.import.recorded": {
          // THE THIRD MODE: bytes that arrived as a `nix copy` import rather
          // than through either upload negotiation.
          const bucket = bucketOf(fields);
          uploads.add({ bucket, mode: "import", outcome: "recorded" }, 1);
          bytes.add(
            { bucket, direction: "uploaded", mode: "import" },
            numberOf(fields, "bytes") ?? 0,
          );
          return;
        }
        case "cache.nar.verify_failed":
        case "cache.object.put_failed": {
          // A FAILED UPLOAD CARRIES NO BYTES — nothing was kept, so nothing is
          // added to the byte counter. `mode` is absent on a store's refusal
          // (the put failed before the negotiation mattered), and `unknown` is
          // the one spelling for that.
          uploads.add(
            { bucket: bucketOf(fields), mode: textOf(fields, "mode") ?? "unknown", outcome: "failed" },
            1,
          );
          return;
        }
        case "cache.gc": {
          gcRuns += 1;
          lastGc = now();
          // THE PER-BUCKET SPLIT, which `cache.gc` carries because this meter
          // needs it: a collection that evicted a thousand paths is only
          // actionable once you know WHICH bucket gave them up.
          const split = fields["buckets"];
          if (!Array.isArray(split)) return;
          for (const entry of split as readonly unknown[]) {
            const one = (entry ?? {}) as Record<string, unknown>;
            const bucket = textOf(one, "bucket");
            if (bucket === null) continue;
            evicted.add({ bucket }, numberOf(one, "evicted") ?? 0);
          }
          return;
        }
        default:
          return;
      }
    },

    reading(gauges) {
      const paths: MetricFamily["points"][number][] = [];
      const stored: MetricFamily["points"][number][] = [];
      const pinned: MetricFamily["points"][number][] = [];
      const hits: MetricFamily["points"][number][] = [];
      for (const gauge of gauges) {
        const labels = { bucket: gauge.bucket };
        paths.push({ labels, value: gauge.objects });
        stored.push({ labels, value: gauge.bytes });
        pinned.push({ labels, value: gauge.pins });
        hits.push({ labels, value: gauge.hits });
      }
      return {
        counters: [
          requests.family(
            "odu_cache_requests_total",
            "Protocol requests answered, by bucket, file kind and outcome.",
          ),
          bytes.family("odu_cache_bytes_total", "Bytes served and bytes taken in, by bucket and mode."),
          uploads.family("odu_cache_uploads_total", "Uploads recorded and uploads refused, by bucket and mode."),
          evicted.family("odu_cache_gc_evicted_total", "Paths evicted by collection, by bucket."),
          {
            name: "odu_cache_gc_runs_total",
            help: "Collections this daemon has run.",
            points: [{ value: gcRuns }],
          },
        ],
        gauges: [
          // A GAUGE, AND IT HAS TO BE: the number is `SUM(hits)` over the
          // object rows a bucket holds NOW, and a collection deletes rows. A
          // `_total` that fell every time a bucket was collected would read as
          // a counter reset, which is a worse lie than the one it was trying to
          // tell ("reads since forever"). What it honestly says is: reads
          // attributable to the paths this bucket currently holds.
          {
            name: "odu_cache_hits",
            help: "Reads counted against the paths a bucket currently holds.",
            points: hits,
          },
          { name: "odu_cache_paths", help: "Store paths a bucket holds.", points: paths },
          { name: "odu_cache_bytes", help: "Bytes a bucket's paths occupy.", points: stored },
          { name: "odu_cache_pins", help: "Pins holding closures on a bucket.", points: pinned },
          {
            name: "odu_cache_last_gc_timestamp_seconds",
            help: "When this daemon last collected, 0 if it has not since boot.",
            points: [{ value: lastGc === 0 ? 0 : Math.floor(lastGc / 1000) }],
          },
        ],
      };
    },
  };
}
