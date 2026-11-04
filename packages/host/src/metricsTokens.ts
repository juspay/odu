/**
 * THE SCRAPE CREDENTIAL, KEPT BY THE HOST.
 *
 * **The host has no database.** Every other credential in this tree lives in the
 * row that issues it — the cache's `token` table, the door's sessions — and both
 * of those rows own SQLite. The host owns a gate file and a log, so a metrics
 * token is kept the way the host keeps everything else: one owner-only JSON file
 * under the per-user state root, written whole, replaced atomically. Three
 * verbs' worth of rows does not buy a schema, a migration ladder and a second
 * database handle in the one package that is supposed to compose rows rather
 * than be one.
 *
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

/** What the file keeps per token. `hash` never leaves this module. */
interface StoredToken {
  readonly id: string;
  readonly hash: string;
  readonly label: string;
  readonly created: number;
  lastUsed: number | null;
  revoked: boolean;
}

/** The public half — what a verb answers and a person reads. */
export interface MetricsTokenFacts {
  readonly id: string;
  readonly label: string;
  readonly created: number;
  readonly lastUsed: number | null;
  readonly revoked: boolean;
}

interface TokenFile {
  readonly version: 1;
  readonly tokens: StoredToken[];
}

/** The credential's own spelling, greppable in a log or a secret store, and
 *  distinct from the cache row's `odu_` so a token pasted into the wrong field
 *  is recognisable. */
const PREFIX = "odum_";

/** `last_used` is a WRITE on a read path. A scrape every fifteen seconds must
 *  not rewrite the file every fifteen seconds, and "when was this token last
 *  used" is a question nobody asks to the minute. The cache row throttles its
 *  own for the same reason. */
export const TOKEN_TOUCH_MS = 60_000;

export interface MetricsTokenStore {
  /** Mint one. The plaintext is in the answer and nowhere else, ever again. */
  mint(label: string): { token: string; facts: MetricsTokenFacts };
  /** Every token this daemon knows, revoked ones included: a list that hid them
   *  would make a revoked id look like a typo. */
  list(): readonly MetricsTokenFacts[];
  /** Revoke by id. `false` means there is no such token. */
  revoke(id: string): boolean;
  /** Does this presented secret open a scrape? Touches `lastUsed`, throttled. */
  verify(presented: string): boolean;
  /** Where the tokens are, for a sentence an operator can act on. */
  readonly path: string;
}

/** What the file holds, or an empty store — an unreadable or malformed file is
 *  an EMPTY token set rather than a refused boot: the root token still opens
 *  `/metrics`, and a daemon that would not start because a scrape credential
 *  file was corrupt would be a monitoring feature taking the service down. */
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
 *  never a half-written array. Owner-only, like every other file the host
 *  writes — a world-readable hash file is a dictionary attack's head start. */
function writeFile(path: string, file: TokenFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

const digest = (value: string): string => createHash("sha256").update(value, "utf-8").digest("hex");

/** Equal-length digests, compared in constant time. */
function sameSecret(presented: string, stored: string): boolean {
  const a = Buffer.from(digest(presented), "hex");
  const b = Buffer.from(stored, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * DOES THIS PRESENTED SECRET MATCH THE OPERATOR'S ROOT TOKEN?
 *
 * An unset root token can never match — not even an empty presented one, which
 * is what makes "no root token configured" a shut door rather than an open one.
 * The cache row and the door each keep this same five lines beside their own
 * credentials; the host keeps its own because it may not reach into a row for
 * one.
 */
export function rootTokenMatches(expected: string | null, presented: string): boolean {
  if (expected === null || expected === "" || presented === "") return false;
  return sameSecret(presented, digest(expected));
}

/**
 * OPEN THE STORE. `stateDir` is the host's per-user state root — the same one
 * the cache's database and the catalog live under, so a deployment that backs up
 * one backs up all of them.
 */
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
      // EVERY row is compared, revoked ones included, and the verdict is folded
      // afterwards: returning early on the first mismatch would make the
      // refusal's timing a function of where in the file a token sits.
      let opened: StoredToken | null = null;
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
