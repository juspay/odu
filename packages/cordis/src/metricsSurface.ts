/**
 * THE CREDENTIAL A SCRAPER HOLDS, as verbs — the host's own fragment on the
 * composed wire.
 *
 * `/metrics` is served by the HOST (no row owns the number of runs AND the
 * number of cached paths), and it is not anonymous: the deployment this is
 * written for is public through a Funnel, where "only the tailnet can reach it"
 * is not true. The operator's root token opens it, and so does a `metrics`
 * TOKEN — a read-only credential minted by the root token, shown once, kept as a
 * hash, and revocable without restarting the daemon or rotating the one
 * credential that administers everything else.
 *
 * **Why the surface lives in `@odu/cordis`.** It is the host's vocabulary, and
 * the host is the one package a row may not import — while the faces that
 * project it (`odu surface`, the MCP bridge) are rows. This package belongs to
 * neither, which is exactly the case it exists for. The HANDLERS are the host's
 * (`@odu/host`'s `metricsFragment`); only the shape is here.
 *
 * Names are `metrics_token_<verb>`, the framework's own derivation from the key
 * this fragment is mounted at and the noun inside it — the same rule every row
 * follows, so an agent that knows `cache_token_mint` can guess this one.
 */

import { Schema } from "effect";
import { defineSurface } from "@kolu/surface/define";
import type { ExposeMap } from "@kolu/surface/expose";
import type { RowAgent, RowFacts } from "./services";

/** The word this fragment is mounted and addressed under — on the wire
 *  (`surface/metrics/token/mint`), in a tool name (`metrics_token_mint`) and in
 *  a terminal (`odu surface metrics token_mint`). Declared once, here, because
 *  the host mounts it and three faces spell it. */
export const METRICS_KEY = "metrics";

/** WHERE THE NUMBERS ARE. The host serves it, the nginx module proxies it, and
 *  the reserved-path set admits it — one spelling for all three. */
export const METRICS_PATH = "/metrics";

/**
 * THIS FRAGMENT'S CONTRACT VERSION, `major.minor`, under the rule every row's
 * own version keeps: the MINOR moves when the surface only grows, the MAJOR when
 * something a caller already uses changes.
 *
 * 1.0: `token.mint`, `token.list`, `token.revoke`.
 */
export const METRICS_CONTRACT_VERSION = "1.0";

/** Why a metrics verb was refused. Its own tagged error rather than the runs'
 *  or the cache's: this fragment is the host's, and borrowing another row's
 *  error would tie its wire to that row's version. */
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

/** A metrics token, less the secret. The plaintext exists exactly once, in
 *  `token.mint`'s answer; everything after that is this. */
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
  /** Absent takes a default: a token nobody labelled is still revocable, and
   *  refusing the mint over a missing word would help nobody. */
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

/** Minting, listing and revoking the scrape credential. No cells and no
 *  collections: nothing subscribes to a token list, and a page that did would
 *  be a page that updates when somebody else revokes one. */
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

/** What an agent may reach. `mutates` spelled per entry, the framework's safety
 *  default being "assume it mutates". */
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

/** THIS FRAGMENT'S FACTS, in the shape every composed face reads a row's in.
 *  The host mounts it on every daemon — there is no configuration that turns
 *  metrics off — so unlike the door it is never conditionally absent. */
export const METRICS_ROW: RowFacts = {
  name: METRICS_KEY,
  key: METRICS_KEY,
  agent: METRICS_AGENT,
  contract: METRICS_CONTRACT_VERSION,
};
