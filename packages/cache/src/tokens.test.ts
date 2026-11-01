/**
 * Tokens: what a scope means, what a glob matches, and when a token stops
 * working.
 *
 * The four ways a token can fail are separate answers on purpose — `odu cache`
 * says "revoked" or "expired" rather than "unauthorised", because the person
 * holding it can act on the first two and not on the third.
 */

import { describe, expect, it } from "bun:test";
import { type CacheRepo, openCacheRepo, type TokenRow } from "./db";
import {
  globMatches,
  hashToken,
  mintToken,
  mintTokenId,
  rootTokenMatches,
  scopeAtLeast,
  tokenFacts,
  TOKEN_TOUCH_MS,
  verifyToken,
} from "./tokens";

const NOW = 1_700_000_000_000;

function repoWith(token: Partial<TokenRow> & { hash: string }): CacheRepo {
  const repo = openCacheRepo(":memory:");
  repo.putToken({
    id: mintTokenId(),
    bucketGlob: "main",
    scope: "write",
    expires: null,
    lastUsed: null,
    revoked: false,
    created: NOW,
    ...token,
  });
  return repo;
}

describe("minted tokens", () => {
  it("is random, prefixed, and stored only as a hash", () => {
    const a = mintToken();
    const b = mintToken();
    expect(a.startsWith("odu_")).toBe(true);
    expect(a).not.toBe(b);
    expect(a).toHaveLength(4 + 43);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toBe(hashToken(b));
  });
});

describe("scope", () => {
  it("is ordered read < write < admin", () => {
    expect(scopeAtLeast("read", "read")).toBe(true);
    expect(scopeAtLeast("write", "read")).toBe(true);
    expect(scopeAtLeast("admin", "write")).toBe(true);
    expect(scopeAtLeast("read", "write")).toBe(false);
    expect(scopeAtLeast("write", "admin")).toBe(false);
  });
});

describe("bucket globs", () => {
  it("matches exactly, by prefix wildcard, and by star", () => {
    expect(globMatches("main", "main")).toBe(true);
    expect(globMatches("main", "main2")).toBe(false);
    expect(globMatches("*", "anything")).toBe(true);
    expect(globMatches("team-*", "team-ci")).toBe(true);
    expect(globMatches("team-*", "my-team-ci")).toBe(false);
    expect(globMatches("a,b", "b")).toBe(true);
    expect(globMatches("a, b", "b")).toBe(true);
  });

  it("treats a pattern as a pattern, not as a regex", () => {
    // The day a glob becomes a regex is the day `cache.nixos.org-1` starts
    // matching more than it was meant to.
    expect(globMatches("cache.nixos.org-1", "cacheXnixosXorg-1")).toBe(false);
  });
});

describe("verifyToken", () => {
  it("accepts a live token with the right bucket and scope", () => {
    const token = mintToken();
    const repo = repoWith({ hash: hashToken(token) });
    const verdict = verifyToken(repo, token, "main", "write", NOW);
    expect(verdict.ok).toBe(true);
  });

  it("says which of the four things went wrong", () => {
    const live = mintToken();
    const expired = mintToken();
    const revoked = mintToken();
    const repo = repoWith({ hash: hashToken(live) });
    repo.putToken({
      id: mintTokenId(),
      hash: hashToken(expired),
      bucketGlob: "main",
      scope: "write",
      expires: NOW - 1,
      lastUsed: null,
      revoked: false,
      created: NOW,
    });
    repo.putToken({
      id: mintTokenId(),
      hash: hashToken(revoked),
      bucketGlob: "main",
      scope: "write",
      expires: null,
      lastUsed: null,
      revoked: true,
      created: NOW,
    });

    expect(verifyToken(repo, "odu_nope", "main", "read", NOW)).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(verifyToken(repo, expired, "main", "read", NOW)).toEqual({
      ok: false,
      reason: "expired",
      expiredAt: NOW - 1,
    });
    expect(verifyToken(repo, revoked, "main", "read", NOW)).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(verifyToken(repo, live, "other", "read", NOW)).toEqual({
      ok: false,
      reason: "wrong_bucket",
    });
    expect(verifyToken(repo, live, "main", "admin", NOW)).toEqual({
      ok: false,
      reason: "insufficient",
    });
  });

  it("keeps last_used to once a minute", () => {
    const token = mintToken();
    const repo = repoWith({ hash: hashToken(token) });
    verifyToken(repo, token, "main", "read", NOW);
    const first = repo.tokenByHash(hashToken(token))?.lastUsed;
    expect(first).toBe(NOW);

    verifyToken(repo, token, "main", "read", NOW + 1_000);
    expect(repo.tokenByHash(hashToken(token))?.lastUsed).toBe(NOW);

    verifyToken(repo, token, "main", "read", NOW + TOKEN_TOUCH_MS);
    expect(repo.tokenByHash(hashToken(token))?.lastUsed).toBe(NOW + TOKEN_TOUCH_MS);
  });

  it("does not spend a write on a token that is refused", () => {
    const token = mintToken();
    const repo = repoWith({ hash: hashToken(token), scope: "read" });
    verifyToken(repo, token, "main", "write", NOW);
    expect(repo.tokenByHash(hashToken(token))?.lastUsed).toBeNull();
  });
});

describe("the root token", () => {
  it("compares in constant time and never matches an absent configuration", () => {
    expect(rootTokenMatches("secret", "secret")).toBe(true);
    expect(rootTokenMatches("secret", "secreT")).toBe(false);
    expect(rootTokenMatches("secret", "")).toBe(false);
    // The failure this exists to prevent: no configured token must not mean
    // "anything matches", least of all the empty string.
    expect(rootTokenMatches(null, "")).toBe(false);
    expect(rootTokenMatches(null, "anything")).toBe(false);
    expect(rootTokenMatches("", "")).toBe(false);
  });
});

describe("tokenFacts", () => {
  it("never carries the hash", () => {
    const repo = repoWith({ hash: hashToken(mintToken()) });
    const row = repo.tokens()[0];
    expect(row).toBeDefined();
    const facts = tokenFacts(row as TokenRow);
    expect(Object.keys(facts).sort()).toEqual([
      "bucketGlob",
      "created",
      "expires",
      "id",
      "lastUsed",
      "revoked",
      "scope",
    ]);
  });
});
