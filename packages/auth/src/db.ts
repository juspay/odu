import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Role } from "@odu/cordis/principal";
import { normalizeLogin } from "./github";

declare const Sha256HexTag: unique symbol;

export type Sha256Hex = string & { readonly [Sha256HexTag]: true };

export const sha256 = (value: string): Sha256Hex =>
  createHash("sha256").update(value).digest("hex") as Sha256Hex;

export interface SessionRow {
  cookieSha256: Sha256Hex;
  login: string;
  created: number;
  lastSeen: number;
  expires: number;
  agent: string | null;
}

export interface TokenRow {
  id: string;
  hash: Sha256Hex;
  login: string;
  name: string;
  created: number;
  lastUsed: number | null;
  expires: number | null;
  revoked: boolean;
}

export interface PersonRow {
  login: string;
  firstSeen: number;
  lastSeen: number;
}

export interface GrantRow {
  login: string;
  role: Role;
  created: number;
}

export interface AuthRepo {
  sessionIgnoringExpiry(cookieSha256: Sha256Hex): SessionRow | null;
  putSession(row: SessionRow): void;
  touchSession(id: Sha256Hex, at: number): void;
  deleteSession(id: Sha256Hex): void;
  sessions(login: string): SessionRow[];
  expiredSessions(now: number): SessionRow[];

  tokenByHash(hash: Sha256Hex): TokenRow | null;
  putToken(row: TokenRow): void;
  touchToken(id: string, at: number): void;
  revokeToken(id: string): boolean;
  tokens(login: string): TokenRow[];

  grant(login: string): GrantRow | null;
  setGrant(row: GrantRow): void;
  grants(): GrantRow[];
  recordPersonSeen(login: string, at: number): void;
  everySignedInLogin(): PersonRow[];

  close(): void;
}

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE session (
    id        TEXT PRIMARY KEY,
    login     TEXT NOT NULL,
    created   INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    expires   INTEGER NOT NULL,
    agent     TEXT
  );
  CREATE INDEX session_login ON session (login);
  CREATE INDEX session_expiry ON session (expires);

  CREATE TABLE token (
    id        TEXT PRIMARY KEY,
    hash      TEXT NOT NULL UNIQUE,
    login     TEXT NOT NULL,
    name      TEXT NOT NULL,
    created   INTEGER NOT NULL,
    last_used INTEGER,
    expires   INTEGER,
    revoked   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX token_login ON token (login);

  CREATE TABLE grant_row (
    login   TEXT PRIMARY KEY,
    role    TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE person (
    login      TEXT PRIMARY KEY,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
  INSERT INTO person (login, first_seen, last_seen)
    SELECT login, MIN(created), MAX(last_seen) FROM session GROUP BY login;
  `,
];

interface SessionDb {
  id: string;
  login: string;
  created: number;
  last_seen: number;
  expires: number;
  agent: string | null;
}

interface TokenDb {
  id: string;
  hash: string;
  login: string;
  name: string;
  created: number;
  last_used: number | null;
  expires: number | null;
  revoked: number;
}

interface GrantDb {
  login: string;
  role: string;
  created: number;
}

function bestEffortChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {}
}

export function openAuthRepo(path: string): AuthRepo {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version > MIGRATIONS.length) {
    db.close();
    throw new Error(
      `odu: ${path} was written by a newer build (schema ${version}) — this ` +
        `build reads ${MIGRATIONS.length}. Upgrade odu rather than reading it.`,
    );
  }
  for (let next = version; next < MIGRATIONS.length; next += 1) {
    db.transaction(() => {
      db.exec(MIGRATIONS[next] as string);
      db.exec(`PRAGMA user_version = ${next + 1}`);
    })();
  }
  bestEffortChmod(path, 0o600);

  const lower = normalizeLogin;

  const sessionOf = (row: SessionDb | null): SessionRow | null =>
    row === null
      ? null
      : {
          cookieSha256: row.id as Sha256Hex,
          login: row.login,
          created: row.created,
          lastSeen: row.last_seen,
          expires: row.expires,
          agent: row.agent,
        };

  const tokenOf = (row: TokenDb): TokenRow => ({
    id: row.id,
    hash: row.hash as Sha256Hex,
    login: row.login,
    name: row.name,
    created: row.created,
    lastUsed: row.last_used,
    expires: row.expires,
    revoked: row.revoked !== 0,
  });

  return {
    sessionIgnoringExpiry: (cookieSha256) =>
      sessionOf(
        db
          .query("SELECT * FROM session WHERE id = ?1")
          .get(cookieSha256) as SessionDb | null,
      ),
    putSession: (row) => {
      db.query(
        `INSERT INTO session (id, login, created, last_seen, expires, agent)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           login = excluded.login, last_seen = excluded.last_seen,
           expires = excluded.expires, agent = excluded.agent`,
      ).run(row.cookieSha256, lower(row.login), row.created, row.lastSeen, row.expires, row.agent);
    },
    touchSession: (id, at) => {
      db.query("UPDATE session SET last_seen = ?2 WHERE id = ?1").run(id, at);
    },
    deleteSession: (id) => {
      db.query("DELETE FROM session WHERE id = ?1").run(id);
    },
    sessions: (login) =>
      (
        db
          .query("SELECT * FROM session WHERE login = ?1 ORDER BY created DESC")
          .all(login) as SessionDb[]
      ).map((row) => ({
        cookieSha256: row.id as Sha256Hex,
        login: row.login,
        created: row.created,
        lastSeen: row.last_seen,
        expires: row.expires,
        agent: row.agent,
      })),
    expiredSessions: (now) =>
      (
        db
          .query("SELECT * FROM session WHERE expires <= ?1")
          .all(now) as SessionDb[]
      ).map((row) => ({
        cookieSha256: row.id as Sha256Hex,
        login: row.login,
        created: row.created,
        lastSeen: row.last_seen,
        expires: row.expires,
        agent: row.agent,
      })),

    tokenByHash: (hash) => {
      const row = db
        .query("SELECT * FROM token WHERE hash = ?1")
        .get(hash) as TokenDb | null;
      return row === null ? null : tokenOf(row);
    },
    putToken: (row) => {
      db.query(
        `INSERT INTO token (id, hash, login, name, created, last_used, expires, revoked)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).run(
        row.id,
        row.hash,
        lower(row.login),
        row.name,
        row.created,
        row.lastUsed,
        row.expires,
        row.revoked ? 1 : 0,
      );
    },
    touchToken: (id, at) => {
      db.query("UPDATE token SET last_used = ?2 WHERE id = ?1").run(id, at);
    },
    revokeToken: (id) => {
      const answer = db
        .query("UPDATE token SET revoked = 1 WHERE id = ?1 AND revoked = 0")
        .run(id);
      return answer.changes > 0;
    },
    tokens: (login) =>
      (
        db
          .query("SELECT * FROM token WHERE login = ?1 ORDER BY created DESC")
          .all(login) as TokenDb[]
      ).map(tokenOf),

    grant: (login) => {
      const row = db
        .query("SELECT * FROM grant_row WHERE login = ?1")
        .get(lower(login)) as GrantDb | null;
      return row === null ? null : { ...row, role: row.role as Role };
    },
    setGrant: (row) => {
      db.query(
        `INSERT INTO grant_row (login, role, created) VALUES (?1, ?2, ?3)
         ON CONFLICT(login) DO UPDATE SET role = excluded.role`,
      ).run(lower(row.login), row.role, row.created);
    },
    grants: () =>
      (db.query("SELECT * FROM grant_row ORDER BY login").all() as GrantDb[]).map(
        (row) => ({ ...row, role: row.role as Role }),
      ),
    recordPersonSeen: (login, at) => {
      db.query(
        `INSERT INTO person (login, first_seen, last_seen) VALUES (?1, ?2, ?2)
         ON CONFLICT(login) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen)`,
      ).run(lower(login), at);
    },
    everySignedInLogin: () =>
      db
        .query(
          "SELECT login, first_seen AS firstSeen, last_seen AS lastSeen FROM person ORDER BY login",
        )
        .all() as PersonRow[],

    close: () => db.close(),
  };
}
