/**
 * CLOUDFLARE'S API, AS FAR AS THIS ROW NEEDS IT.
 *
 * Five calls: verify the token, find the zone a name belongs to, make one
 * tunnel, give it its ingress, and keep one proxied CNAME. Everything this row
 * creates is named after this server — the tunnel after the public origin — so
 * a person looking at the Cloudflare dashboard can tell two odu installs apart.
 *
 * The base URL and the fetch are constructor arguments so the suite records a
 * conversation instead of reaching the network. Errors are Cloudflare's own
 * sentence, joined from the envelope's `errors`, because "the API said no" is
 * not a reason a person can act on.
 */

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export interface ZoneRef {
  zoneId: string;
  zoneName: string;
  accountId: string;
}

export interface TunnelCreated {
  id: string;
  token: string;
}

/** One ingress rule, as cloudflared's remotely-managed configuration takes it. */
export interface IngressRule {
  hostname?: string;
  service: string;
}

export interface CloudflareApi {
  /** `GET /user/tokens/verify` — a refusal names what Cloudflare said. */
  verify(): Promise<void>;
  /** The zone a name belongs to, trying the name and then its parents. */
  zoneFor(host: string): Promise<ZoneRef | null>;
  createTunnel(accountId: string, name: string): Promise<TunnelCreated>;
  putTunnelConfig(
    accountId: string,
    tunnelId: string,
    ingress: readonly IngressRule[],
  ): Promise<void>;
  /** Make or update the proxied CNAME to the tunnel; answers the record id. */
  ensureRecord(zoneId: string, host: string, tunnelId: string): Promise<string>;
  deleteRecord(zoneId: string, recordId: string): Promise<void>;
}

export interface CloudflareApiOptions {
  readonly token: string;
  /** `https://api.cloudflare.com/client/v4` in production; the suite's stub
   *  otherwise. */
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
      );
    }
    let envelope: Envelope;
    try {
      envelope = (await response.json()) as Envelope;
    } catch {
      throw new CloudflareApiError(
        `the Cloudflare API answered ${response.status} without a JSON envelope`,
        response.status,
      );
    }
    if (!response.ok || envelope.success !== true) {
      throw new CloudflareApiError(messagesOf(envelope), response.status);
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
        );
      }
    },

    async zoneFor(host) {
      const labels = host.toLowerCase().split(".").filter((label) => label !== "");
      // A zone is a registrable name; the tunnel's name is a subdomain of one.
      // Try the name, then each parent, stopping before the bare TLD.
      for (let at = 0; at <= labels.length - 2; at++) {
        const candidate = labels.slice(at).join(".");
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
        );
      }
      return result;
    },

    async putTunnelConfig(accountId, tunnelId, ingress) {
      await call("PUT", `${tunnelUrl(accountId, tunnelId)}/configurations`, {
        config: { ingress },
      });
    },

    async ensureRecord(zoneId, host, tunnelId) {
      const content = `${tunnelId}.cfargotunnel.com`;
      const existing = await call<
        ReadonlyArray<{ id: string; content?: string }>
      >("GET", `/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(host)}`);
      const found = existing[0];
      if (found !== undefined) {
        if (found.content !== content) {
          await call("PUT", `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(found.id)}`, {
            type: "CNAME",
            name: host,
            content,
            proxied: true,
          });
        }
        return found.id;
      }
      const created = await call<{ id: string }>(
        "POST",
        `/zones/${encodeURIComponent(zoneId)}/dns_records`,
        { type: "CNAME", name: host, content, proxied: true },
      );
      return created.id;
    },

    async deleteRecord(zoneId, recordId) {
      try {
        await call("DELETE", `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`);
      } catch (err) {
        // ALREADY GONE is the state the caller wanted; anything else is real.
        if (err instanceof CloudflareApiError && err.status === 404) return;
        throw err;
      }
    },
  };
}
