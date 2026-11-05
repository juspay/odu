/**
 * WHERE A RUN PUSHES — the resolution, falsified (PLAN 4.1).
 *
 * The whole of what a repository declares is an `extra-substituters` line in
 * `flake.nix`, so every arm of this resolution is a reading of somebody else's
 * configuration: a repo with no flake, a flake that will not evaluate, a
 * `nixConfig` naming nothing, naming a cache that is not odu's, naming an odu
 * cache somebody ELSE serves, and naming two. Each has a different right
 * answer and two of them — "served elsewhere" and "two caches" — are the ones
 * a run must never silently push through.
 *
 * `nix eval` and `fetch` are both injected: the arms here are about the
 * DECISION, and a suite that needed a Nix and an HTTP server to assert "no
 * flake means no push" would assert it on neither.
 */

import { describe, expect, it } from "bun:test";
import type { CacheGrants, CacheGrantor } from "@odu/cordis/services";
import { grantsBroker } from "@odu/cordis/services";
import type { OduSubstituter } from "@odu/cache/push";
import { resolvePushWith } from "./webPorts";

const OURS = "https://odu.example.org";
const KEY = "main-1:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqs=";

/** A broker with one bucket on it, the way a daemon serving a cache has. */
function serving(
  buckets: Record<string, string> = { main: KEY },
  origin = OURS,
): CacheGrants {
  const grants = grantsBroker();
  const grantor: CacheGrantor = {
    origin: () => origin,
    bucket: (name) => {
      const publicKey = buckets[name];
      return publicKey === undefined ? null : { name, publicKey };
    },
    mint: () => ({ id: "tok-1", token: "odu_test" }),
    revoke: () => {},
  };
  grants.register(grantor);
  return grants;
}

/** A `readFlakeNixConfig` that answers whatever the test states. */
const flakeSaying = (
  substituters: readonly string[],
  trustedPublicKeys: readonly string[] = [],
) =>
  (() => ({ ok: true as const, config: { substituters, trustedPublicKeys } }));

/** An `oduCachesOf` that answers for the substituters it recognises. */
const cachesAt = (known: Record<string, { origin: string; bucket: string }>) =>
  async (substituters: readonly string[]): Promise<OduSubstituter[]> =>
    substituters.flatMap((substituter) => {
      const facts = known[substituter];
      return facts === undefined ? [] : [{ substituter, ...facts }];
    });

describe("resolving where a checkout pushes", () => {
  it("skips a checkout with no flake, saying so", async () => {
    const resolved = await resolvePushWith(
      "/checkouts/plain",
      serving(),
      () => ({ ok: false, reason: "no flake.nix" }),
      cachesAt({}),
    );
    expect(resolved).toEqual({ kind: "skipped", reason: "no flake.nix" });
  });

  it("carries the evaluator's own sentence when nixConfig will not evaluate", async () => {
    const resolved = await resolvePushWith(
      "/checkouts/broken",
      serving(),
      () => ({
        ok: false,
        reason: "flake.nix nixConfig could not be read — error: undefined variable 'pkgs'",
      }),
      cachesAt({}),
    );
    // THE STDERR LINE, not a sentence this layer invented: the person who has
    // to fix the flake needs Nix's own complaint, and "could not resolve a
    // cache" would send them looking at odu.
    expect(resolved).toMatchObject({ kind: "skipped" });
    if (resolved.kind !== "skipped") return;
    expect(resolved.reason).toContain("undefined variable 'pkgs'");
  });

  it("skips a nixConfig that names no substituters", async () => {
    const resolved = await resolvePushWith(
      "/checkouts/bare",
      serving(),
      flakeSaying([]),
      cachesAt({}),
    );
    expect(resolved).toEqual({
      kind: "skipped",
      reason: "flake.nix nixConfig names no substituters",
    });
  });

  it("ignores a substituter that is not an odu cache", async () => {
    // `cache.nixos.org` is in a great many flakes and is nobody's push target.
    // Silence is the answer: a line per run saying "nixos.org is not yours"
    // would be noise on every repository in existence.
    const resolved = await resolvePushWith(
      "/checkouts/nixpkgs-reader",
      serving(),
      flakeSaying(["https://cache.nixos.org"]),
      cachesAt({}),
    );
    expect(resolved).toEqual({
      kind: "skipped",
      reason: "no substituter in flake.nix nixConfig is an odu cache",
    });
  });

  it("refuses to push to an odu cache this daemon does not serve, naming it", async () => {
    // THE INTERIM WRITE GRANT, until orgs land: `Odu-Origin` is us AND the
    // bucket exists here. Another odu's cache is a cache we hold no credential
    // for, and minting one for it would be this daemon granting itself write
    // access to somebody else's bucket.
    const resolved = await resolvePushWith(
      "/checkouts/theirs",
      serving(),
      flakeSaying(["https://cache.them.example/theirs"]),
      cachesAt({
        "https://cache.them.example/theirs": {
          origin: "https://odu.them.example",
          bucket: "theirs",
        },
      }),
    );
    expect(resolved).toEqual({
      kind: "skipped",
      reason: "reads https://cache.them.example/theirs, served elsewhere",
    });
  });

  it("refuses an odu cache whose origin is ours but whose bucket is gone", async () => {
    const resolved = await resolvePushWith(
      "/checkouts/deleted",
      serving({}),
      flakeSaying([`${OURS}/cache/main`]),
      cachesAt({ [`${OURS}/cache/main`]: { origin: OURS, bucket: "main" } }),
    );
    expect(resolved).toMatchObject({ kind: "skipped" });
  });

  it("resolves the one odu cache this daemon serves", async () => {
    const resolved = await resolvePushWith(
      "/checkouts/ours",
      serving(),
      flakeSaying([`${OURS}/cache/main`], [KEY]),
      cachesAt({ [`${OURS}/cache/main`]: { origin: OURS, bucket: "main" } }),
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

  it("warns, and still pushes, when trusted-public-keys is missing the key", async () => {
    // A warning and NOT a refusal: the bytes are correct and worth storing,
    // and the next machine may well trust the key even if this flake does not.
    const resolved = await resolvePushWith(
      "/checkouts/untrusting",
      serving(),
      flakeSaying([`${OURS}/cache/main`], []),
      cachesAt({ [`${OURS}/cache/main`]: { origin: OURS, bucket: "main" } }),
    );
    expect(resolved).toMatchObject({ kind: "target" });
    if (resolved.kind !== "target") return;
    expect(resolved.target.keyWarning).toContain(KEY);
    expect(resolved.target.keyWarning).toContain("trusted-public-keys");
  });

  it("REFUSES two odu caches it could write to, naming both", async () => {
    // A repository builds for ONE cache. Choosing between two would be this
    // resolver inventing a policy nobody asked for, and there is deliberately
    // no override key until somebody hits the case.
    const grants = serving({ main: KEY, spare: KEY });
    const resolved = await resolvePushWith(
      "/checkouts/two",
      grants,
      flakeSaying([`${OURS}/cache/main`, `${OURS}/cache/spare`]),
      cachesAt({
        [`${OURS}/cache/main`]: { origin: OURS, bucket: "main" },
        [`${OURS}/cache/spare`]: { origin: OURS, bucket: "spare" },
      }),
    );
    expect(resolved).toEqual({
      kind: "ambiguous",
      substituters: [`${OURS}/cache/main`, `${OURS}/cache/spare`],
    });
  });

  it("pushes nowhere at all on a daemon with no cache row", async () => {
    // The broker with nobody registered — a daemon that serves no cache. Every
    // question answers no, and the run proceeds exactly as it did before.
    const resolved = await resolvePushWith(
      "/checkouts/ours",
      grantsBroker(),
      flakeSaying([`${OURS}/cache/main`]),
      cachesAt({ [`${OURS}/cache/main`]: { origin: OURS, bucket: "main" } }),
    );
    expect(resolved).toMatchObject({ kind: "skipped" });
  });
});
