/**
 * THE CLOUDFLARE ROW — a bucket's name, made real.
 *
 * ## What it owns
 *
 * One tunnel per server, the routes it carries, the proxied DNS records, and
 * the `cloudflared` process that connects them. It REACTS: the cache row
 * publishes which buckets have a domain (`BucketDomains`), and this row makes
 * the tunnel match. It never reads the cache's database or calls the cache's
 * verbs, and the cache never learns this row exists.
 *
 * ## Two things are desired, not one
 *
 * A bucket's domain is the reason the row exists, but the SERVER's own public
 * origin rides the same tunnel when its host is in a zone this token can edit —
 * that is what lets the board, `/mcp` and the websocket reach Cloudflare and
 * retires a Tailscale Funnel. A route whose `bucket` is null is that origin.
 *
 * ## A REFUSAL IS NOT AN OUTAGE
 *
 * An inactive token or a missing permission refuses the row at mount, naming
 * what Cloudflare said — the operator asked for this and can fix it. An
 * UNREACHABLE API (network, 5xx, rate limit) mounts the row with the tunnel
 * `failed: <reason>` and retries with backoff: a Cloudflare incident must not
 * stop the board, the runs or the cache. The first reconcile therefore runs
 * after the mount, never on `apply`'s path.
 *
 * ## The connector and the database are acquired under the activation
 *
 * `open()` acquires the database; the row registers `close()` immediately
 * after it, before it mounts. `close()` waits for the reconcile in flight, for
 * every probe, and for the child's exit — a `cloudflared` that outlived its row
 * would be an orphan holding the tunnel token, and a restart would run two.
 */

import type { Row } from "@odu/cordis/services";
import { CLOUDFLARE_ROW } from "./surface";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { Effect } from "effect";
import { definePlugin } from "@olai/effect-cordis";
import type { ImplementSurfaceDeps } from "@kolu/surface/server";
import { inMemoryStore } from "@kolu/surface/server";
import type { Logger } from "@kolu/surface-daemon";
import {
  BoundOrigin,
  Bundle,
  BucketDomains,
  Log,
  PublicOrigin,
  StateDir,
  type BucketDomains as BucketDomainFacts,
} from "@odu/cordis/services";
import {
  openCloudflareRepo,
  type CloudflareRepo,
  type RouteRow,
  type TunnelRow,
} from "./db";
import {
  cloudflareApi,
  isRefusal,
  type CloudflareApi,
  type IngressRule,
  type ZoneRef,
} from "./api";
import {
  CLOUDFLARE_KEY,
  CloudflareRefused,
  OFF_TUNNEL,
  oduCloudflareSurface,
  type CloudflareRoute,
  type CloudflareStatus,
  type CloudflareTunnel,
} from "./surface";
import { readCloudflareConfig } from "./config";

type CloudflareSpec = (typeof oduCloudflareSurface)["spec"];
export type CloudflareSurfaceDeps = ImplementSurfaceDeps<CloudflareSpec>;

/** The connector's binary and the knobs a suite turns down. */
export interface CloudflareRowConfig {
  readonly token: string;
  /** The API's base URL (`…/client/v4`). */
  readonly apiBase?: string;
  /** `cloudflared` on PATH, or an absolute path (the suite's stub). */
  readonly cloudflared?: string;
  /** Confirm a name through this base instead of `https://<name>`: a proxy a
   *  deployment's names resolve behind, and the browser suite's stub. */
  readonly probeBase?: string;
  /** Do the names answer? Defaults to a real `fetch` of the https URL. */
  readonly probe?: (url: string, signal?: AbortSignal) => Promise<boolean>;
  readonly probeAttempts?: number;
  readonly probeIntervalMs?: number;
}

export interface CloudflareServerOptions {
  readonly config: CloudflareRowConfig;
  readonly stateRoot: string;
  /** Where cloudflared forwards: the daemon's bound origin. */
  readonly localOrigin: string;
  /** `ODU_PUBLIC_ORIGIN`'s hostname, or null; routed when its zone is editable. */
  readonly publicHost: string | null;
  readonly domains: BucketDomainFacts;
  readonly log: Logger;
  readonly now?: () => number;
  readonly api?: CloudflareApi;
}

/** The sibling's publishing half, once the row is mounted. */
export interface CloudflarePublisher {
  readonly tunnel: (row: CloudflareTunnel) => void;
  readonly routes: {
    upsert(key: string, row: CloudflareRoute): void;
    remove(key: string): void;
  };
}

export interface CloudflareServer {
  readonly surface: typeof oduCloudflareSurface;
  readonly deps: CloudflareSurfaceDeps;
  /** Acquire the database. Call once, then register `close()` beside it. */
  open(): void;
  attach(publisher: CloudflarePublisher): void;
  /** Verify the token. A REFUSAL throws (the row fails); an outage resolves
   *  with the tunnel failed and a retry scheduled. */
  start(): Promise<void>;
  status(): CloudflareStatus;
  reconcile(): Promise<void>;
  close(): Promise<void>;
}

const PROBE_ATTEMPTS = 20;
const PROBE_INTERVAL_MS = 2_000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

const signalOf = (signal: AbortSignal | undefined): AbortSignal =>
  signal === undefined
    ? AbortSignal.timeout(10_000)
    : AbortSignal.any([AbortSignal.timeout(10_000), signal]);

const defaultProbe = async (url: string, signal?: AbortSignal): Promise<boolean> => {
  try {
    const response = await fetch(url, { signal: signalOf(signal) });
    return response.ok;
  } catch {
    return false;
  }
};

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function cloudflareServer(options: CloudflareServerOptions): CloudflareServer {
  const { config, domains, log } = options;
  const now = options.now ?? (() => Date.now());
  const api =
    options.api ??
    cloudflareApi({
      token: config.token,
      ...(config.apiBase === undefined ? {} : { base: config.apiBase }),
    });
  const probe =
    config.probe ??
    (config.probeBase === undefined
      ? defaultProbe
      : async (url: string, signal?: AbortSignal): Promise<boolean> => {
          try {
            const path = new URL(url).pathname;
            const response = await fetch(`${config.probeBase}${path}`, {
              signal: signalOf(signal),
            });
            return response.ok;
          } catch {
            return false;
          }
        });
  const attempts = config.probeAttempts ?? PROBE_ATTEMPTS;
  const interval = config.probeIntervalMs ?? PROBE_INTERVAL_MS;
  const cloudflared = config.cloudflared ?? "cloudflared";

  let repo: CloudflareRepo | null = null;
  const db = (): CloudflareRepo => {
    if (repo === null) throw new Error("odu cloudflare: the row was not opened");
    return repo;
  };

  const tunnelStore = inMemoryStore<CloudflareTunnel>(OFF_TUNNEL);
  /** The read model the surface serves. */
  const routeRows = new Map<string, CloudflareRoute>();
  /** What was last handed to the publisher, so a publish is a DIFF. */
  const publishedTunnel = { encoded: "" };
  const publishedRoutes = new Map<string, string>();
  let publisher: CloudflarePublisher | null = null;

  let started = false;
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let work: Promise<void> = Promise.resolve();
  /** A generation per domain: a probe or a wiring pass from an older value must
   *  not overwrite the one that replaced it. */
  const generations = new Map<string, number>();
  const confirmations = new Set<Promise<void>>();
  const stopProbes = new AbortController();
  let connector: {
    child: ChildProcess;
    stopping: boolean;
    last: string;
    exited: Promise<void>;
    resolveExit: () => void;
  } | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = RETRY_MIN_MS;

  function setTunnel(next: CloudflareTunnel): void {
    if (closed) return;
    const current = tunnelStore.get();
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    tunnelStore.set(next);
    publish();
  }

  function tunnelReading(): CloudflareTunnel {
    const row = repo?.tunnel() ?? null;
    return {
      state: tunnelStore.get().state,
      name: row?.name ?? null,
      id: row?.tunnelId ?? null,
      reason: tunnelStore.get().reason,
    };
  }

  function readingOf(row: RouteRow): CloudflareRoute {
    return {
      domain: row.domain,
      bucket: row.bucket,
      state: row.state,
      reason: row.reason,
      updated: row.updated,
    };
  }

  function putRoute(row: RouteRow): void {
    if (closed) return;
    db().putRoute(row);
    routeRows.set(row.domain, readingOf(row));
    publish();
  }

  function dropRoute(domain: string): void {
    if (closed) return;
    db().deleteRoute(domain);
    routeRows.delete(domain);
    publish();
  }

  function publish(): void {
    if (closed || publisher === null) return;
    const tunnel = tunnelReading();
    const encoded = JSON.stringify(tunnel);
    if (publishedTunnel.encoded !== encoded) {
      publishedTunnel.encoded = encoded;
      publisher.tunnel(tunnel);
    }
    const next = new Map<string, string>();
    for (const [domain, row] of routeRows) {
      const rowEncoded = JSON.stringify(row);
      next.set(domain, rowEncoded);
      if (publishedRoutes.get(domain) === rowEncoded) continue;
      publishedRoutes.set(domain, rowEncoded);
      publisher.routes.upsert(domain, row);
    }
    for (const domain of [...publishedRoutes.keys()]) {
      if (next.has(domain)) continue;
      publishedRoutes.delete(domain);
      publisher.routes.remove(domain);
    }
  }

  /** Bump the domain's generation and answer the new one. */
  function supersede(domain: string): number {
    const next = (generations.get(domain) ?? 0) + 1;
    generations.set(domain, next);
    return next;
  }

  const current = (domain: string): number => generations.get(domain) ?? 0;

  // ── the connector ────────────────────────────────────────────────────────

  function connect(tunnel: TunnelRow): void {
    if (closed) return;
    if (connector !== null && !connector.stopping) return;
    setTunnel({ state: "running", name: tunnel.name, id: tunnel.tunnelId, reason: null });
    // THE TOKEN IS NOT ON ARGV. `cloudflared` reads `TUNNEL_TOKEN` from the
    // environment; a `--token` argument is visible to every local `ps`.
    const child = spawn(cloudflared, ["tunnel", "--no-autoupdate", "run"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TUNNEL_TOKEN: tunnel.token },
    });
    const { promise: exited, resolve: resolveExit } = Promise.withResolvers<void>();
    const held = { child, stopping: false, last: "", exited, resolveExit };
    connector = held;
    let pending = "";
    const readLine = (chunk: Buffer): string[] => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      return lines;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of readLine(chunk)) {
        if (/Registered tunnel connection|Connection .* registered/i.test(line)) {
          setTunnel({ state: "connected", name: tunnel.name, id: tunnel.tunnelId, reason: null });
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of readLine(chunk)) {
        if (line.trim() !== "") held.last = line.trim();
      }
    });
    child.on("error", (err) => {
      if (connector !== held) return;
      connector = null;
      resolveExit();
      setTunnel({
        state: "failed",
        name: tunnel.name,
        id: tunnel.tunnelId,
        reason: `cloudflared could not start: ${err.message}`,
      });
    });
    child.on("exit", (code) => {
      resolveExit();
      if (connector !== held) return;
      connector = null;
      if (held.stopping) {
        setTunnel({ state: "stopped", name: tunnel.name, id: tunnel.tunnelId, reason: null });
        return;
      }
      setTunnel({
        state: "failed",
        name: tunnel.name,
        id: tunnel.tunnelId,
        reason:
          `cloudflared exited ${code ?? "on a signal"}` +
          (held.last === "" ? "" : `: ${held.last}`),
      });
    });
  }

  /** Stop the connector and WAIT for the child: the row's release is not
   *  finished while a process it started still holds the tunnel token. */
  async function stopConnector(): Promise<void> {
    const held = connector;
    if (held === null) {
      setTunnel({ state: "stopped", name: tunnelReading().name, id: tunnelReading().id, reason: null });
      return;
    }
    held.stopping = true;
    held.child.kill("SIGTERM");
    const killer = setTimeout(() => held.child.kill("SIGKILL"), 3_000);
    killer.unref?.();
    await held.exited;
    clearTimeout(killer);
    if (connector === held) connector = null;
    if (!closed) {
      setTunnel({ state: "stopped", name: tunnelReading().name, id: tunnelReading().id, reason: null });
    }
  }

  // ── confirming a name ────────────────────────────────────────────────────

  function probeUrl(domain: string, bucket: string | null): string {
    return `https://${domain}${bucket === null ? "/_odu/door" : "/nix-cache-info"}`;
  }

  /** Wait for the name to answer, then say `live` — or `failed` with the URL
   *  that did not answer. Runs off the reconcile's clock, but every write is
   *  checked against the domain's generation. */
  async function confirm(domain: string, bucket: string | null): Promise<void> {
    const generation = supersede(domain);
    const url = probeUrl(domain, bucket);
    for (let attempt = 0; attempt < attempts; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
      if (closed || current(domain) !== generation) return;
      if (await probe(url, stopProbes.signal)) {
        if (closed || current(domain) !== generation) return;
        const row = db().route(domain);
        if (row === null) return;
        putRoute({ ...row, bucket, state: "live", reason: null, updated: now() });
        return;
      }
    }
    if (closed || current(domain) !== generation) return;
    const row = db().route(domain);
    if (row === null) return;
    putRoute({ ...row, state: "failed", reason: `${url} did not answer`, updated: now() });
  }

  function startConfirm(domain: string, bucket: string | null): void {
    const running = confirm(domain, bucket).finally(() => {
      confirmations.delete(running);
    });
    confirmations.add(running);
  }

  // ── unwiring ─────────────────────────────────────────────────────────────

  async function unwire(row: RouteRow, tunnel: TunnelRow | null): Promise<void> {
    supersede(row.domain);
    if (row.recordId !== "" && tunnel !== null) {
      try {
        await api.deleteRecord(row.zoneId, row.recordId, tunnel.tunnelId);
      } catch (err) {
        log.warn(
          { domain: row.domain, error: messageOf(err) },
          "odu cloudflare: left a DNS record alone; dropping the route anyway",
        );
      }
    }
    dropRoute(row.domain);
  }

  // ── reconciliation ───────────────────────────────────────────────────────

  /** An API call failed while wiring: mark one route failed, and schedule a
   *  retry when the API (not the request) was the problem. */
  function failFrom(domain: string, bucket: string | null, err: unknown): void {
    fail(domain, bucket, messageOf(err));
    if (!isRefusal(err)) scheduleRetry();
  }

  async function reconcileNow(): Promise<void> {
    if (closed) return;
    /** What SHOULD be routed: the cache's names, plus the server's if its host
     *  is in an editable zone. */
    const desired = new Map<string, string | null>();
    for (const fact of domains.current()) desired.set(fact.domain, fact.bucket);

    let publicZone: ZoneRef | null = null;
    if (options.publicHost !== null) {
      try {
        publicZone = await api.zoneFor(options.publicHost);
      } catch (err) {
        log.warn(
          { host: options.publicHost, error: messageOf(err) },
          "odu cloudflare: could not ask which zone the public origin is in",
        );
        if (!isRefusal(err)) scheduleRetry();
      }
      if (closed) return;
      if (publicZone !== null) desired.set(options.publicHost, null);
    }

    // A name that is no longer wanted loses its record — before anything new is
    // made, so the tunnel config is the state it is about to be.
    const tunnelBefore = repo?.tunnel() ?? null;
    for (const row of db().routes()) {
      if (closed) return;
      if (desired.has(row.domain)) continue;
      await unwire(row, tunnelBefore);
    }
    if (closed) return;

    if (desired.size === 0) {
      await stopConnector();
      publish();
      return;
    }

    const zones = new Map<string, ZoneRef>();
    for (const [domain, bucket] of desired) {
      if (closed) return;
      const known = domain === options.publicHost ? publicZone : null;
      if (known !== null) {
        zones.set(domain, known);
        continue;
      }
      try {
        const zone = await api.zoneFor(domain);
        if (zone === null) {
          fail(
            domain,
            bucket,
            `no Cloudflare zone this token can edit contains ${domain}`,
          );
          continue;
        }
        zones.set(domain, zone);
      } catch (err) {
        failFrom(domain, bucket, err);
      }
    }
    if (closed) return;
    if (zones.size === 0) {
      await stopConnector();
      publish();
      return;
    }

    // ONE TUNNEL. Its account is the account of the first editable zone; a name
    // in another account cannot ride it, and saying so is better than a route
    // that silently never appears.
    const first = zones.values().next().value as ZoneRef;
    let tunnel = db().tunnel();
    if (tunnel === null) {
      try {
        const name = `odu ${options.publicHost ?? hostOf(options.localOrigin)}`;
        const created = await api.createTunnel(first.accountId, name);
        tunnel = {
          tunnelId: created.id,
          name,
          token: created.token,
          accountId: first.accountId,
          created: now(),
        };
        db().putTunnel(tunnel);
      } catch (err) {
        for (const [domain, bucket] of desired) failFrom(domain, bucket, err);
        publish();
        return;
      }
    }
    if (closed) return;

    for (const [domain, bucket] of desired) {
      if (closed) return;
      const zone = zones.get(domain);
      if (zone === undefined) continue;
      if (zone.accountId !== tunnel.accountId) {
        fail(
          domain,
          bucket,
          `the name is in account ${zone.accountId}, but this server's tunnel is in ${tunnel.accountId}`,
        );
        continue;
      }
      // THE TUNNEL CONFIG IS ONE DOCUMENT: every name it carries, in one PUT.
      const ingress: IngressRule[] = [...zones.keys()]
        .filter((one) => (zones.get(one) as ZoneRef).accountId === tunnel.accountId)
        .sort()
        .map((hostname) => ({ hostname, service: options.localOrigin }));
      ingress.push({ service: "http_status:404" });
      try {
        await api.putTunnelConfig(tunnel.accountId, tunnel.tunnelId, ingress);
      } catch (err) {
        failFrom(domain, bucket, err);
        continue;
      }
      if (closed) return;
      try {
        const existing = db().route(domain);
        const recordId = await api.ensureRecord(
          zone.zoneId,
          domain,
          tunnel.tunnelId,
          existing === null || existing.recordId === "" ? null : existing.recordId,
        );
        putRoute({
          domain,
          bucket,
          zoneId: zone.zoneId,
          recordId,
          state: existing?.state === "live" ? "live" : "wiring",
          reason: null,
          updated: now(),
        });
      } catch (err) {
        failFrom(domain, bucket, err);
      }
    }
    if (closed) return;

    if (db().routes().length > 0) {
      connect(tunnel);
      for (const row of db().routes()) {
        if (closed) return;
        // ONLY A WIRING NAME IS CONFIRMED. A route that failed for a reason
        // (a foreign record, a zone the token cannot see) may still ANSWER if
        // something else owns the name — probing it would overwrite the reason
        // with a `live` that is not this row's.
        if (row.state === "wiring") startConfirm(row.domain, row.bucket);
      }
    } else {
      await stopConnector();
    }
    publish();
  }

  function fail(domain: string, bucket: string | null, reason: string): void {
    if (closed) return;
    supersede(domain);
    const existing = db().route(domain);
    putRoute({
      domain,
      bucket,
      zoneId: existing?.zoneId ?? "",
      recordId: existing?.recordId ?? "",
      state: "failed",
      reason,
      updated: now(),
    });
  }

  function reconcile(): Promise<void> {
    const next = work.then(
      () => reconcileNow(),
      () => reconcileNow(),
    );
    work = next.catch((err: unknown) => {
      log.warn(
        { error: messageOf(err) },
        "odu cloudflare: reconciliation failed",
      );
      scheduleRetry();
    });
    return work;
  }

  /** Retry the API after an outage. Backs off, stops with the row, and never
   *  schedules twice. */
  function scheduleRetry(): void {
    if (closed || retryTimer !== null) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void (async () => {
        if (closed) return;
        try {
          await api.verify();
          if (closed) return;
          retryDelay = RETRY_MIN_MS;
          setTunnel({ ...tunnelReading(), state: "stopped", reason: null });
          await reconcile();
        } catch (err) {
          setTunnel({
            ...tunnelReading(),
            state: "failed",
            reason: messageOf(err),
          });
          if (isRefusal(err)) return;
          scheduleRetry();
        }
      })();
    }, delay);
    retryTimer.unref?.();
  }

  const deps: CloudflareSurfaceDeps = {
    cells: {
      tunnel: { store: tunnelStore },
    },
    collections: {
      routes: {
        readAll: () => routeRows,
        upsert: (key, row) => {
          routeRows.set(key, row);
        },
        remove: (key) => {
          routeRows.delete(key);
        },
      },
    },
    procedures: {
      status: {
        read: () => Effect.succeed(status()),
      },
    },
  };

  function status(): CloudflareStatus {
    if (closed) return { tunnel: OFF_TUNNEL, routes: [] };
    return { tunnel: tunnelReading(), routes: db().routes().map(readingOf) };
  }

  return {
    surface: oduCloudflareSurface,
    deps,
    open() {
      if (repo !== null) return;
      repo = openCloudflareRepo(join(options.stateRoot, "cloudflare", "cloudflare.sqlite"));
      for (const row of repo.routes()) routeRows.set(row.domain, readingOf(row));
    },
    attach(next) {
      publisher = next;
      publish();
    },
    async start() {
      if (started) return;
      try {
        await api.verify();
      } catch (err) {
        if (isRefusal(err)) throw err;
        setTunnel({ state: "failed", name: null, id: null, reason: messageOf(err) });
        scheduleRetry();
      }
      started = true;
      unsubscribe = domains.subscribe(() => void reconcile());
      // AFTER THE MOUNT AND OFF THE APPLY PATH: the row is served while the
      // first reconciliation runs.
      void reconcile();
    },
    status,
    reconcile,
    async close() {
      if (closed) return;
      closed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      unsubscribe?.();
      unsubscribe = null;
      stopProbes.abort();
      // A reconcile already awaiting an API call must not spawn a connector on
      // a row that is leaving; `closed` is checked after every await, and this
      // join is the last one before the database closes.
      await work.catch(() => {});
      await Promise.allSettled([...confirmations]);
      await stopConnector();
      repo?.close();
      repo = null;
    },
  };
}

/** `http://127.0.0.1:18440` → `127.0.0.1:18440`, for a tunnel name. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** The row as a plugin — mounted by the host only when the token file is set.
 *
 *  THE ORDER IS THE LIFETIME: open the database, register its release, mount,
 *  register the mount's drop, and only then start. A refusal from `start`
 *  unwinds through both finalizers; an outage does not throw at all. */
export const cloudflareRow = (config: CloudflareRowConfig) =>
  definePlugin({
    name: CLOUDFLARE_KEY,
    needs: [Bundle, StateDir, BoundOrigin, PublicOrigin, BucketDomains, Log],
    apply: Effect.gen(function* () {
      const bundle = yield* Bundle;
      const stateDir = yield* StateDir;
      const bound = yield* BoundOrigin;
      const publicOrigin = yield* PublicOrigin;
      const domains: BucketDomainFacts = yield* BucketDomains;
      const log = yield* Log;

      const server = cloudflareServer({
        config,
        stateRoot: stateDir,
        localOrigin: bound,
        publicHost: publicOrigin === null ? null : hostOnly(publicOrigin),
        domains,
        log,
      });

      // ACQUIRE, THEN ARRANGE THE RELEASE — in the same step, before anything
      // else can fail and leak it.
      server.open();
      yield* Effect.addFinalizer(() => Effect.promise(() => server.close()));

      const mounted = bundle.mount(CLOUDFLARE_KEY, server.surface, server.deps);
      server.attach({
        tunnel: (row) => mounted.ctx.cells.tunnel.set(row),
        routes: {
          upsert: (key, row) => mounted.ctx.collections.routes.upsert(key, row),
          remove: (key) => mounted.ctx.collections.routes.remove(key),
        },
      });
      yield* Effect.addFinalizer(() => Effect.promise(() => mounted.drop()));

      // THE TOKEN BEFORE SERVING: a refusal fails the row; an outage marks the
      // tunnel failed and retries.
      yield* Effect.promise(() => server.start());

      log.info(
        { localOrigin: bound, publicHost: publicOrigin },
        "odu cloudflare: the tunnel row is serving",
      );
    }),
  });

/** `https://board.example.org` → `board.example.org`: Cloudflare names hosts. */
function hostOnly(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return origin.toLowerCase();
  }
}

/** Re-exported for the host: the row's ONE environment read. */
export { readCloudflareConfig };

/**
 * THIS ROW, AS THE HOST LISTS IT — the tunnel, when the host read a token file.
 * Its own facts (`CLOUDFLARE_ROW`, beside its surface) and its plugin, in one
 * value. The host composes these records and names none of their parts.
 */
export const cloudflareRowRecord = (config: CloudflareRowConfig): Row => ({
  ...CLOUDFLARE_ROW,
  plugin: cloudflareRow(config),
});
