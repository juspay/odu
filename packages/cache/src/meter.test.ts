/**
 * THE ROW'S `/metrics` CONTRIBUTION, graded from both sides it is fed from.
 *
 * The counters are driven by calling `observe` with the event names and field
 * shapes the serving path really logs — that is the whole interface between
 * the cache and its meter, so a test that drives it directly is testing the
 * contract rather than a harness. (That those events are EMITTED is graded
 * where they are emitted: `routes.test.ts`.)
 *
 * The gauges are read from a REAL cache on a real temporary SQLite database,
 * because they are SQL: a fake repository would prove the shape of a query
 * nobody runs.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { asRoot, localStores } from "./testlib";
import { base32 } from "./narinfo";
import { hashOf } from "../test/fakeStore";
import { type Cache, createCache } from "./cache";
import { cacheMeter } from "./meter";
import type { MetricsReading } from "@odu/cordis/metrics";

const ROOT = "root-token";
const NOW = 1_700_000_000_000;

/** One sample's value, by family name and the labels it must carry — `null`
 *  when no such sample is in the reading. The families are searched in both
 *  halves, because which half a name lives in is itself part of the contract,
 *  and the test above asserts that split by itself. */
function sample(
  reading: MetricsReading,
  name: string,
  labels: Record<string, string> = {},
): number | null {
  const families = [...(reading.counters ?? []), ...(reading.gauges ?? [])];
  for (const family of families) {
    if (family.name !== name) continue;
    for (const point of family.points) {
      const carried = point.labels ?? {};
      const entries = Object.entries(labels);
      if (entries.length !== Object.keys(carried).length) continue;
      if (entries.every(([key, value]) => carried[key] === value)) return point.value;
    }
  }
  return null;
}

/** Which half of the reading a family is in. */
const familyNames = (reading: MetricsReading, half: "counters" | "gauges"): string[] =>
  (reading[half] ?? []).map((family) => family.name);

describe("the counters, from the events the cache logs", () => {
  it("counts a narinfo hit and a narinfo miss apart", () => {
    const meter = cacheMeter();
    const kept = hashOf("/nix/store/11111111111111111111111111111111-kept");
    const gone = hashOf("/nix/store/22222222222222222222222222222222-gone");
    meter.observe("cache.narinfo.served", { bucket: "main", hash: kept, hit: true });
    meter.observe("cache.narinfo.served", { bucket: "main", hash: kept, hit: true });
    meter.observe("cache.narinfo.served", { bucket: "main", hash: gone, hit: false });
    const reading = meter.reading([]);
    expect(sample(reading, "odu_cache_requests_total", { bucket: "main", kind: "narinfo", outcome: "hit" })).toBe(2);
    expect(sample(reading, "odu_cache_requests_total", { bucket: "main", kind: "narinfo", outcome: "miss" })).toBe(1);
  });

  it("counts a served NAR's bytes, and a redirect as a redirect with none", () => {
    const meter = cacheMeter();
    meter.observe("cache.nar.served", { bucket: "main", bytes: 4096, source: "object", cancelled: false });
    meter.observe("cache.nar.served", { bucket: "main", bytes: 0, source: "redirect", cancelled: false });
    const reading = meter.reading([]);
    expect(sample(reading, "odu_cache_requests_total", { bucket: "main", kind: "nar", outcome: "hit" })).toBe(1);
    expect(sample(reading, "odu_cache_requests_total", { bucket: "main", kind: "nar", outcome: "redirect" })).toBe(1);
    expect(sample(reading, "odu_cache_bytes_total", { bucket: "main", direction: "served", mode: "object" })).toBe(4096);
    expect(sample(reading, "odu_cache_bytes_total", { bucket: "main", direction: "served", mode: "redirect" })).toBe(0);
  });

  it("counts a refusal that names a bucket and one that cannot", () => {
    const meter = cacheMeter();
    // The refusal a reader meets: authorised against a known bucket, denied.
    meter.observe("cache.request.refused", {
      method: "GET",
      path: "/cache/main/nar/abc.nar.zst",
      bucket: "main",
      status: 403,
      reason: "this token may not read",
    });
    // And the one that is about the name itself, logged before any bucket is
    // known — the `bucket=""` sample.
    meter.observe("cache.request.refused", {
      method: "GET",
      path: "/cache/nope/qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq.narinfo",
      status: 404,
      reason: 'no bucket "nope"',
    });
    const reading = meter.reading([]);
    expect(sample(reading, "odu_cache_requests_total", { bucket: "main", kind: "nar", outcome: "refused" })).toBe(1);
    expect(sample(reading, "odu_cache_requests_total", { bucket: "", kind: "narinfo", outcome: "refused" })).toBe(1);
  });

  it("does not file a refused PUSH as a refused NAR read", () => {
    // The push API's routes carry `/nar/` in the path
    // (`/_odu/v1/buckets/<b>/nar/<file>/upload`), so a substring match put a
    // pusher with a stale token into the same series as a client refused a NAR
    // — and a panel watching reads paged for a credential problem.
    const meter = cacheMeter();
    meter.observe("cache.request.refused", {
      bucket: "main",
      method: "PUT",
      path: "/_odu/v1/buckets/main/nar/abc.nar.zst/upload",
      status: 401,
      reason: "the token is revoked",
    });
    const reading = meter.reading([]);
    expect(sample(reading, "odu_cache_requests_total", { bucket: "main", kind: "nar", outcome: "refused" })).toBeNull();
    expect(sample(reading, "odu_cache_requests_total", { bucket: "main", kind: "other", outcome: "refused" })).toBe(1);
  });

  it("counts an upload of each mode, and a failure under the same bucket", () => {
    const meter = cacheMeter();
    meter.observe("cache.nar.uploaded", { bucket: "main", file: "a.nar.zst", mode: "staged", parts: 3, bytes: 300 });
    meter.observe("cache.nar.uploaded", { bucket: "main", file: "b.nar.zst", mode: "direct", parts: 1, bytes: 70 });
    meter.observe("cache.import.recorded", { bucket: "main", path: "/nix/store/z", bytes: 11, fileSize: 9 });
    meter.observe("cache.nar.verify_failed", { bucket: "main", file: "c.nar.zst", mode: "direct", reason: "source_changed" });
    meter.observe("cache.object.put_failed", { bucket: "main", path: "/nix/store/z", reason: "precondition" });
    const reading = meter.reading([]);
    expect(sample(reading, "odu_cache_uploads_total", { bucket: "main", mode: "staged", outcome: "recorded" })).toBe(1);
    expect(sample(reading, "odu_cache_uploads_total", { bucket: "main", mode: "direct", outcome: "recorded" })).toBe(1);
    expect(sample(reading, "odu_cache_uploads_total", { bucket: "main", mode: "import", outcome: "recorded" })).toBe(1);
    expect(sample(reading, "odu_cache_uploads_total", { bucket: "main", mode: "direct", outcome: "failed" })).toBe(1);
    // A put the store refused carries no mode; one spelling for all of them.
    expect(sample(reading, "odu_cache_uploads_total", { bucket: "main", mode: "unknown", outcome: "failed" })).toBe(1);
    expect(sample(reading, "odu_cache_bytes_total", { bucket: "main", direction: "uploaded", mode: "staged" })).toBe(300);
    expect(sample(reading, "odu_cache_bytes_total", { bucket: "main", direction: "uploaded", mode: "direct" })).toBe(70);
    expect(sample(reading, "odu_cache_bytes_total", { bucket: "main", direction: "uploaded", mode: "import" })).toBe(11);
    // NOTHING WAS KEPT, so nothing is added to the byte counter: there is no
    // `direction="uploaded"` sample for a failure's bucket beyond the three
    // recorded modes above.
    expect(sample(reading, "odu_cache_bytes_total", { bucket: "main", direction: "uploaded", mode: "unknown" })).toBeNull();
  });

  it("counts a collection, splits its evictions per bucket, and stamps the clock", () => {
    const meter = cacheMeter(() => NOW);
    expect(sample(meter.reading([]), "odu_cache_last_gc_timestamp_seconds")).toBe(0);
    meter.observe("cache.gc", {
      evicted: 7,
      kept: 2,
      orphans: 0,
      bytes: 900,
      buckets: [
        { bucket: "main", evicted: 5, bytes: 700 },
        { bucket: "other", evicted: 2, bytes: 200 },
      ],
    });
    const reading = meter.reading([]);
    expect(sample(reading, "odu_cache_gc_runs_total")).toBe(1);
    expect(sample(reading, "odu_cache_gc_evicted_total", { bucket: "main" })).toBe(5);
    expect(sample(reading, "odu_cache_gc_evicted_total", { bucket: "other" })).toBe(2);
    expect(sample(reading, "odu_cache_last_gc_timestamp_seconds")).toBe(Math.floor(NOW / 1000));
  });

  it("ignores an event it does not know, and a line whose fields are not numbers", () => {
    const meter = cacheMeter();
    meter.observe("cache.self_ca.start", { rows: 3, bytes: 10 });
    meter.observe("odu web: something else entirely", {});
    // The log is stringly typed: a field that is not what this meter expects
    // must cost a zero, never a throw on the serving path.
    meter.observe("cache.nar.served", { bucket: "main", bytes: "lots", source: 7 });
    const reading = meter.reading([]);
    expect(sample(reading, "odu_cache_requests_total", { bucket: "main", kind: "nar", outcome: "hit" })).toBe(1);
    expect(sample(reading, "odu_cache_bytes_total", { bucket: "main", direction: "served", mode: "object" })).toBe(0);
  });

  it("reports every SQL-read number as a gauge, the in-memory tallies as counters", () => {
    const reading = cacheMeter().reading([{ bucket: "main", objects: 1, bytes: 2, hits: 3, pins: 4 }]);
    // `odu_cache_hits` is a GAUGE: it sums `hits` over the rows a bucket holds
    // NOW, so a collection lowers it — which as a `_total` would read as a
    // counter reset.
    expect(familyNames(reading, "counters")).not.toContain("odu_cache_hits");
    expect(familyNames(reading, "gauges")).toEqual([
      "odu_cache_hits",
      "odu_cache_paths",
      "odu_cache_bytes",
      "odu_cache_pins",
      "odu_cache_last_gc_timestamp_seconds",
    ]);
    expect(familyNames(reading, "counters")).toEqual([
      "odu_cache_requests_total",
      "odu_cache_bytes_total",
      "odu_cache_uploads_total",
      "odu_cache_gc_evicted_total",
      "odu_cache_gc_runs_total",
    ]);
  });
});

describe("the gauges, from a real database", () => {
  let scratch: string;
  let cache: Cache;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "odu-cache-meter-"));
    cache = createCache({
      publicOrigin: "http://cache.test",
      stateRoot: scratch,
      stores: localStores(scratch),
      rootToken: ROOT,
      now: () => NOW,
    });
  });

  afterEach(async () => {
    await cache.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("counts a bucket's paths, bytes, pins and reads — and reports an empty bucket as zero", async () => {
    const create = { ...asRoot(ROOT), public: true, retentionDays: 30, upstreamKeys: [] };
    expect(await cache.admin.create({ ...create, name: "main" })).toMatchObject({ ok: true });
    expect(await cache.admin.create({ ...create, name: "empty" })).toMatchObject({ ok: true });

    const path = "/nix/store/11111111111111111111111111111111-thing";
    const bytes = new TextEncoder().encode("a NAR that is eighteen");
    const narHash = `sha256:${base32(createHash("sha256").update(bytes).digest())}`;
    const row = cache.bucket("main");
    if (row === null) throw new Error("the bucket the test just made is not there");
    const upload = await cache.beginUpload(row, `${narHash.slice("sha256:".length)}.nar.zst`);
    await upload.write(bytes);
    await upload.commit();
    const accepted = await cache.acceptNarinfo(
      row,
      hashOf(path),
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              [
                `StorePath: ${path}`,
                `URL: nar/${narHash.slice("sha256:".length)}.nar.zst`,
                "Compression: none",
                `NarHash: ${narHash}`,
                "NarSize: 1",
                "References: ",
                "",
              ].join("\n"),
            ),
          );
          controller.close();
        },
      }),
    );
    expect(accepted).toMatchObject({ ok: true });
    expect(await cache.admin.pin({ ...asRoot(ROOT), bucket: "main", name: "keep", paths: [path] })).toMatchObject({ ok: true });
    // TWO READS, counted on the object rows themselves.
    cache.touch(row, hashOf(path));
    cache.touch(row, hashOf(path));

    const reading = cacheMeter().reading(cache.meterGauges());
    expect(sample(reading, "odu_cache_paths", { bucket: "main" })).toBe(1);
    expect(sample(reading, "odu_cache_bytes", { bucket: "main" })).toBe(bytes.length);
    expect(sample(reading, "odu_cache_pins", { bucket: "main" })).toBe(1);
    expect(sample(reading, "odu_cache_hits", { bucket: "main" })).toBe(2);

    // A BUCKET WITH NOTHING IN IT IS STILL A BUCKET: it is in neither GROUP BY,
    // and a reading that omitted it would make "empty" and "forgotten" the
    // same picture.
    expect(sample(reading, "odu_cache_paths", { bucket: "empty" })).toBe(0);
    expect(sample(reading, "odu_cache_bytes", { bucket: "empty" })).toBe(0);
    expect(sample(reading, "odu_cache_pins", { bucket: "empty" })).toBe(0);
    expect(sample(reading, "odu_cache_hits", { bucket: "empty" })).toBe(0);

    // AND NOTHING HAS COLLECTED SINCE BOOT.
    expect(sample(reading, "odu_cache_last_gc_timestamp_seconds")).toBe(0);
  });
});
