import type { RowAgent, RowFacts } from "@odu/cordis/services";
import { Schema } from "effect";
import { defineSurface } from "@kolu/surface/define";
import type { ExposeMap } from "@kolu/surface/expose";

export const CLOUDFLARE_KEY = "cloudflare";

export const CLOUDFLARE_CONTRACT_VERSION = "2.4";

/**
 * THE CONNECTOR'S STATE, as `cloudflared` itself reports it.
 *
 * `running` is spawned and not yet registered; `connected` is the line
 * `cloudflared` prints when a connection to the edge is up. `stopped` is the
 * honest state when no name needs a tunnel.
 */
export const TunnelStateSchema = Schema.Literals([
  "stopped",
  "running",
  "connected",
  "failed",
]);
export type TunnelState = typeof TunnelStateSchema.Type;

/** THE ONE TUNNEL this server made. `id` and `name` are null before a name is
 *  ever routed; the token is a SECRET and never appears here. */
export const CloudflareTunnelSchema = Schema.Struct({
  state: TunnelStateSchema,
  name: Schema.NullOr(Schema.String),
  id: Schema.NullOr(Schema.String),
  /** Why the connector failed, or the last error while wiring. */
  reason: Schema.NullOr(Schema.String),
});
export type CloudflareTunnel = typeof CloudflareTunnelSchema.Type;

export const OFF_TUNNEL: CloudflareTunnel = {
  state: "stopped",
  name: null,
  id: null,
  reason: null,
};

/**
 * `wiring` means the route and the record exist (or are being made) and the
 * name has not answered yet; `live` means `https://<domain>/nix-cache-info`
 * answered; `failed` carries Cloudflare's or the network's reason.
 */
export const RouteStateSchema = Schema.Literals(["wiring", "live", "failed"]);
export type RouteState = typeof RouteStateSchema.Type;

export const CloudflareRouteSchema = Schema.Struct({
  domain: Schema.String,
  /** The bucket this name belongs to; `null` is THE SERVER ITSELF (its public
   *  origin). */
  bucket: Schema.NullOr(Schema.String),
  state: RouteStateSchema,
  reason: Schema.NullOr(Schema.String),
  updated: Schema.Number,
});
export type CloudflareRoute = typeof CloudflareRouteSchema.Type;

export const CloudflareStatusSchema = Schema.Struct({
  tunnel: CloudflareTunnelSchema,
  routes: Schema.Array(CloudflareRouteSchema),
});
export type CloudflareStatus = typeof CloudflareStatusSchema.Type;

export const CloudflareRefusalCodeSchema = Schema.Literals([
  /** The API or the connector refused; `message` is its own sentence. */
  "cloudflare",
  "bad_input",
]);
export type CloudflareRefusalCode = typeof CloudflareRefusalCodeSchema.Type;

export class CloudflareRefused extends Schema.TaggedError<CloudflareRefused>(
  "@odu/cloudflare/CloudflareRefused",
)("CloudflareRefused", {
  code: CloudflareRefusalCodeSchema,
  message: Schema.String,
}) {}

export const oduCloudflareSurface = defineSurface({
  cells: {
    tunnel: {
      schema: CloudflareTunnelSchema,
      default: OFF_TUNNEL,
      verbs: ["get"],
    },
  },
  collections: {
    routes: {
      keySchema: Schema.String,
      schema: CloudflareRouteSchema,
      verbs: ["keys", "get", "deltas"],
    },
  },
  procedures: {
    status: {
      // NO INPUT, not an empty struct: an MCP host sends NO arguments for a
      // verb with none, and decoding `undefined` against `Struct({})` is a tool
      // error on every call (#134's lesson).
      read: {
        output: CloudflareStatusSchema,
        error: CloudflareRefused,
      },
    },
  },
});

export type OduCloudflareSurface = typeof oduCloudflareSurface;

export const ODU_CLOUDFLARE_EXPOSE = {
  tunnel: "resource",
  routes: "resource",
  "status.read": { tool: { mutates: false } },
} as const satisfies ExposeMap<(typeof oduCloudflareSurface)["spec"]>;

export const ODU_CLOUDFLARE_MCP_INSTRUCTIONS = [
  "The cloudflare row carries a bucket's DNS name to the server through a",
  "Cloudflare Tunnel: it makes one tunnel for this server, a route per name, a",
  "proxied DNS record, and runs `cloudflared` as a child of the daemon. It has",
  "no verb that changes a name — the bucket's own domain verb does that, and this",
  "row reacts. `cloudflare_status_read` reports the tunnel's state (stopped, running,",
  "connected or failed) and each name's (wiring, live or failed with the",
  "reason). A route whose bucket is null is the server's own public origin.",
].join("\n");

export const CLOUDFLARE_AGENT: RowAgent = {
  surface: oduCloudflareSurface,
  expose: ODU_CLOUDFLARE_EXPOSE,
  instructions: ODU_CLOUDFLARE_MCP_INSTRUCTIONS,
};

export const CLOUDFLARE_ROW: RowFacts = {
  name: CLOUDFLARE_KEY,
  key: CLOUDFLARE_KEY,
  agent: CLOUDFLARE_AGENT,
  contract: CLOUDFLARE_CONTRACT_VERSION,
};
