/**
 * WHAT THIS ROW HAS MADE, so it can find it again.
 *
 * Cloudflare's API has no "give me the tunnel this install created" — a tunnel
 * is an account resource with a human name — so the id, the connector's token
 * and the DNS record ids live here. The token is the one SECRET in this file,
 * which is why the directory is 0700 and the file (and SQLite's siblings) 0600:
 * a copy of the database must not be a credential.
 *
 * The routes are the row's DIFF against the cache's published domains: a bucket
 * that has a domain but no route row is work to do, and a route row whose
 * domain is gone is a record to remove.
 */

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RouteState } from "./surface";

/** The ONE tunnel this server made. */
export interface TunnelRow {
  tunnelId: string;
  /** The human name: `odu <public origin host>`. */
  name: string;
  /** The connector's credential. A secret, kept only here. */
  token: string;
  accountId: string;
  created: number;
}

/** One name the tunnel carries. */
export interface RouteRow {
  domain: string;
  /** The bucket, or null for the server's own public origin. */
  bucket: string | null;
  zoneId: string;
  /** The DNS record this row made; empty while the row is still being wired. */
  recordId: string;
  state: RouteState;
  reason: string | null;
  updated: number;
}

export interface CloudflareRepo {
  tunnel(): TunnelRow | null;
  putTunnel(row: TunnelRow): void;
  deleteTunnel(): void;

  route(domain: string): RouteRow | null;
  routes(): RouteRow[];
  putRoute(row: RouteRow): void;
  deleteRoute(domain: string): void;

  close(): void;
}

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE tunnel (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    tunnel_id  TEXT NOT NULL,
    name       TEXT NOT NULL,
    token      TEXT NOT NULL,
    account_id TEXT NOT NULL,
    created    INTEGER NOT NULL
  );

  CREATE TABLE route (
    domain    TEXT PRIMARY KEY,
    bucket    TEXT,
    zone_id   TEXT NOT NULL,
    record_id TEXT NOT NULL,
    state     TEXT NOT NULL,
    reason    TEXT,
    updated   INTEGER NOT NULL
  );
  `,
];

interface Row {
  [column: string]: unknown;
}

const text = (row: Row, column: string): string => String(row[column]);
const maybeText = (row: Row, column: string): string | null => {
  const value = row[column];
  return value === null || value === undefined ? null : String(value);
};
const integer = (row: Row, column: string): number => Number(row[column]);

const tunnelOf = (row: Row): TunnelRow => ({
  tunnelId: text(row, "tunnel_id"),
  name: text(row, "name"),
  token: text(row, "token"),
  accountId: text(row, "account_id"),
  created: integer(row, "created"),
});

const routeOf = (row: Row): RouteRow => ({
  domain: text(row, "domain"),
  bucket: maybeText(row, "bucket"),
  zoneId: text(row, "zone_id"),
  recordId: text(row, "record_id"),
  state: text(row, "state") as RouteState,
  reason: maybeText(row, "reason"),
  updated: integer(row, "updated"),
});

export function openCloudflareRepo(path: string): CloudflareRepo {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      chmodSync(dirname(path), 0o700);
    } catch {
      // A state root somebody else owns is theirs to fix; the file modes below
      // still apply to what this process creates.
    }
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  const current = Number(
    (db.query("PRAGMA user_version;").get() as Row | null)?.["user_version"] ?? 0,
  );
  if (current > MIGRATIONS.length) {
    throw new Error(
      `odu: ${path} was written by a newer odu (schema ${current}, this build ` +
        `reads ${MIGRATIONS.length}) — upgrade odu rather than reading it`,
    );
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version] as string);
      db.exec(`PRAGMA user_version = ${version + 1};`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // AFTER the migrations: `-wal` and `-shm` exist only after the first write,
  // and this file holds a tunnel token.
  if (path !== ":memory:") {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        chmodSync(file, 0o600);
      } catch {
        // `-shm` is absent outside WAL mode.
      }
    }
  }

  return {
    tunnel: () => {
      const row = db.query("SELECT * FROM tunnel WHERE id = 1").get() as Row | null;
      return row === null ? null : tunnelOf(row);
    },
    putTunnel(row) {
      db.run(
        `INSERT INTO tunnel (id, tunnel_id, name, token, account_id, created)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET tunnel_id = excluded.tunnel_id,
           name = excluded.name, token = excluded.token,
           account_id = excluded.account_id`,
        [row.tunnelId, row.name, row.token, row.accountId, row.created],
      );
    },
    deleteTunnel() {
      db.run("DELETE FROM tunnel WHERE id = 1");
    },

    route: (domain) => {
      const row = db.query("SELECT * FROM route WHERE domain = ?").get(domain) as Row | null;
      return row === null ? null : routeOf(row);
    },
    routes: () =>
      (db.query("SELECT * FROM route ORDER BY domain").all() as Row[]).map(routeOf),
    putRoute(row) {
      db.run(
        `INSERT INTO route (domain, bucket, zone_id, record_id, state, reason, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(domain) DO UPDATE SET bucket = excluded.bucket,
           zone_id = excluded.zone_id, record_id = excluded.record_id,
           state = excluded.state, reason = excluded.reason,
           updated = excluded.updated`,
        [
          row.domain,
          row.bucket,
          row.zoneId,
          row.recordId,
          row.state,
          row.reason,
          row.updated,
        ],
      );
    },
    deleteRoute(domain) {
      db.run("DELETE FROM route WHERE domain = ?", [domain]);
    },

    close() {
      db.close();
    },
  };
}
