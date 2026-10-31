/**
 * THE TUNNEL ROW, AGAINST A STUB THAT SPEAKS CLOUDFLARE'S ENVELOPE.
 *
 * The API is a server in this process rather than a mock module: what the row
 * sends is the thing the test reads — a tunnel named after this server, ONE of
 * them, an ingress with the names sorted and a 404 terminator, a proxied CNAME
 * per name — so a change to the request shape is a failure here rather than in
 * production. The envelopes (`{success, errors, result}`) and the endpoints are
 * Cloudflare's documented shapes; this is not a recording of a live account,
 * and it says so. `cloudflared` is a real child process (a shell script that
 * says "Registered tunnel connection" and sleeps), because the connector's
 * state is read off stdout and a fake object could not prove that.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { BucketDomainFact, BucketDomains } from "@odu/cordis/services";
import type { Logger } from "@kolu/surface-daemon";
import { cloudflareServer } from "./server";
import type { CloudflareRoute, CloudflareTunnel } from "./surface";

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

interface Stub {
  origin: string;
  seen: Seen[];
  zones: Record<string, { id: string; name: string; account: string }>;
  records: Map<string, { id: string; content: string; proxied: boolean }>;
  /** Records pre-populated before the row starts, keyed by name. */
  preexisting: Map<string, { id: string; content: string }>;
  tunnelCreates: number;
  verifyOk: boolean;
  stop: () => void;
}

let scratch: string;
const worlds: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of worlds.splice(0)) await close();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

function startStub(): Stub {
  const state: Stub = {
    origin: "",
    seen: [],
    zones: { "example.org": { id: "zone-1", name: "example.org", account: "acct-1" } },
    records: new Map(),
    preexisting: new Map(),
    tunnelCreates: 0,
    verifyOk: true,
    stop: () => {},
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined);
      state.seen.push({ method: request.method, path: `${url.pathname}${url.search}`, body });
      const envelope = (result: unknown) =>
        Response.json({ success: true, errors: [], result });
      if (url.pathname === "/user/tokens/verify") {
        return Response.json(
          state.verifyOk
            ? { success: true, errors: [], result: { status: "active" } }
            : {
                success: false,
                errors: [{ code: 1000, message: "Invalid API Token" }],
                result: null,
              },
        );
      }
      if (url.pathname === "/zones" && request.method === "GET") {
        const name = url.searchParams.get("name") ?? "";
        const zone = state.zones[name];
        return envelope(
          zone === undefined
            ? []
            : [{ id: zone.id, name: zone.name, account: { id: zone.account } }],
        );
      }
      if (url.pathname === "/accounts/acct-1/cfd_tunnel" && request.method === "POST") {
        state.tunnelCreates += 1;
        return envelope({ id: "tunnel-1", token: "connector-token" });
      }
      if (url.pathname === "/accounts/acct-1/cfd_tunnel/tunnel-1/configurations") {
        return envelope({});
      }
      if (url.pathname === "/zones/zone-1/dns_records" && request.method === "GET") {
        const name = url.searchParams.get("name") ?? "";
        const record = state.records.get(name) ?? state.preexisting.get(name);
        return envelope(record === undefined ? [] : [{ id: record.id, content: record.content }]);
      }
      if (
        url.pathname.startsWith("/zones/zone-1/dns_records/") &&
        request.method === "GET"
      ) {
        const id = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
        for (const record of [...state.records.values(), ...state.preexisting.values()]) {
          if (record.id === id) return envelope({ id: record.id, content: record.content });
        }
        return new Response("not found", { status: 404 });
      }
      if (url.pathname === "/zones/zone-1/dns_records" && request.method === "POST") {
        const sent = body as { name: string; content: string; proxied: boolean };
        const record = { id: `rec-${state.records.size + 1}`, content: sent.content, proxied: sent.proxied };
        state.records.set(sent.name, record);
        return envelope({ id: record.id });
      }
      if (url.pathname.startsWith("/zones/zone-1/dns_records/") && request.method === "DELETE") {
        const id = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
        for (const [name, record] of state.records) {
          if (record.id === id) state.records.delete(name);
        }
        for (const [name, record] of state.preexisting) {
          if (record.id === id) state.preexisting.delete(name);
        }
        return envelope({ id });
      }
      return new Response("not found", { status: 404 });
    },
  });
  state.origin = `http://127.0.0.1:${server.port}`;
  state.stop = () => server.stop(true);
  return state;
}

/** A `cloudflared` that reports a registered connection, records what it was
 *  given, and leaves a marker when it is stopped. */
function fakeConnector(): { bin: string; markers: string } {
  scratch = mkdtempSync(join(tmpdir(), "odu-cloudflare-"));
  const markers = join(scratch, "markers");
  mkdirSync(markers, { recursive: true });
  const path = join(scratch, "cloudflared");
  writeFileSync(
    path,
    `#!/bin/sh
echo "$@" > ${markers}/args
echo "$TUNNEL_TOKEN" > ${markers}/token
trap 'echo gone > ${markers}/exited; exit 0' TERM
echo "Registered tunnel connection connIndex=0"
while :; do sleep 0.1; done
`,
  );
  spawnSync("chmod", ["+x", path]);
  return { bin: path, markers };
}

function domainsWorld(initial: BucketDomainFact[]): {
  domains: BucketDomains;
  set: (next: BucketDomainFact[]) => void;
} {
  let facts = [...initial];
  const listeners = new Set<() => void>();
  return {
    domains: {
      current: () => facts,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      paths: [],
    },
    set: (next) => {
      facts = [...next];
      for (const listener of listeners) listener();
    },
  };
}

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** A real-time wait for a background effect (a child process's stdout, the
 *  connector's exit). Deterministic timers cannot drive those, so this is the
 *  integration-test exception: tiny and bounded, and the condition is always
 *  the thing awaited rather than a guessed duration. */
async function until(what: string, ask: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ask()) {
    if (Date.now() > deadline) throw new Error(`odu cloudflare: ${what} did not happen`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function world(input: {
  initial: BucketDomainFact[];
  publicHost?: string | null;
  probe?: (url: string) => Promise<boolean>;
}) {
  const stub = startStub();
  const connector = fakeConnector();
  const stateRoot = mkdtempSync(join(tmpdir(), "odu-cloudflare-state-"));
  const probes: string[] = [];
  const civet = domainsWorld(input.initial);
  const server = cloudflareServer({
    config: {
      token: "api-token",
      apiBase: stub.origin,
      cloudflared: connector.bin,
      probe: input.probe ?? (async (url) => {
        probes.push(url);
        return true;
      }),
      probeAttempts: 2,
      probeIntervalMs: 1,
    },
    stateRoot,
    localOrigin: "http://127.0.0.1:18440",
    publicHost: input.publicHost ?? null,
    domains: civet.domains,
    log: quiet,
  });
  server.open();
  const tunnel: CloudflareTunnel[] = [];
  const routes = new Map<string, CloudflareRoute>();
  server.attach({
    tunnel: (row) => tunnel.push(row),
    routes: {
      upsert: (key, row) => routes.set(key, row),
      remove: (key) => routes.delete(key),
    },
  });
  worlds.push(async () => {
    await server.close();
    stub.stop();
    rmSync(stateRoot, { recursive: true, force: true });
  });
  return { server, stub, civet, tunnel, routes, probes, connector };
}

describe("the cloudflare row", () => {
  it("makes ONE tunnel, routes a bucket's name, and confirms it live", async () => {
    const w = await world({ initial: [{ bucket: "kolu", domain: "cache.example.org" }] });
    await w.server.start();
    await until("the name to be live", () => w.routes.get("cache.example.org")?.state === "live");

    expect(w.stub.tunnelCreates).toBe(1);
    const created = w.stub.seen.find((one) => one.path === "/accounts/acct-1/cfd_tunnel");
    expect(created?.body).toMatchObject({ name: "odu 127.0.0.1:18440", config_src: "cloudflare" });
    const config = w.stub.seen.find((one) => one.path.endsWith("/configurations"));
    expect(config?.body).toMatchObject({
      config: {
        ingress: [
          { hostname: "cache.example.org", service: "http://127.0.0.1:18440" },
          { service: "http_status:404" },
        ],
      },
    });
    expect(w.stub.records.get("cache.example.org")).toMatchObject({
      content: "tunnel-1.cfargotunnel.com",
      proxied: true,
    });
    expect(w.probes).toEqual(["https://cache.example.org/nix-cache-info"]);
    // The tunnel's own state is the connector's, not a guess: the fake said
    // "Registered tunnel connection".
    await until("the connector to connect", () => w.tunnel.at(-1)?.state === "connected");
  });

  it("carries the server's own public origin when its zone is editable", async () => {
    const w = await world({
      initial: [{ bucket: "kolu", domain: "cache.example.org" }],
      publicHost: "board.example.org",
    });
    await w.server.start();
    await until(
      "both names to be live",
      () => w.routes.size === 2 && [...w.routes.values()].every((row) => row.state === "live"),
    );
    expect(w.routes.get("board.example.org")).toMatchObject({ bucket: null, state: "live" });
    expect(w.probes).toContain("https://board.example.org/_odu/door");
    // ONE tunnel for both names.
    expect(w.stub.tunnelCreates).toBe(1);
  });

  it("removes a name's record, and stops the connector when the last one goes", async () => {
    const w = await world({ initial: [{ bucket: "kolu", domain: "cache.example.org" }] });
    await w.server.start();
    await until("the name to be live", () => w.routes.get("cache.example.org")?.state === "live");

    w.civet.set([]);
    await w.server.reconcile();
    await until("the route to go", () => w.routes.size === 0);
    expect(w.stub.records.size).toBe(0);
    await until("the connector to stop", () => w.tunnel.at(-1)?.state === "stopped");
  });

  it("fails a name with no editable zone, in Cloudflare's words", async () => {
    const w = await world({ initial: [{ bucket: "kolu", domain: "cache.unknown.test" }] });
    await w.server.start();
    await until("the name to fail", () => w.routes.get("cache.unknown.test")?.state === "failed");
    expect(w.routes.get("cache.unknown.test")?.reason).toContain(
      "no Cloudflare zone this token can edit contains cache.unknown.test",
    );
    expect(w.stub.tunnelCreates).toBe(0);
  });

  it("refuses to start when the token is not active, naming what Cloudflare said", async () => {
    const w = await world({ initial: [] });
    w.stub.verifyOk = false;
    await expect(w.server.start()).rejects.toThrow(/Invalid API Token/);
  });

  it("mounts with the tunnel failed when Cloudflare is unreachable, and retries", async () => {
    const w = await world({ initial: [{ bucket: "kolu", domain: "cache.example.org" }] });
    // A STOPS NOT A REFUSAL: the row mounts, the tunnel says why, and a retry
    // is scheduled — the board and the runs never depend on Cloudflare.
    w.stub.stop();
    await expect(w.server.start()).resolves.toBeUndefined();
    await until("the tunnel to report the outage", () => w.tunnel.at(-1)?.state === "failed");
    expect(w.tunnel.at(-1)?.reason).toContain("could not be reached");
  });

  it("refuses a DNS record it did not create, and changes nothing", async () => {
    const w = await world({ initial: [{ bucket: "kolu", domain: "cache.example.org" }] });
    w.stub.preexisting.set("cache.example.org", {
      id: "foreign-1",
      content: "203.0.113.7",
    });
    await w.server.start();
    await until("the route to fail", () => w.routes.get("cache.example.org")?.state === "failed");
    expect(w.routes.get("cache.example.org")?.reason).toContain("is not odu's");
    expect(w.stub.preexisting.get("cache.example.org")).toEqual({
      id: "foreign-1",
      content: "203.0.113.7",
    });
    expect(w.stub.records.size).toBe(0);
  });

  it("adopts a record that already points at this tunnel", async () => {
    const w = await world({ initial: [{ bucket: "kolu", domain: "cache.example.org" }] });
    w.stub.preexisting.set("cache.example.org", {
      id: "ours-by-content",
      content: "tunnel-1.cfargotunnel.com",
    });
    await w.server.start();
    await until("the name to be live", () => w.routes.get("cache.example.org")?.state === "live");
    // Adopted, not re-created: the row did not overwrite a record that was
    // already pointing at its own tunnel.
    expect(w.stub.preexisting.get("cache.example.org")?.id).toBe("ours-by-content");
    expect(w.stub.records.size).toBe(0);
  });

  it("passes the tunnel token in the environment, and close waits for the child", async () => {
    const w = await world({ initial: [{ bucket: "kolu", domain: "cache.example.org" }] });
    await w.server.start();
    await until("the connector to connect", () => w.tunnel.at(-1)?.state === "connected");
    const markers = w.connector.markers;
    // NEVER on argv: every local user can read `ps`.
    expect(readFileSync(join(markers, "args"), "utf8")).not.toContain("connector-token");
    expect(readFileSync(join(markers, "token"), "utf8").trim()).toBe("connector-token");

    await w.server.close();
    await until("the child to exit", () => existsSync(join(markers, "exited")));
    expect(w.server.status().tunnel.state).toBe("stopped");
  });
});
