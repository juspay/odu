/**
 * THE PURGE PORT, held to the two promises a collection leans on.
 *
 * One is the ABSENCE rule, and it is why this is a broker rather than a
 * service a collection must find: with nobody registered an announcement does
 * NOTHING, so a daemon with no CDN row mounted collects exactly as a daemon
 * with one does. The other is the single-owner claim — the principal broker's
 * shape asked of a different question: one row fronts these URLs, a second
 * claim installs nothing, and a withdrawal removes only its own.
 */

import { describe, expect, it } from "bun:test";
import { purgeBroker, PurgeClaimRefused } from "./services";

const GONE = [
  "https://cache.example.org/9rk8zz.narinfo",
  "https://cache.example.org/nar/9rk8zz.nar.zst",
];

describe("the broker with no purger", () => {
  it("announces into nothing, and says that nothing is listening", () => {
    const broker = purgeBroker();
    expect(broker.listening()).toBe(false);
    // A COLLECTION ON A BARE DAEMON: the announcement is made, nobody answers,
    // and the collection is none the wiser.
    expect(() => broker.announce(GONE)).not.toThrow();
  });
});

describe("the single-owner claim", () => {
  it("hands the purger what was announced, in one value", () => {
    const broker = purgeBroker();
    const seen: string[][] = [];
    broker.register((urls) => seen.push([...urls]));
    broker.announce(GONE);
    expect(broker.listening()).toBe(true);
    expect(seen).toEqual([GONE]);
    // DELETING NOTHING IS NOT AN ANNOUNCEMENT: a collection that evicted no
    // path does not wake the edge.
    broker.announce([]);
    expect(seen).toHaveLength(1);
  });

  it("refuses a second claimant and installs nothing", () => {
    const broker = purgeBroker();
    const first: string[][] = [];
    broker.register((urls) => first.push([...urls]));
    const second: string[][] = [];
    expect(() => broker.register((urls) => second.push([...urls]))).toThrow(PurgeClaimRefused);
    // The refusal left no half-registration behind: the first purger still has
    // the slot, and the second never hears a URL.
    broker.announce(GONE);
    expect(first).toEqual([GONE]);
    expect(second).toEqual([]);
  });

  it("a withdrawal removes only the claim that made it", () => {
    const broker = purgeBroker();
    const first: string[][] = [];
    const withdraw = broker.register((urls) => first.push([...urls]));
    withdraw();
    expect(broker.listening()).toBe(false);

    const second: string[][] = [];
    expect(() => broker.register((urls) => second.push([...urls]))).not.toThrow();
    // A SECOND withdrawal cannot clear the successor: the claim it held is not
    // the claim installed now.
    withdraw();
    expect(broker.listening()).toBe(true);
    broker.announce(GONE);
    expect(first).toEqual([]);
    expect(second).toEqual([GONE]);
  });
});
