/**
 * WHERE A RUN PUSHES — the resolution, falsified (PLAN 4.1).
 *
 * The whole of what a repository declares is an `extra-substituters` line in
 * `flake.nix`, and the whole of what is BELIEVED is the URL: the daemon
 * matches it against what it advertises and dials nothing. So the arms here
 * are a repo with no flake, a flake that will not evaluate, a `nixConfig`
 * naming nothing, naming somebody else's cache, naming ours, and naming two of
 * ours — plus the one that matters most, a flake that LIES.
 *
 * `nix eval` is injected: these are about the DECISION, and a suite that
 * needed a Nix to assert "no flake means no push" would assert it on neither.
 */

import { describe, expect, it } from "bun:test";
import type { CacheGrantor, GrantedBucket } from "@odu/cordis/services";
import { grantsBroker } from "@odu/cordis/services";
import type { CacheGrants } from "@odu/cordis/services";
import { resolvePushWith } from "./webPorts";

const OURS = "https://odu.example.org";
const KEY = "main-1:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqs=";

/**
 * A broker over a daemon that serves these buckets at these URLs.
 *
 * `bucketAt` is keyed by URL, which is the point: the cache row answers from
 * what it ADVERTISES, so there is no body for a repository to forge.
 */
function serving(at: Record<string, string> = { [`${OURS}/cache/main`]: "main" }): CacheGrants {
  const grants = grantsBroker();
  const grantor: CacheGrantor = {
    origin: () => OURS,
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

/** A `readFlakeNixConfig` that answers whatever the test states. */
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
    // A hung `nix`, a store that is not there and a real syntax error all land
    // in the same arm, and only nix's own line tells them apart. "Your flake
    // is wrong" would be an accusation odu is not entitled to make.
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
    // The broker with nobody registered. Evaluating a repository's Nix to
    // learn something already known would be a cost — and an exposure — paid
    // for an answer that cannot change.
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
    // THE WHOLE SECURITY ARGUMENT. The first shape of this asked each
    // substituter for its `nix-cache-info` and believed the `Odu-Origin` /
    // `Odu-Bucket` lines in the body — so a flake pointing at a server the
    // attacker runs, answering with any bucket name served here, collected a
    // write token for that bucket and then posted it to that same server.
    // There is no body in this resolution to lie with.
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
        // NOT read back off a server: the daemon's own push origin.
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
    // A warning and NOT a refusal: the bytes are correct and worth storing,
    // and the next machine may well trust the key even if this flake does not.
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
    // A repository builds for ONE cache. Choosing between two would be this
    // resolver inventing a policy nobody asked for, and there is deliberately
    // no override key until somebody hits the case.
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
    // The list is a repository's, this loop is on the daemon's single event
    // loop during `run.start`, and the only other bound on its length is the
    // eval's 64 KiB stdout cap. A branch declaring ten thousand of them would
    // otherwise be a repeatable way to spend the daemon's time.
    const asked: string[] = [];
    const grants = grantsBroker();
    grants.register({
      origin: () => OURS,
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
    // AND THE SENTENCE IS BOUNDED WITH IT: the reason becomes an argv and a
    // durable manifest field, so it names what was looked at, not the list.
    if (resolved.kind !== "skipped") return;
    expect(resolved.reason).not.toContain("many20.example");
  });
});
