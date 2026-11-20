import { Schema } from "effect";
import { defineSurface } from "@kolu/surface/define";
import type { ExposeMap } from "@kolu/surface/expose";
import type { RowAgent, RowFacts } from "./services";

export const METRICS_KEY = "metrics";

export const METRICS_PATH = "/metrics";

export const METRICS_CONTRACT_VERSION = "1.0";

export class MetricsRefused extends Schema.TaggedError<MetricsRefused>(
  "@odu/metrics/MetricsRefused",
)("MetricsRefused", {
  code: Schema.Literals([
    /** No root token is configured, or the one presented does not match. */
    "no_root_token",
    /** The caller is signed in but is not an administrator of this daemon. */
    "not_permitted",
    /** No such token id, or an unusable label. */
    "bad_input",
  ]),
  message: Schema.String,
}) {}

const REFUSES = MetricsRefused;

/** A metrics token, less the secret. */
export const MetricsTokenSchema = Schema.Struct({
  /** What `token.revoke` names. Not a credential. */
  id: Schema.String,
  /** The operator's own word for whoever holds it ("prometheus-pod"). */
  label: Schema.String,
  created: Schema.Number,
  /** When it last authorised a scrape; `null` until it has. */
  lastUsed: Schema.NullOr(Schema.Number),
  revoked: Schema.Boolean,
});
export type MetricsTokenFacts = typeof MetricsTokenSchema.Type;

const TokenMintInputSchema = Schema.Struct({
  rootToken: Schema.String,
  /** Absent takes a default. */
  label: Schema.optionalKey(Schema.String),
});
const TokenMintOutputSchema = Schema.Struct({
  /** Shown ONCE. The server keeps a sha256 of it. */
  token: Schema.String,
  facts: MetricsTokenSchema,
});
const TokenListInputSchema = Schema.Struct({ rootToken: Schema.String });
const TokenListOutputSchema = Schema.Struct({ tokens: Schema.Array(MetricsTokenSchema) });
const TokenRevokeInputSchema = Schema.Struct({ rootToken: Schema.String, id: Schema.String });
const TokenRevokeOutputSchema = Schema.Struct({ id: Schema.String, revoked: Schema.Boolean });

export const oduMetricsSurface = defineSurface({
  procedures: {
    token: {
      mint: { input: TokenMintInputSchema, output: TokenMintOutputSchema, error: REFUSES },
      list: { input: TokenListInputSchema, output: TokenListOutputSchema, error: REFUSES },
      revoke: { input: TokenRevokeInputSchema, output: TokenRevokeOutputSchema, error: REFUSES },
    },
  },
});

export type OduMetricsSurface = typeof oduMetricsSurface;

export const ODU_METRICS_EXPOSE = {
  "token.mint": { tool: { mutates: true } },
  "token.list": { tool: { mutates: false } },
  "token.revoke": { tool: { mutates: true } },
} as const satisfies ExposeMap<(typeof oduMetricsSurface)["spec"]>;

export const ODU_METRICS_MCP_INSTRUCTIONS = [
  "`GET /metrics` is this daemon's Prometheus exposition — bucket hit rates and",
  "storage, run and node durations, and lane use. It is NOT anonymous: a scrape",
  "carries the operator's root token or a metrics token as",
  "`Authorization: Bearer`, and anything else is 401.",
  "`metrics_token_mint` answers a metrics token ONCE (only its hash is kept) —",
  "that is the credential a Prometheus holds, and it can read nothing but",
  "`/metrics`. `metrics_token_list` names every one that exists and when it was",
  "last used; `metrics_token_revoke` ends one immediately, with no restart.",
  "All three need the root token. Counters reset when the daemon restarts; the",
  "gauges are read from storage at the scrape and do not.",
].join("\n");

export const METRICS_AGENT: RowAgent = {
  surface: oduMetricsSurface,
  expose: ODU_METRICS_EXPOSE,
  instructions: ODU_METRICS_MCP_INSTRUCTIONS,
};

export const METRICS_ROW: RowFacts = {
  name: METRICS_KEY,
  key: METRICS_KEY,
  agent: METRICS_AGENT,
  contract: METRICS_CONTRACT_VERSION,
};
