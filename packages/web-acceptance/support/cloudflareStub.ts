import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CloudflareStub {
  readonly origin: string;
  readonly cloudflaredBinDirForPath: string;
  readonly seen: { method: string; path: string }[];
  readonly stop: () => void;
}

export function startCloudflareStub(): CloudflareStub {
  const seen: { method: string; path: string }[] = [];
  const records = new Map<string, { id: string; content: string }>();
  const envelopes = (result: unknown) => Response.json({ success: true, errors: [], result });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({ method: request.method, path: `${url.pathname}${url.search}` });
      if (url.pathname === "/nix-cache-info" || url.pathname === "/_odu/door") {
        return new Response("ok");
      }
      if (url.pathname === "/user/tokens/verify") {
        return envelopes({ status: "active" });
      }
      if (url.pathname === "/zones" && request.method === "GET") {
        const name = url.searchParams.get("name") ?? "";
        return envelopes(
          name === "tunnel.test"
            ? [{ id: "zone-e2e", name, account: { id: "acct-e2e" } }]
            : [],
        );
      }
      if (url.pathname === "/accounts/acct-e2e/cfd_tunnel" && request.method === "POST") {
        return envelopes({ id: "tunnel-e2e", token: "connector-token" });
      }
      if (url.pathname === "/accounts/acct-e2e/cfd_tunnel/tunnel-e2e/configurations") {
        return envelopes({});
      }
      if (url.pathname === "/zones/zone-e2e/dns_records") {
        if (request.method === "GET") {
          const name = url.searchParams.get("name") ?? "";
          const record = records.get(name);
          return envelopes(record === undefined ? [] : [{ id: record.id, content: record.content }]);
        }
        const sent = (await request.json()) as { name: string; content: string };
        const record = { id: `rec-${records.size + 1}`, content: sent.content };
        records.set(sent.name, record);
        return envelopes({ id: record.id });
      }
      if (url.pathname.startsWith("/zones/zone-e2e/dns_records/") && request.method === "DELETE") {
        const id = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
        for (const [name, record] of records) {
          if (record.id === id) records.delete(name);
        }
        return envelopes({ id });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const cloudflaredBinDirForPath = mkdtempSync(join(tmpdir(), "odu-wa-cloudflared-"));
  const bin = join(cloudflaredBinDirForPath, "cloudflared");
  writeFileSync(bin, '#!/bin/sh\necho "Registered tunnel connection connIndex=0"\nexec sleep 600\n');
  Bun.spawnSync(["chmod", "0755", bin]);

  return {
    origin: `http://127.0.0.1:${server.port}`,
    cloudflaredBinDirForPath,
    seen,
    stop: () => server.stop(true),
  };
}
