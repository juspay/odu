/**
 * THE RUN'S OWN WRITE TOKEN (PLAN 4.1) — minted without a principal, bounded
 * in three ways, and given back.
 *
 * The administrative mint is root-token-only and day-granular, and neither
 * suits a run: there is no person here, and a run is minutes. So the cache
 * grows a function the `ci` row calls directly, and what has to be true of it
 * is exactly what the administrative check would otherwise have guaranteed —
 * it reaches ONE bucket, it may only WRITE, it EXPIRES at the millisecond
 * asked for, and revoking it closes it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Cache, createCache, RUN_TOKEN_LIFETIME_MS } from "./cache";
import type { BucketRow } from "./db";
import { asRoot, localStores } from "./testlib";

const ROOT = "root-token";
const NOW = 1_700_000_000_000;

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "odu-run-token-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function served(...names: readonly string[]): Promise<Cache> {
  const cache = createCache({
    publicOrigin: "http://cache.test",
    stateRoot: scratch,
    stores: localStores(scratch),
    rootToken: ROOT,
    now: () => NOW,
  });
  for (const name of names) {
    await cache.admin.create({
      ...asRoot(ROOT),
      name,
      public: true,
      upstreamKeys: [],
      retentionDays: 30,
    });
  }
  return cache;
}

/** The bucket row by name, for the authorisation face below. Throws rather
 *  than narrowing at three call sites: a test naming a bucket it just created
 *  and not finding it has already failed. */
function bucketOf(cache: Cache, name: string): BucketRow {
  const row = cache.bucket(name);
  if (row === null) throw new Error(`no bucket ${name}`);
  return row;
}

describe("a run's write token", () => {
  it("is write-scoped to exactly its bucket, labelled, and expires in MILLISECONDS", async () => {
    const cache = await served("main");
    const granted = cache.grantRunToken({
      bucket: "main",
      runId: "r-1",
    });
    expect(granted).not.toBeNull();
    if (granted === null) return;

    // READ BACK THROUGH THE ADMIN LIST, which is what an operator sees on the
    // bucket page — so the three bounds are asserted where they are shown.
    const listed = await cache.admin.tokenList({ ...asRoot(ROOT), bucket: "main" });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.find((facts) => facts.id === granted.id)).toMatchObject({
      scope: "write",
      // THE NARROWEST GLOB EXPRESSIBLE: a bare name matches that bucket and
      // nothing else, so a run that pushes to the bucket it reads from can
      // reach no other bucket on this daemon.
      bucketGlob: "main",
      // What the bucket page's Tokens list shows, so an operator meeting a
      // credential they did not issue can see whose it is.
      label: "run r-1",
      // A WALL-CLOCK INSTANT, which the administrative mint cannot express:
      // its input is a whole number of DAYS, so a run finishing at 23:59
      // would get a token good for a minute. The lifetime is this row's own
      // — the asker sends a run id and nothing else.
      expires: NOW + RUN_TOKEN_LIFETIME_MS,
    });
    await cache.close();
  });

  it("opens the bucket, and stops the moment it is revoked", async () => {
    const cache = await served("main");
    const granted = cache.grantRunToken({
      bucket: "main",
      runId: "r-1",
    });
    if (granted === null) throw new Error("no grant");
    expect(
      cache.authorize(`Bearer ${granted.token}`, bucketOf(cache, "main"), "write"),
    ).toEqual({ ok: true });

    // THE ORDINARY END of one of these — the service revokes at finalize
    // whatever the run's outcome — which is what makes the expiry a backstop
    // rather than the lifetime.
    cache.revokeToken(granted.id);
    expect(
      cache.authorize(`Bearer ${granted.token}`, bucketOf(cache, "main"), "write"),
    ).toMatchObject({ ok: false, status: 403 });
    await cache.close();
  });

  it("cannot touch a bucket it was not minted for", async () => {
    const cache = await served("main", "other");
    const granted = cache.grantRunToken({
      bucket: "main",
      runId: "r-1",
    });
    if (granted === null) throw new Error("no grant");
    expect(
      cache.authorize(`Bearer ${granted.token}`, bucketOf(cache, "other"), "write"),
    ).toMatchObject({ ok: false, status: 403 });
    await cache.close();
  });

  it("answers null for a bucket this daemon does not serve", async () => {
    const cache = await served("main");
    expect(
      cache.grantRunToken({ bucket: "nope", runId: "r-1" }),
    ).toBeNull();
    await cache.close();
  });

  it("lets an unknown id go without complaining", async () => {
    // A finalize cannot know whether a restart already revoked, so this is
    // idempotent by contract rather than by luck.
    const cache = await served("main");
    expect(() => cache.revokeToken("not-a-token")).not.toThrow();
    await cache.close();
  });
});
