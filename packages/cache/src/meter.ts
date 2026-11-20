import type { MetricFamily, MetricLabels, MetricsReading } from "@odu/cordis/metrics";
import type { BucketGauge } from "./db";
import { NARINFO_SUFFIX, PUSH_API } from "./paths";

export type { BucketGauge };

export interface CacheMeter {
  observe(event: string, fields: Record<string, unknown>): void;
  reading(gauges: readonly BucketGauge[]): MetricsReading;
}

const numberOf = (fields: Record<string, unknown>, key: string): number | null => {
  const value = fields[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const textOf = (fields: Record<string, unknown>, key: string): string | null => {
  const value = fields[key];
  return typeof value === "string" ? value : null;
};

const UNATTRIBUTED = "";

const bucketLabelOrUnattributed = (fields: Record<string, unknown>): string =>
  textOf(fields, "bucket") ?? UNATTRIBUTED;

const PATH_KINDS: ReadonlyArray<{ matches: (bare: string) => boolean; kind: string }> = [
  { matches: (bare) => bare.startsWith(`${PUSH_API}/`), kind: "other" },
  { matches: (bare) => bare.includes("/nar/"), kind: "nar" },
  { matches: (bare) => bare.endsWith(NARINFO_SUFFIX), kind: "narinfo" },
];

function kindOfPath(path: string | null): string {
  if (path === null) return "other";
  const bare = path.split("?")[0] ?? path;
  for (const entry of PATH_KINDS) {
    if (entry.matches(bare)) return entry.kind;
  }
  return "other";
}

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

export function cacheMeter(now: () => number = Date.now): CacheMeter {
  const requests = new Tally();
  const bytes = new Tally();
  const uploads = new Tally();
  const evicted = new Tally();
  let gcRuns = 0;
  let lastGc = 0;

  return {
    observe(event, fields) {
      switch (event) {
        case "cache.narinfo.served": {
          requests.add(
            { bucket: bucketLabelOrUnattributed(fields), kind: "narinfo", outcome: fields["hit"] === true ? "hit" : "miss" },
            1,
          );
          return;
        }
        case "cache.nar.served": {
          const bucket = bucketLabelOrUnattributed(fields);
          const source = textOf(fields, "source") ?? "object";
          requests.add(
            { bucket, kind: "nar", outcome: source === "redirect" ? "redirect" : "hit" },
            1,
          );
          bytes.add({ bucket, direction: "served", mode: source }, numberOf(fields, "bytes") ?? 0);
          return;
        }
        case "cache.request.refused": {
          requests.add(
            { bucket: bucketLabelOrUnattributed(fields), kind: kindOfPath(textOf(fields, "path")), outcome: "refused" },
            1,
          );
          return;
        }
        case "cache.nar.uploaded": {
          const bucket = bucketLabelOrUnattributed(fields);
          const mode = textOf(fields, "mode") ?? "unknown";
          uploads.add({ bucket, mode, outcome: "recorded" }, 1);
          bytes.add({ bucket, direction: "uploaded", mode }, numberOf(fields, "bytes") ?? 0);
          return;
        }
        case "cache.import.recorded": {
          const bucket = bucketLabelOrUnattributed(fields);
          uploads.add({ bucket, mode: "import", outcome: "recorded" }, 1);
          bytes.add(
            { bucket, direction: "uploaded", mode: "import" },
            numberOf(fields, "bytes") ?? 0,
          );
          return;
        }
        case "cache.nar.verify_failed":
        case "cache.object.put_failed": {
          uploads.add(
            { bucket: bucketLabelOrUnattributed(fields), mode: textOf(fields, "mode") ?? "unknown", outcome: "failed" },
            1,
          );
          return;
        }
        case "cache.gc": {
          gcRuns += 1;
          lastGc = now();
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
