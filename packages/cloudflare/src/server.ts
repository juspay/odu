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
  CachePurge,
  Log,
  PublicOrigin,
  StateDir,
  type BucketDomains as BucketDomainFacts,
} from "@odu/cordis/services";
import {
  bucketColumn,
  openCloudflareRepo,
  type CloudflareRepo,
  type RouteRow,
  type RouteTarget,
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

export interface CloudflareRowConfig {
  readonly token: string;
  readonly apiBase?: string;
  readonly cloudflared?: string;
  readonly probeBase?: string;
  readonly probe?: (url: string, signal?: AbortSignal) => Promise<boolean>;
  readonly probeAttempts?: number;
  readonly probeIntervalMs?: number;
}

export interface CloudflareServerOptions {
  readonly config: CloudflareRowConfig;
  readonly stateRoot: string;
  readonly localOrigin: string;
  readonly publicHost: string | null;
  readonly domains: BucketDomainFacts;
  readonly log: Logger;
  readonly now?: () => number;
  readonly api?: CloudflareApi;
}

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
  open(): void;
  attach(publisher: CloudflarePublisher): void;
  start(): Promise<void>;
  status(): CloudflareStatus;
  reconcile(): Promise<void>;
  purge(urls: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

const PROBE_ATTEMPTS = 20;
const PROBE_INTERVAL_MS = 2_000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;
/** Cloudflare takes at most thirty files in one `purge_cache` call. */
const PURGE_FILES = 30;

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

interface RouteEpoch {
  stale(): boolean;
  put(row: RouteRow): void;
}

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
  const routeRows = new Map<string, CloudflareRoute>();
  const publishedTunnel = { encoded: "" };
  const publishedRoutes = new Map<string, string>();
  let publisher: CloudflarePublisher | null = null;

  let started = false;
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let work: Promise<void> = Promise.resolve();
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
      bucket: bucketColumn(row.bucket),
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

  function supersede(domain: string): RouteEpoch {
    const mine = (generations.get(domain) ?? 0) + 1;
    generations.set(domain, mine);
    const mineStill = (): boolean => (generations.get(domain) ?? 0) === mine;
    return {
      stale: () => !mineStill(),
      put: (row) => {
        if (!mineStill()) return;
        putRoute(row);
      },
    };
  }

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

  async function stopConnectorAndAwaitExit(): Promise<void> {
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

  function probeUrl(domain: string, bucket: RouteTarget): string {
    return `https://${domain}${bucket.kind === "server" ? "/_odu/door" : "/nix-cache-info"}`;
  }

  async function confirm(domain: string, bucket: RouteTarget): Promise<void> {
    const epoch = supersede(domain);
    const url = probeUrl(domain, bucket);
    for (let attempt = 0; attempt < attempts; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
      if (closed || epoch.stale()) return;
      if (await probe(url, stopProbes.signal)) {
        const row = db().route(domain);
        if (row === null) return;
        epoch.put({ ...row, bucket, state: "live", reason: null, updated: now() });
        return;
      }
    }
    if (closed) return;
    const row = db().route(domain);
    if (row === null) return;
    epoch.put({ ...row, state: "failed", reason: `${url} did not answer`, updated: now() });
  }

  function startConfirm(domain: string, bucket: RouteTarget): void {
    const running = confirm(domain, bucket).finally(() => {
      confirmations.delete(running);
    });
    confirmations.add(running);
  }

  async function unwire(row: RouteRow, tunnel: TunnelRow | null): Promise<void> {
    supersede(row.domain);
    if (row.recordId !== null && tunnel !== null) {
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

  function byZone(urls: readonly string[]): Map<string, string[]> {
    const zoneOf = new Map<string, string>();
    for (const row of db().routes()) {
      if (row.zoneId !== "") zoneOf.set(row.domain.toLowerCase(), row.zoneId);
    }
    const grouped = new Map<string, string[]>();
    for (const url of urls) {
      let host: string;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        continue;
      }
      const zoneId = zoneOf.get(host);
      if (zoneId === undefined) continue;
      const held = grouped.get(zoneId);
      if (held === undefined) grouped.set(zoneId, [url]);
      else held.push(url);
    }
    return grouped;
  }

  async function purge(urls: readonly string[]): Promise<void> {
    if (closed || repo === null || urls.length === 0) return;
    for (const [zoneId, files] of byZone(urls)) {
      for (let at = 0; at < files.length; at += PURGE_FILES) {
        if (closed) return;
        const batch = files.slice(at, at + PURGE_FILES);
        try {
          await api.purge(zoneId, batch);
        } catch (err) {
          log.warn(
            { zone: zoneId, files: batch.length, error: messageOf(err) },
            "odu cloudflare: the edge still holds URLs a collection deleted",
          );
        }
      }
    }
  }

  function failFrom(domain: string, bucket: RouteTarget, err: unknown): void {
    fail(domain, bucket, messageOf(err));
    if (!isRefusal(err)) scheduleRetry();
  }

  async function reconcileNow(): Promise<void> {
    if (closed) return;
    const desired = new Map<string, RouteTarget>();
    for (const fact of domains.current()) {
      desired.set(fact.domain, { kind: "bucket", name: fact.bucket });
    }

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
      if (publicZone !== null) desired.set(options.publicHost, { kind: "server" });
    }

    const tunnelBefore = repo?.tunnel() ?? null;
    for (const row of db().routes()) {
      if (closed) return;
      if (desired.has(row.domain)) continue;
      await unwire(row, tunnelBefore);
    }
    if (closed) return;

    if (desired.size === 0) {
      await stopConnectorAndAwaitExit();
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
      await stopConnectorAndAwaitExit();
      publish();
      return;
    }

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
          existing?.recordId ?? null,
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
        if (row.state === "wiring") startConfirm(row.domain, row.bucket);
      }
    } else {
      await stopConnectorAndAwaitExit();
    }
    publish();
  }

  function fail(domain: string, bucket: RouteTarget, reason: string): void {
    if (closed) return;
    const epoch = supersede(domain);
    const existing = db().route(domain);
    epoch.put({
      domain,
      bucket,
      zoneId: existing?.zoneId ?? "",
      recordId: existing?.recordId ?? null,
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
      void reconcile();
    },
    status,
    reconcile,
    purge,
    async close() {
      if (closed) return;
      closed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      unsubscribe?.();
      unsubscribe = null;
      stopProbes.abort();
      await work.catch(() => {});
      await Promise.allSettled([...confirmations]);
      await stopConnectorAndAwaitExit();
      repo?.close();
      repo = null;
    },
  };
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export const cloudflareRow = (config: CloudflareRowConfig) =>
  definePlugin({
    name: CLOUDFLARE_KEY,
    needs: [Bundle, StateDir, BoundOrigin, PublicOrigin, BucketDomains, CachePurge, Log],
    apply: Effect.gen(function* () {
      const bundle = yield* Bundle;
      const stateDir = yield* StateDir;
      const bound = yield* BoundOrigin;
      const publicOrigin = yield* PublicOrigin;
      const domains: BucketDomainFacts = yield* BucketDomains;
      const log = yield* Log;
      const purges = yield* CachePurge;

      const server = cloudflareServer({
        config,
        stateRoot: stateDir,
        localOrigin: bound,
        publicHost: publicOrigin === null ? null : hostOnly(publicOrigin),
        domains,
        log,
      });

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

      const withdraw = purges.register((urls) => void server.purge(urls));
      yield* Effect.addFinalizer(() => Effect.sync(withdraw));

      yield* Effect.promise(() => server.start());

      log.info(
        { localOrigin: bound, publicHost: publicOrigin },
        "odu cloudflare: the tunnel row is serving",
      );
    }),
  });

function hostOnly(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return origin.toLowerCase();
  }
}

export { readCloudflareConfig };

export const cloudflareRowRecord = (config: CloudflareRowConfig): Row => ({
  ...CLOUDFLARE_ROW,
  plugin: cloudflareRow(config),
});
