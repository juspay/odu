import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CacheRepo, Scope, TokenRow } from "./db";

export function mintToken(): string {
  return `odu_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const RANK: Record<Scope, number> = { read: 1, write: 2, admin: 3 };

export function scopeAtLeast(have: Scope, need: Scope): boolean {
  return RANK[have] >= RANK[need];
}

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

export const TOKEN_TOUCH_MS = 60_000;

export type TokenVerdict =
  | { ok: true; token: TokenRow }
  | {
      ok: false;
      reason: "unknown" | "revoked" | "wrong_bucket" | "insufficient";
    }
  | { ok: false; reason: "expired"; expiredAt: number };

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
  if (row.expires !== null && row.expires <= now) {
    return { ok: false, reason: "expired", expiredAt: row.expires };
  }
  if (!globMatches(row.bucketGlob, bucket)) return { ok: false, reason: "wrong_bucket" };
  if (!scopeAtLeast(row.scope, need)) return { ok: false, reason: "insufficient" };
  if (row.lastUsed === null || now - row.lastUsed >= TOKEN_TOUCH_MS) {
    repo.touchToken(row.id, now);
  }
  return { ok: true, token: row };
}

export function rootTokenMatches(expected: string | null, presented: string): boolean {
  if (expected === null || expected === "") return false;
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(presented, "utf8").digest();
  return timingSafeEqual(a, b);
}

export interface TokenFacts {
  id: string;
  bucketGlob: string;
  scope: Scope;
  expires: number | null;
  label: string | null;
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
    label: row.label,
    lastUsed: row.lastUsed,
    revoked: row.revoked,
    created: row.created,
  };
}

export function mintTokenId(): string {
  return randomBytes(8).toString("hex");
}
