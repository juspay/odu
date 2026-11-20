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
