/**
 * THE CLOUDFLARE ROW'S CONTRACT — a tunnel's state, the names it carries, and
 * one read verb for a terminal.
 *
 * The row's facts are CELLS because they are singular: there is one tunnel for
 * this server, and its state is one value. The routes are a COLLECTION because
 * a name is a row: a bucket's domain arrives and departs while a page is open,
 * and a person wants to see which name is still `wiring` and why.
 *
 * Browser-safe: schemas, a contract and a tagged refusal, nothing else. The API
 * client, the connector and the database are behind `./server`.
 */

import type { RowAgent } from "@odu/cordis/services";
import { Schema } from "effect";
import { defineSurface } from "@kolu/surface/define";
import type { ExposeMap } from "@kolu/surface/expose";

export const CLOUDFLARE_KEY = "cloudflare";

// ── the facts ───────────────────────────────────────────────────────────────

/**
 * THE CONNECTOR'S STATE, as `cloudflared` itself reports it.
 *
 * `running` is spawned and not yet registered; `connected` is the line
 * `cloudflared` prints when a connection to the edge is up. `stopped` is the
 * honest state when no name needs a tunnel — the connector is not left running
 * for a route nobody asked for.
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
 * ONE NAME THE TUNNEL CARRIES.
 *
 * `wiring` means the route and the record exist (or are being made) and the
 * name has not answered yet; `live` means `https://<domain>/nix-cache-info`
 * answered; `failed` carries Cloudflare's or the network's reason.
 */
export const RouteStateSchema = Schema.Literals(["wiring", "live", "failed"]);
export type RouteState = typeof RouteStateSchema.Type;

export const CloudflareRouteSchema = Schema.Struct({
  domain: Schema.String,
  /** The bucket this name belongs to; `null` is THE SERVER ITSELF (its public
   *  origin), which the tunnel carries when that host is in an editable zone. */
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

// ── the refusal ─────────────────────────────────────────────────────────────

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

// ── the surface ─────────────────────────────────────────────────────────────

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
      read: {
        input: Schema.Struct({}),
        output: CloudflareStatusSchema,
        error: CloudflareRefused,
      },
    },
  },
});

export type OduCloudflareSurface = typeof oduCloudflareSurface;

/** WHAT AN AGENT MAY REACH. Both facts are reads; the row has no mutating
 *  verb — a name is set on the BUCKET, and this row follows it. */
export const ODU_CLOUDFLARE_EXPOSE = {
  tunnel: "resource",
  routes: "resource",
  "status.read": { tool: { mutates: false } },
} as const satisfies ExposeMap<(typeof oduCloudflareSurface)["spec"]>;

/** The paragraph an MCP host is taught at `initialize`. */
export const ODU_CLOUDFLARE_MCP_INSTRUCTIONS = [
  "The cloudflare row carries a bucket's DNS name to the server through a",
  "Cloudflare Tunnel: it makes one tunnel for this server, a route per name, a",
  "proxied DNS record, and runs `cloudflared` as a child of the daemon. It has",
  "no verb that changes a name — the bucket's own domain verb does that, and this",
  "row reacts. `cloudflare_status` reports the tunnel's state (stopped, running,",
  "connected or failed) and each name's (wiring, live or failed with the",
  "reason). A route whose bucket is null is the server's own public origin.",
].join("\n");

export const CLOUDFLARE_AGENT: RowAgent = {
  surface: oduCloudflareSurface,
  expose: ODU_CLOUDFLARE_EXPOSE,
  instructions: ODU_CLOUDFLARE_MCP_INSTRUCTIONS,
};
