export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: "refusal" | "unavailable",
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export function isRefusal(err: unknown): err is CloudflareApiError {
  return err instanceof CloudflareApiError && err.kind === "refusal";
}

const kindOf = (status: number): "refusal" | "unavailable" =>
  status === 0 || status >= 500 || status === 429 ? "unavailable" : "refusal";

export interface ZoneRef {
  zoneId: string;
  zoneName: string;
  accountId: string;
}

export interface TunnelCreated {
  id: string;
  token: string;
}

export interface IngressRule {
  hostname?: string;
  service: string;
}

export interface CloudflareApi {
  verify(): Promise<void>;
  zoneFor(host: string): Promise<ZoneRef | null>;
  createTunnel(accountId: string, name: string): Promise<TunnelCreated>;
  putTunnelConfig(
    accountId: string,
    tunnelId: string,
    ingress: readonly IngressRule[],
  ): Promise<void>;
  ensureRecord(
    zoneId: string,
    host: string,
    tunnelId: string,
    knownId: string | null,
  ): Promise<string>;
  deleteRecord(zoneId: string, recordId: string, tunnelId: string): Promise<void>;
  /** Cloudflare takes at most thirty files in one call, so the caller sends batches. */
  purge(zoneId: string, files: readonly string[]): Promise<void>;
}

export interface CloudflareApiOptions {
  readonly token: string;
  readonly base?: string;
  readonly fetch?: typeof fetch;
}

interface Envelope {
  success: boolean;
  errors?: ReadonlyArray<{ code?: number; message?: string }>;
  result?: unknown;
}

const messagesOf = (envelope: Envelope): string => {
  const said = (envelope.errors ?? [])
    .map((error) => error.message ?? (error.code === undefined ? "" : `code ${error.code}`))
    .filter((text) => text !== "");
  return said.length === 0 ? "the API refused the request" : said.join("; ");
};

const tunnelUrl = (accountId: string, tunnelId: string): string =>
  `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`;

function registrableCandidates(host: string): string[] {
  const labels = host.toLowerCase().split(".").filter((label) => label !== "");
  const candidates: string[] = [];
  for (let at = 0; at + 2 <= labels.length; at++) {
    candidates.push(labels.slice(at).join("."));
  }
  return candidates;
}

export function cloudflareApi(options: CloudflareApiOptions): CloudflareApi {
  const base = (options.base ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
  const ask = options.fetch ?? fetch;

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await ask(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new CloudflareApiError(
        `the Cloudflare API could not be reached: ${err instanceof Error ? err.message : String(err)}`,
        0,
        "unavailable",
      );
    }
    let envelope: Envelope;
    try {
      envelope = (await response.json()) as Envelope;
    } catch {
      throw new CloudflareApiError(
        `the Cloudflare API answered ${response.status} without a JSON envelope`,
        response.status,
        kindOf(response.status),
      );
    }
    if (!response.ok || envelope.success !== true) {
      throw new CloudflareApiError(
        messagesOf(envelope),
        response.status,
        kindOf(response.status),
      );
    }
    return envelope.result as T;
  }

  return {
    async verify() {
      const result = await call<{ status?: string }>("GET", "/user/tokens/verify");
      if (result.status !== "active") {
        throw new CloudflareApiError(
          `the API token is ${result.status ?? "not active"} — make a token that is ` +
            "active, with Zone:DNS:Edit and Account:Cloudflare Tunnel:Edit",
          200,
          "refusal",
        );
      }
    },

    async zoneFor(host) {
      for (const candidate of registrableCandidates(host)) {
        const zones = await call<
          ReadonlyArray<{ id: string; name: string; account?: { id?: string } }>
        >("GET", `/zones?name=${encodeURIComponent(candidate)}&status=active`);
        const zone = zones.find((one) => one.name === candidate);
        if (zone !== undefined && zone.account?.id !== undefined) {
          return { zoneId: zone.id, zoneName: zone.name, accountId: zone.account.id };
        }
      }
      return null;
    },

    async createTunnel(accountId, name) {
      const result = await call<TunnelCreated>("POST", `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`, {
        name,
        // REMOTELY MANAGED: the ingress below is the configuration, and the
        // token this answers is what the connector runs with.
        config_src: "cloudflare",
      });
      if (typeof result.token !== "string" || result.token === "") {
        throw new CloudflareApiError(
          "Cloudflare created a tunnel but returned no token — a locally-managed " +
            "tunnel cannot be run from this daemon",
          200,
          "refusal",
        );
      }
      return result;
    },

    async putTunnelConfig(accountId, tunnelId, ingress) {
      await call("PUT", `${tunnelUrl(accountId, tunnelId)}/configurations`, {
        config: { ingress },
      });
    },

    async ensureRecord(zoneId, host, tunnelId, knownId) {
      const content = `${tunnelId}.cfargotunnel.com`;
      const existing = await call<
        ReadonlyArray<{ id: string; content?: string }>
      >("GET", `/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(host)}`);
      const found = existing[0];
      if (found === undefined) {
        const created = await call<{ id: string }>(
          "POST",
          `/zones/${encodeURIComponent(zoneId)}/dns_records`,
          { type: "CNAME", name: host, content, proxied: true },
        );
        return created.id;
      }
      if (found.content === content) return found.id;
      if (knownId !== null && found.id === knownId) {
        await call("PUT", `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(found.id)}`, {
          type: "CNAME",
          name: host,
          content,
          proxied: true,
        });
        return found.id;
      }
      throw new CloudflareApiError(
        `a DNS record for ${host} already exists and is not odu's — ` +
          "remove it or choose another name",
        409,
        "refusal",
      );
    },

    async deleteRecord(zoneId, recordId, tunnelId) {
      const before = await call<{ id: string; content?: string }>(
        "GET",
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
      ).catch((err: unknown) => {
        if (err instanceof CloudflareApiError && err.status === 404) return null;
        throw err;
      });
      if (before === null) return;
      if (before.content !== `${tunnelId}.cfargotunnel.com`) {
        throw new CloudflareApiError(
          `the DNS record for ${recordId} was changed by someone else; leaving it`,
          409,
          "refusal",
        );
      }
      await call("DELETE", `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`);
    },

    async purge(zoneId, files) {
      await call("POST", `/zones/${encodeURIComponent(zoneId)}/purge_cache`, { files });
    },
  };
}
