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
    broker.announce([]);
    expect(seen).toHaveLength(1);
  });

  it("refuses a second claimant and installs nothing", () => {
    const broker = purgeBroker();
    const first: string[][] = [];
    broker.register((urls) => first.push([...urls]));
    const second: string[][] = [];
    expect(() => broker.register((urls) => second.push([...urls]))).toThrow(PurgeClaimRefused);
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
    withdraw();
    expect(broker.listening()).toBe(true);
    broker.announce(GONE);
    expect(first).toEqual([]);
    expect(second).toEqual([GONE]);
  });
});
