/**
 * THE SCRAPE CREDENTIAL — what the file keeps, and what it must never keep.
 *
 * The claim worth a test is not "mint then verify": it is that the plaintext
 * exists exactly once, that a revoked token stops working immediately, and that
 * a file somebody corrupted leaves the root token still able to open the route.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openMetricsTokens, rootTokenMatches, TOKEN_TOUCH_MS } from "./metricsTokens";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "odu-metrics-tokens-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("metrics tokens", () => {
  it("mints a token that opens a scrape and keeps only its hash", () => {
    const store = openMetricsTokens(scratch);
    const { token, facts } = store.mint("prometheus-pod");

    expect(store.verify(token)).toBe(true);
    expect(facts.label).toBe("prometheus-pod");
    expect(facts.revoked).toBe(false);

    const onDisk = readFileSync(store.path, "utf-8");
    expect(onDisk).not.toContain(token);
    expect(onDisk).toContain(facts.id);
  });

  it("refuses an unknown secret, an empty one, and a revoked one", () => {
    const store = openMetricsTokens(scratch);
    const { token, facts } = store.mint("pod");

    expect(store.verify("odum_nothing")).toBe(false);
    expect(store.verify("")).toBe(false);

    expect(store.revoke(facts.id)).toBe(true);
    expect(store.verify(token)).toBe(false);
    // Still listed, so a revoked id reads as revoked rather than as a typo.
    expect(store.list().map((one) => [one.id, one.revoked])).toEqual([[facts.id, true]]);
    expect(store.revoke("no-such-id")).toBe(false);
  });

  it("survives a restart: a second store over the same directory verifies it", () => {
    const { token } = openMetricsTokens(scratch).mint("pod");
    expect(openMetricsTokens(scratch).verify(token)).toBe(true);
  });

  it("records last use, and not on every scrape", () => {
    let clock = 1_700_000_000_000;
    const store = openMetricsTokens(scratch, () => clock);
    const { token, facts } = store.mint("pod");
    expect(facts.lastUsed).toBeNull();

    store.verify(token);
    const first = store.list()[0]?.lastUsed;
    expect(first).toBe(clock);

    clock += TOKEN_TOUCH_MS - 1;
    store.verify(token);
    expect(store.list()[0]?.lastUsed).toBe(first as number);

    clock += 2;
    store.verify(token);
    expect(store.list()[0]?.lastUsed).toBe(clock);
  });

  it("treats a corrupt file as no tokens rather than as a reason not to serve", () => {
    const store = openMetricsTokens(scratch);
    store.mint("pod");
    mkdirSync(join(scratch, "metrics"), { recursive: true });
    writeFileSync(store.path, "{ this is not json");

    expect(store.list()).toEqual([]);
    expect(store.verify("odum_anything")).toBe(false);
    // And minting again writes a fresh file rather than throwing.
    expect(store.verify(store.mint("pod").token)).toBe(true);
  });
});

describe("the root token", () => {
  it("matches only itself, and never when none is configured", () => {
    expect(rootTokenMatches("s3cret", "s3cret")).toBe(true);
    expect(rootTokenMatches("s3cret", "s3cre")).toBe(false);
    expect(rootTokenMatches(null, "s3cret")).toBe(false);
    // The empty presented token against an unconfigured root is the case a
    // naive equality check gets wrong, and it is the whole door.
    expect(rootTokenMatches(null, "")).toBe(false);
    expect(rootTokenMatches("", "")).toBe(false);
  });
});
