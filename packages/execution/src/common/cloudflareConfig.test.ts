import { describe, expect, it } from "bun:test";
import { cloudflareInstance, isCloudflareHost, laneAuthHeaders, laneEndpoint, parseWorkerUrl } from "./cloudflareConfig";
import { laneCacheWriteUrl } from "../coordinator/cloudflare/laneCache";

describe("cloudflare host spelling", () => {
  it("recognises `cloudflare` and `cloudflare:<instance>` only", () => {
    expect(isCloudflareHost("cloudflare")).toBe(true);
    expect(isCloudflareHost("cloudflare:ci-2")).toBe(true);
    expect(isCloudflareHost("cloudflare.example.com")).toBe(false);
    expect(isCloudflareHost("nix@cloudflare-box")).toBe(false);
    expect(isCloudflareHost("localhost")).toBe(false);
  });

  it("maps a host to its Durable Object instance", () => {
    expect(cloudflareInstance("cloudflare")).toBe("default");
    expect(cloudflareInstance("cloudflare:ci-2")).toBe("ci-2");
  });

  it("refuses an instance the Worker's route would not accept", () => {
    expect(() => cloudflareInstance("cloudflare:")).toThrow(/instance/);
    expect(() => cloudflareInstance("cloudflare:a/b")).toThrow(/instance/);
  });
});

describe("lane cache write URL", () => {
  const cache = {
    secretKeyFile: "/home/u/.config/odu/cloudflare-lane-cache.sec",
    publicKey: "odu-lane-x-1:abc",
    netrcFile: null,
    awsCredentialsFile: null,
  };

  it("adds signing and zstd to a bare URL", () => {
    expect(laneCacheWriteUrl({ ...cache, url: "https://w.example/nix-cache" })).toBe(
      "https://w.example/nix-cache?secret-key=/home/u/.config/odu/cloudflare-lane-cache.sec&compression=zstd",
    );
  });

  it("appends to an s3 URL that already has parameters", () => {
    expect(
      laneCacheWriteUrl({ ...cache, url: "s3://odu-lane-cache?endpoint=acct.r2.cloudflarestorage.com&region=auto" }),
    ).toBe(
      "s3://odu-lane-cache?endpoint=acct.r2.cloudflarestorage.com&region=auto&secret-key=/home/u/.config/odu/cloudflare-lane-cache.sec&compression=zstd",
    );
  });
});

describe("worker URL and lane endpoints", () => {
  it("accepts only a bare https origin", () => {
    expect(parseWorkerUrl("https://odu-lane.example.workers.dev/", "t")).toBe("https://odu-lane.example.workers.dev");
    expect(() => parseWorkerUrl("http://odu-lane.example.workers.dev", "t")).toThrow(/https/);
    expect(() => parseWorkerUrl("https://u:p@w.example", "t")).toThrow(/bare/);
    expect(() => parseWorkerUrl("https://w.example/x", "t")).toThrow(/bare/);
    expect(() => parseWorkerUrl("not a url", "t")).toThrow(/not a URL/);
  });

  it("spells every lane route from the validated origin", () => {
    const config = { workerUrl: "https://w.example", secret: "s".repeat(32) };
    expect(laneEndpoint(config, "a-1", "start").href).toBe("https://w.example/lane/a-1/start");
    expect(laneEndpoint(config, "a-1", "agent", "wss").href).toBe("wss://w.example/lane/a-1/agent");
    expect(() => laneEndpoint(config, "../x", "start")).toThrow(/instance/);
    expect(laneAuthHeaders(config)).toEqual({ authorization: `Bearer ${"s".repeat(32)}` });
  });
});
