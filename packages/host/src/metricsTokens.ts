/**
 * What is NOT kept is the token. A mint answers the plaintext once and stores a
 * sha256 of it, exactly as `@odu/cache`'s `token` table does — a file somebody
 * can read is a file that must not carry a credential.
 *
 * Comparison is constant-time over the DIGESTS (equal length, always), so a
 * presented token's prefix cannot be learned from how long the refusal took.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MetricsTokenFacts } from "@odu/cordis/metricsSurface";

interface StoredToken {
  readonly id: string;
  readonly hash: string;
  readonly label: string;
  readonly created: number;
  lastUsed: number | null;
  revoked: boolean;
}

/** THE PUBLIC HALF IS THE WIRE'S, imported rather than restated: it is what
 *  `token.list` is validated against (`MetricsTokenSchema`), and a second
 *  declaration that drifted would show up only as a decode failure on a verb. */
export type { MetricsTokenFacts };

interface TokenFile {
  readonly version: 1;
  readonly tokens: StoredToken[];
}

const PREFIX = "odum_";

export const TOKEN_TOUCH_MS = 60_000;

export interface MetricsTokenStore {
  mint(label: string): { token: string; facts: MetricsTokenFacts };
  list(): readonly MetricsTokenFacts[];
  revoke(id: string): boolean;
  verify(presented: string): boolean;
  readonly path: string;
}

function readFile(path: string): TokenFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as TokenFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.tokens)) return { version: 1, tokens: [] };
    return parsed;
  } catch {
    return { version: 1, tokens: [] };
  }
}

/** Whole-file replace: a reader either sees the previous set or the next one,
 *  never a half-written array. */
function writeFile(path: string, file: TokenFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

const digest = (value: string): string => createHash("sha256").update(value, "utf-8").digest("hex");

function sameSecret(presented: string, stored: string): boolean {
  const a = Buffer.from(digest(presented), "hex");
  const b = Buffer.from(stored, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The cache row and the door each keep this same five lines beside their own
 * credentials; the host keeps its own because it may not reach into a row for
 * one.
 */
export function rootTokenMatches(expected: string | null, presented: string): boolean {
  if (expected === null || expected === "" || presented === "") return false;
  return sameSecret(presented, digest(expected));
}

export function openMetricsTokens(
  stateDir: string,
  now: () => number = Date.now,
): MetricsTokenStore {
  const path = join(stateDir, "metrics", "tokens.json");
  return {
    path,
    mint(label) {
      const file = readFile(path);
      const token = `${PREFIX}${randomBytes(32).toString("base64url")}`;
      const row: StoredToken = {
        id: randomBytes(8).toString("hex"),
        hash: digest(token),
        label,
        created: now(),
        lastUsed: null,
        revoked: false,
      };
      file.tokens.push(row);
      writeFile(path, file);
      const { hash: _hash, ...facts } = row;
      return { token, facts };
    },
    list() {
      return readFile(path).tokens.map(({ hash: _hash, ...facts }) => facts);
    },
    revoke(id) {
      const file = readFile(path);
      const row = file.tokens.find((one) => one.id === id);
      if (row === undefined) return false;
      row.revoked = true;
      writeFile(path, file);
      return true;
    },
    verify(presented) {
      if (presented === "") return false;
      const file = readFile(path);
      let opened: StoredToken | null = null;
      // EVERY row is compared, revoked ones included, and the verdict is folded
      // afterwards: returning early on the first mismatch would make the
      // refusal's timing a function of where in the file a token sits.
      for (const row of file.tokens) {
        if (sameSecret(presented, row.hash) && !row.revoked) opened = row;
      }
      if (opened === null) return false;
      const at = now();
      if (opened.lastUsed === null || at - opened.lastUsed >= TOKEN_TOUCH_MS) {
        opened.lastUsed = at;
        writeFile(path, file);
      }
      return true;
    },
  };
}
