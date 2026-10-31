/**
 * THE CLOUDFLARE ROW — a bucket's name, made real.
 *
 * ## What it owns
 *
 * One tunnel per server, the routes it carries, the proxied DNS records, and
 * the `cloudflared` process that connects them. It REACTS: the cache row
 * publishes which buckets have a domain (`CacheDomains`), and this row makes
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
 * ## The connector is a child, and its state is the row's fact
 *
 * `cloudflared` is spawned the way the cache spawns `nix`: a long-lived child
 * whose stdout is the connection state ("Registered tunnel connection"), whose
 * exit is a failure with its last words, and whose lifetime is this activation.
 * No name needs a tunnel means no connector — `stopped`, not a process idling
 * for a route nobody asked for.
 */

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
import { openCloudflareRepo, type RouteRow, type TunnelRow } from "./db";
import { cloudflareApi, type CloudflareApi, type IngressRule, type ZoneRef } from "./api";
import {
  CLOUDFLARE_KEY,
  CloudflareRefused,
  OFF_TUNNEL,
  oduCloudflareSurface,
  type CloudflareRoute,
  type CloudflareStatus,
  type CloudflareTunnel,
} from "./surface";

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
  readonly probe?: (url: string) => Promise<boolean>;
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
  attach(publisher: CloudflarePublisher): void;
  /** Verify the token, subscribe to the cache's domains, and reconcile once.
   *  Throws when the token is refused — the row then fails at mount. */
  start(): Promise<void>;
  status(): CloudflareStatus;
  reconcile(): Promise<void>;
  close(): Promise<void>;
}

const PROBE_ATTEMPTS = 20;
const PROBE_INTERVAL_MS = 2_000;

const defaultProbe = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return response.ok;
  } catch {
    return false;
  }
};

export function cloudflareServer(options: CloudflareServerOptions): CloudflareServer {
  const { config, domains, log } = options;
  const now = options.now ?? (() => Date.now());
  const api =
    options.api ??
    cloudflareApi({ token: config.token, ...(config.apiBase === undefined ? {} : { base: config.apiBase }) });
  const probe =
    config.probe ??
    (config.probeBase === undefined
      ? defaultProbe
      : async (url: string): Promise<boolean> => {
          try {
            const path = new URL(url).pathname;
            const response = await fetch(`${config.probeBase}${path}`, {
              signal: AbortSignal.timeout(10_000),
            });
            return response.ok;
          } catch {
            return false;
          }
        });
  const attempts = config.probeAttempts ?? PROBE_ATTEMPTS;
  const interval = config.probeIntervalMs ?? PROBE_INTERVAL_MS;
  const cloudflared = config.cloudflared ?? "cloudflared";

  const repo = openCloudflareRepo(join(options.stateRoot, "cloudflare", "cloudflare.sqlite"));
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
  let connector: {
    child: ChildProcess;
    stopping: boolean;
    last: string;
  } | null = null;

  function setTunnel(next: CloudflareTunnel): void {
    const current = tunnelStore.get();
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    tunnelStore.set(next);
    publish();
  }

  function tunnelReading(): CloudflareTunnel {
    const row = repo.tunnel();
    const connectorState = tunnelStore.get().state;
    return {
      state: connectorState,
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
    repo.putRoute(row);
    const reading = readingOf(row);
    routeRows.set(row.domain, reading);
    publish();
  }

  function dropRoute(domain: string): void {
    repo.deleteRoute(domain);
    routeRows.delete(domain);
    publish();
  }

  function publish(): void {
    if (publisher === null) return;
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
    if (connector !== null && !connector.stopping) return;
    setTunnel({ state: "running", name: tunnel.name, id: tunnel.tunnelId, reason: null });
    const child = spawn(cloudflared, ["tunnel", "--no-autoupdate", "run", "--token", tunnel.token], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const held = { child, stopping: false, last: "" };
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
      setTunnel({
        state: "failed",
        name: tunnel.name,
        id: tunnel.tunnelId,
        reason: `cloudflared could not start: ${err.message}`,
      });
    });
    child.on("exit", (code) => {
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

  function stopConnector(): void {
    if (connector === null) {
      setTunnel({ state: "stopped", name: tunnelReading().name, id: tunnelReading().id, reason: null });
      return;
    }
    const held = connector;
    held.stopping = true;
    held.child.kill("SIGTERM");
    // A connector that ignores SIGTERM is not a reason to hang the shutdown;
    // the exit handler still runs and keeps a failed state if it dies badly.
    setTimeout(() => {
      if (connector === held) held.child.kill("SIGKILL");
    }, 3_000).unref();
    setTunnel({ state: "stopped", name: tunnelReading().name, id: tunnelReading().id, reason: null });
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
      if (await probe(url)) {
        if (closed || current(domain) !== generation) return;
        putRoute({
          domain,
          bucket,
          zoneId: repo.route(domain)?.zoneId ?? "",
          recordId: repo.route(domain)?.recordId ?? "",
          state: "live",
          reason: null,
          updated: now(),
        });
        return;
      }
    }
    if (closed || current(domain) !== generation) return;
    const row = repo.route(domain);
    if (row === null) return;
    putRoute({ ...row, state: "failed", reason: `${url} did not answer`, updated: now() });
  }

  // ── unwiring ─────────────────────────────────────────────────────────────

  async function unwire(row: RouteRow): Promise<void> {
    supersede(row.domain);
    if (row.recordId !== "") {
      try {
        await api.deleteRecord(row.zoneId, row.recordId);
      } catch (err) {
        log.warn(
          { domain: row.domain, error: err instanceof Error ? err.message : String(err) },
          "odu cloudflare: could not remove a DNS record; dropping the row anyway",
        );
      }
    }
    dropRoute(row.domain);
  }

  // ── reconciliation ───────────────────────────────────────────────────────

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
          { host: options.publicHost, error: err instanceof Error ? err.message : String(err) },
          "odu cloudflare: could not ask which zone the public origin is in",
        );
      }
      if (publicZone !== null) desired.set(options.publicHost, null);
    }

    // A name that is no longer wanted loses its record — before anything new is
    // made, so the tunnel config is the state it is about to be.
    for (const row of repo.routes()) {
      if (desired.has(row.domain)) continue;
      await unwire(row);
    }

    if (desired.size === 0) {
      stopConnector();
      publish();
      return;
    }

    const zones = new Map<string, ZoneRef>();
    for (const [domain] of desired) {
      const known = domain === options.publicHost ? publicZone : null;
      if (known !== null) {
        zones.set(domain, known);
        continue;
      }
      try {
        const zone = await api.zoneFor(domain);
        if (zone === null) {
          fail(domain, desired.get(domain) ?? null, `no Cloudflare zone this token can edit contains ${domain}`);
          continue;
        }
        zones.set(domain, zone);
      } catch (err) {
        fail(domain, desired.get(domain) ?? null, err instanceof Error ? err.message : String(err));
      }
    }
    if (zones.size === 0) {
      stopConnector();
      publish();
      return;
    }

    // ONE TUNNEL. Its account is the account of the first editable zone; a name
    // in another account cannot ride it, and saying so is better than a route
    // that silently never appears.
    const first = zones.values().next().value as ZoneRef;
    let tunnel = repo.tunnel();
    if (tunnel === null) {
      try {
        const created = await api.createTunnel(
          first.accountId,
          `odu ${options.publicHost ?? hostOf(options.localOrigin)}`,
        );
        tunnel = {
          tunnelId: created.id,
          name: `odu ${options.publicHost ?? hostOf(options.localOrigin)}`,
          token: created.token,
          accountId: first.accountId,
          created: now(),
        };
        repo.putTunnel(tunnel);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        for (const [domain, bucket] of desired) fail(domain, bucket, reason);
        publish();
        return;
      }
    }

    for (const [domain, bucket] of desired) {
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
        fail(domain, bucket, err instanceof Error ? err.message : String(err));
        continue;
      }
      try {
        const existing = repo.route(domain);
        const recordId = await api.ensureRecord(zone.zoneId, domain, tunnel.tunnelId);
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
        fail(domain, bucket, err instanceof Error ? err.message : String(err));
      }
    }

    if (repo.routes().length > 0) {
      connect(tunnel);
      for (const row of repo.routes()) {
        if (row.state !== "live") void confirm(row.domain, row.bucket);
      }
    } else {
      stopConnector();
    }
    publish();
  }

  function fail(domain: string, bucket: string | null, reason: string): void {
    supersede(domain);
    const existing = repo.route(domain);
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
        { error: err instanceof Error ? err.message : String(err) },
        "odu cloudflare: reconciliation failed",
      );
    });
    return work;
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
    return { tunnel: tunnelReading(), routes: repo.routes().map(readingOf) };
  }

  return {
    surface: oduCloudflareSurface,
    deps,
    attach(next) {
      publisher = next;
      // Seed the read model from what the row already made, so a page opening
      // before the next reconcile sees the last state rather than an empty one.
      for (const row of repo.routes()) routeRows.set(row.domain, readingOf(row));
      publish();
    },
    async start() {
      if (started) return;
      // THE TOKEN IS CHECKED AT MOUNT. A daemon that cannot reach Cloudflare
      // should refuse this row rather than serve a page that says `wiring` for
      // ever; the host's refusal names the row and this sentence.
      await api.verify();
      started = true;
      unsubscribe = domains.subscribe(() => void reconcile());
      await reconcile();
    },
    status,
    reconcile,
    async close() {
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      stopConnector();
      repo.close();
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

/** The row as a plugin — mounted by the host only when the token file is set. */
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

      // THE TOKEN BEFORE THE MOUNT: a refused token fails the activation, and a
      // failed row is a daemon that refuses to serve half a surface rather than
      // one with a tunnel panel that never moves.
      yield* Effect.promise(() => server.start());

      const mounted = bundle.mount(CLOUDFLARE_KEY, server.surface, server.deps);
      server.attach({
        tunnel: (row) => mounted.ctx.cells.tunnel.set(row),
        routes: {
          upsert: (key, row) => mounted.ctx.collections.routes.upsert(key, row),
          remove: (key) => mounted.ctx.collections.routes.remove(key),
        },
      });

      // Reverse order: the mount goes, THEN the connector and the database. A
      // publish into a dropped mount would be the cache row's old bug.
      yield* Effect.addFinalizer(() => Effect.promise(() => server.close()));
      yield* Effect.addFinalizer(() => Effect.promise(() => mounted.drop()));

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
