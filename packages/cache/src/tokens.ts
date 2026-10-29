/**
 * TOKENS — opaque, hashed, scoped, expiring, revocable.
 *
 * The database holds a sha256 and never the token, so a copy of the file cannot
 * push. A token names a bucket GLOB rather than one bucket, because a team's CI
 * pushes to two or three caches and minting one token per bucket per job is the
 * kind of friction that ends with one token pasted everywhere.
 *
 * **The root token is not a row.** It is a string the composition root passes
 * in, read from `$ODU_ROOT_TOKEN` — a secret the NixOS module writes from a
 * secret path (PR 2). It is compared in constant time against a digest, so the
 * comparison does not leak its prefix through timing, and it is checked HERE
 * rather than in the service, because the service's job is to pass it through
 * (see `@odu/service`'s `CacheAdmin` port).
 *
 * **Absent is a state, not an error.** With no root token configured — the
 * developer's `odu web` on a laptop, which has no module and no secret file —
 * every admin verb refuses with `no_root_token` and the PROTOCOL routes keep
 * serving. That is the shape the brief asks for, and it is the safe one: a
 * missing secret cannot silently become "anyone may mint".
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CacheRepo, Scope, TokenRow } from "./db";

/** `odu_` and 32 random bytes, base64url — 43 characters of entropy no person
 *  can remember and no log should ever hold twice. The prefix is what makes a
 *  leaked token greppable. */
export function mintToken(): string {
  return `odu_${randomBytes(32).toString("base64url")}`;
}

/** What the database keeps. Hex, so it indexes and compares as text. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const RANK: Record<Scope, number> = { read: 1, write: 2, admin: 3 };

/** Does `have` cover `need`? The ordering is the whole of the authorisation
 *  model: an admin token reads and writes, a write token reads. */
export function scopeAtLeast(have: Scope, need: Scope): boolean {
  return RANK[have] >= RANK[need];
}

/**
 * Does a token's glob cover this bucket? A comma-separated list of patterns
 * where `*` matches anything, so `team-*` covers `team-ci` and `*` covers
 * everything. Anchored and literal otherwise: a pattern is not a regex, and the
 * day it becomes one is the day `cache-nixos-org-1` starts matching more than
 * it was meant to.
 */
export function globMatches(glob: string, bucket: string): boolean {
  return glob
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== "")
    .some((pattern) => {
      const escaped = pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      return new RegExp(`^${escaped}$`).test(bucket);
    });
}

/** How often a token's `last_used` is written. Every request would turn a read
 *  into a write on a hot cache; a minute is enough for "which token is that CI
 *  job using" and costs nothing. */
export const TOKEN_TOUCH_MS = 60_000;

export type TokenVerdict =
  | { ok: true; token: TokenRow }
  | { ok: false; reason: "unknown" | "revoked" | "expired" | "wrong_bucket" | "insufficient" };

/**
 * Resolve a presented token against a bucket and the scope the operation needs.
 * `now` is passed in so a suite can expire a token without waiting.
 */
export function verifyToken(
  repo: CacheRepo,
  presented: string,
  bucket: string,
  need: Scope,
  now: number,
): TokenVerdict {
  const row = repo.tokenByHash(hashToken(presented));
  if (row === null) return { ok: false, reason: "unknown" };
  if (row.revoked) return { ok: false, reason: "revoked" };
  if (row.expires !== null && row.expires <= now) return { ok: false, reason: "expired" };
  if (!globMatches(row.bucketGlob, bucket)) return { ok: false, reason: "wrong_bucket" };
  if (!scopeAtLeast(row.scope, need)) return { ok: false, reason: "insufficient" };
  if (row.lastUsed === null || now - row.lastUsed >= TOKEN_TOUCH_MS) {
    repo.touchToken(row.id, now);
  }
  return { ok: true, token: row };
}

/**
 * Is this the root token? Constant time, and a missing configured token can
 * never match — including against an empty presented string, which is the
 * failure this exists to prevent.
 */
export function rootTokenMatches(expected: string | null, presented: string): boolean {
  if (expected === null || expected === "") return false;
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(presented, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** A token's public half — what `odu cache token list` shows. The hash never
 *  leaves this module's callers. */
export interface TokenFacts {
  id: string;
  bucketGlob: string;
  scope: Scope;
  expires: number | null;
  lastUsed: number | null;
  revoked: boolean;
  created: number;
}

export function tokenFacts(row: TokenRow): TokenFacts {
  return {
    id: row.id,
    bucketGlob: row.bucketGlob,
    scope: row.scope,
    expires: row.expires,
    lastUsed: row.lastUsed,
    revoked: row.revoked,
    created: row.created,
  };
}

/** A token id: short, random, and greppable in a log beside the bucket it
 *  belongs to. It is NOT a credential — revocation is its only use. */
export function mintTokenId(): string {
  return randomBytes(8).toString("hex");
}
