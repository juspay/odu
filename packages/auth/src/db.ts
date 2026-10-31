/**
 * `auth.sqlite` — sessions, personal tokens, grants.
 *
 * The second database in the tree, with the first one's shape (`@odu/cache`'s
 * `db.ts`): SQLite in WAL mode, `bun:sqlite` because it is the runtime's own
 * binding, migrations by `PRAGMA user_version`, and a narrow repository
 * interface so PR 12's Postgres swap is one file.
 *
 * **What is stored, and what never is.** A session is stored by the SHA-256 of
 * its cookie value, and a token by the SHA-256 of its secret — so a copy of this
 * file is not a set of credentials. The cookie's own value is held only by the
 * browser that signed in.
 *
 * **Grants are the role table.** A login's role is one row; its absence means
 * {@link DEFAULT_ROLE}. GitHub decides who may enter; odu decides what a person
 * may do once in, and that decision is here rather than in GitHub because it is
 * this daemon's.
 */

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Role } from "@odu/cordis/principal";

export interface SessionRow {
  /** sha256 of the session's cookie value, hex. */
  id: string;
  login: string;
  created: number;
  lastSeen: number;
  expires: number;
  agent: string | null;
}

export interface TokenRow {
  id: string;
  /** sha256 of the token, hex. Never the token. */
  hash: string;
  login: string;
  name: string;
  created: number;
  lastUsed: number | null;
  expires: number | null;
  revoked: boolean;
}

export interface GrantRow {
  login: string;
  role: Role;
  created: number;
}

/** The whole of what the row needs from storage. No SQL, no transaction, no
 *  `Database` in a signature. */
export interface AuthRepo {
  /** A live session by its hash, or null. Expiry is the caller's question —
   *  this answers the row, not whether it is still valid. */
  session(id: string): SessionRow | null;
  putSession(row: SessionRow): void;
  touchSession(id: string, at: number): void;
  deleteSession(id: string): void;
  sessions(login: string): SessionRow[];
  expiredSessions(now: number): SessionRow[];

  tokenByHash(hash: string): TokenRow | null;
  putToken(row: TokenRow): void;
  touchToken(id: string, at: number): void;
  revokeToken(id: string): boolean;
  tokens(login: string): TokenRow[];

  grant(login: string): GrantRow | null;
  setGrant(row: GrantRow): void;
  grants(): GrantRow[];

  close(): void;
}

/** Schema changes, in order. `PRAGMA user_version` is the schema's own number
 *  and the only place it lives. */
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

export function openAuthRepo(path: string): AuthRepo {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true });
  // WAL, and a busy timeout: the daemon serves a profile page and a session
  // sweep from one connection, and a second `odu` process reading the same file
  // (a CLI with `ODU_STATE_DIR` pointing at a live daemon's) must not see
  // `database is locked` as a refusal.
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
  try {
    chmodSync(path, 0o600);
  } catch {
    // The directory is 0700 and the WAL files inherit the file's mode; a
    // filesystem that refuses the chmod is not a reason to refuse to serve.
  }

  /** GitHub logins are case-insensitive, and a grant typed `Srid` must find the
   *  grant written by a sign-in as `srid`. ONE place lowercases. */
  const lower = (login: string): string => login.trim().toLowerCase();

  const sessionOf = (row: SessionDb | null): SessionRow | null =>
    row === null
      ? null
      : {
          id: row.id,
          login: row.login,
          created: row.created,
          lastSeen: row.last_seen,
          expires: row.expires,
          agent: row.agent,
        };

  const tokenOf = (row: TokenDb): TokenRow => ({
    id: row.id,
    hash: row.hash,
    login: row.login,
    name: row.name,
    created: row.created,
    lastUsed: row.last_used,
    expires: row.expires,
    revoked: row.revoked !== 0,
  });

  return {
    session: (id) =>
      sessionOf(
        db
          .query("SELECT * FROM session WHERE id = ?1")
          .get(id) as SessionDb | null,
      ),
    putSession: (row) => {
      db.query(
        `INSERT INTO session (id, login, created, last_seen, expires, agent)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           login = excluded.login, last_seen = excluded.last_seen,
           expires = excluded.expires, agent = excluded.agent`,
      ).run(row.id, lower(row.login), row.created, row.lastSeen, row.expires, row.agent);
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
        id: row.id,
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
        id: row.id,
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

    close: () => db.close(),
  };
}
