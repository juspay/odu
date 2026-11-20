import { describe, expect, it } from "bun:test";
import type { CacheGrantor, GrantedBucket } from "@odu/cordis/services";
import { grantsBroker } from "@odu/cordis/services";
import type { CacheGrants } from "@odu/cordis/services";
import { resolvePushWith } from "./webPorts";

const OURS = "https://odu.example.org";
const KEY = "main-1:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqs=";

function serving(at: Record<string, string> = { [`${OURS}/cache/main`]: "main" }): CacheGrants {
  const grants = grantsBroker();
  const grantor: CacheGrantor = {
    bucketAt: (substituter): GrantedBucket | null => {
      const name = at[substituter.replace(/\/+$/, "")];
      return name === undefined
        ? null
        : { name, publicKey: KEY, origin: OURS, substituter };
    },
    mint: () => ({ id: "tok-1", token: "odu_test" }),
    revoke: () => {},
  };
  grants.register(grantor);
  return grants;
}

const flakeSaying =
  (substituters: readonly string[], trustedPublicKeys: readonly string[] = []) =>
  async () => ({ ok: true as const, config: { substituters, trustedPublicKeys } });

describe("resolving where a checkout pushes", () => {
  it("skips a checkout with no flake, saying so", async () => {
    const resolved = await resolvePushWith("/checkouts/plain", serving(), async () => ({
      ok: false,
      reason: "no flake.nix",
    }));
    expect(resolved).toEqual({ kind: "skipped", reason: "no flake.nix" });
  });

  it("says it COULD NOT READ the config, rather than blaming the flake", async () => {
    const resolved = await resolvePushWith("/checkouts/broken", serving(), async () => ({
      ok: false,
      reason: "could not read nixConfig: error: undefined variable 'pkgs'",
    }));
    expect(resolved).toMatchObject({ kind: "skipped" });
    if (resolved.kind !== "skipped") return;
    expect(resolved.reason).toContain("could not read nixConfig");
    expect(resolved.reason).toContain("undefined variable 'pkgs'");
  });

  it("never reads the flake at all on a daemon with no cache", async () => {
    let read = 0;
    const resolved = await resolvePushWith("/checkouts/ours", grantsBroker(), async () => {
      read += 1;
      return { ok: true, json: "{}" } as never;
    });
    expect(resolved).toEqual({ kind: "skipped", reason: "this daemon serves no cache" });
    expect(read).toBe(0);
  });

  it("skips a nixConfig that names no substituters", async () => {
    const resolved = await resolvePushWith("/checkouts/bare", serving(), flakeSaying([]));
    expect(resolved).toEqual({
      kind: "skipped",
      reason: "flake.nix nixConfig names no substituters",
    });
  });

  it("skips a substituter this daemon does not serve, naming what it read", async () => {
    const resolved = await resolvePushWith(
      "/checkouts/nixpkgs-reader",
      serving(),
      flakeSaying(["https://cache.nixos.org"]),
    );
    expect(resolved).toMatchObject({ kind: "skipped" });
    if (resolved.kind !== "skipped") return;
    expect(resolved.reason).toContain("is a cache this odu serves");
    expect(resolved.reason).toContain("https://cache.nixos.org");
  });

  it("CANNOT be told a hostile URL is one of ours", async () => {
    const resolved = await resolvePushWith(
      "/checkouts/hostile",
      serving(),
      flakeSaying(["https://evil.example/c"]),
    );
    expect(resolved).toMatchObject({ kind: "skipped" });
  });

  it("resolves the one cache this daemon serves, with the origin IT holds", async () => {
    const resolved = await resolvePushWith(
      "/checkouts/ours",
      serving(),
      flakeSaying([`${OURS}/cache/main`], [KEY]),
    );
    expect(resolved).toEqual({
      kind: "target",
      target: {
        substituter: `${OURS}/cache/main`,
        origin: OURS,
        bucket: "main",
        keyWarning: null,
      },
    });
  });

  it("resolves a bucket at its own DOMAIN, which is a URL like any other", async () => {
    const resolved = await resolvePushWith(
      "/checkouts/domain",
      serving({ "https://cache.example.com": "main" }),
      flakeSaying(["https://cache.example.com"], [KEY]),
    );
    expect(resolved).toMatchObject({ kind: "target" });
    if (resolved.kind !== "target") return;
    expect(resolved.target.bucket).toBe("main");
  });

  it("warns, and still pushes, when trusted-public-keys is missing the key", async () => {
    const resolved = await resolvePushWith(
      "/checkouts/untrusting",
      serving(),
      flakeSaying([`${OURS}/cache/main`], []),
    );
    expect(resolved).toMatchObject({ kind: "target" });
    if (resolved.kind !== "target") return;
    expect(resolved.target.keyWarning).toContain(KEY);
    expect(resolved.target.keyWarning).toContain("trusted-public-keys");
  });

  it("REFUSES two caches it could write to, naming both", async () => {
    const resolved = await resolvePushWith(
      "/checkouts/two",
      serving({ [`${OURS}/cache/main`]: "main", [`${OURS}/cache/spare`]: "spare" }),
      flakeSaying([`${OURS}/cache/main`, `${OURS}/cache/spare`]),
    );
    expect(resolved).toEqual({
      kind: "ambiguous",
      substituters: [`${OURS}/cache/main`, `${OURS}/cache/spare`],
    });
  });

  it("looks at a BOUNDED number of substituters", async () => {
    const asked: string[] = [];
    const grants = grantsBroker();
    grants.register({
      bucketAt: (substituter) => {
        asked.push(substituter);
        return null;
      },
      mint: () => ({ id: "tok-1", token: "odu_test" }),
      revoke: () => {},
    });
    const many = Array.from({ length: 10_000 }, (_, i) => `https://many${i}.example`);
    const resolved = await resolvePushWith("/checkouts/flood", grants, flakeSaying(many));
    expect(resolved).toMatchObject({ kind: "skipped" });
    expect(asked.length).toBe(16);
    if (resolved.kind !== "skipped") return;
    expect(resolved.reason).not.toContain("many20.example");
  });
});
