# `@odu/cloudflare` — a bucket's name, made real

The `cloudflare` row gives a bucket a DNS name of its own. It watches the cache
row's published `BucketDomains` fact — never that row's database or verbs — and
makes the tunnel match: one Cloudflare Tunnel for this server, one route per
name, one proxied CNAME per name, and a `cloudflared` child process that connects
them. No inbound port is opened.

It mounts only when `ODU_CLOUDFLARE_API_TOKEN_FILE` is set
(`services.odu.cloudflare.apiTokenFile` under the module). The token needs
**Zone → DNS → Edit**, **Zone → Zone → Read** and
**Account → Cloudflare Tunnel → Edit**.

## What it owns

| Fact | Where it lives |
| --- | --- |
| The tunnel (id, name, token) | its own SQLite, `$ODU_STATE_DIR/cloudflare/cloudflare.sqlite` (0600) |
| Each route's state, zone and record id | the same database |
| `tunnel` — connector state | a published cell |
| `routes` — one row per name | a published collection |
| `cloudflare_status` | the read verb, for `odu cloudflare status` |

A route whose `bucket` is `null` is the SERVER's own public origin: the same
tunnel carries it when its host is in a zone the token can edit, which is what
lets a Tailscale Funnel retire.

## A refusal is not an outage

An inactive token or a missing permission **refuses the row at mount**, naming
what Cloudflare said. An unreachable API (network, 5xx, rate limit) mounts the
row with the tunnel `failed: <reason>` and retries with backoff: a Cloudflare
incident must not stop the board, the runs or the cache. The first reconcile runs
after the mount, never on `apply`'s path.

## The connector's lifetime

`cloudflared` is spawned with the tunnel token in `TUNNEL_TOKEN` (never on
`argv`), and this row's `close()` waits for the reconcile in flight, for every
probe, and for the child's exit. An orphan connector holding the token, or a
restart that runs two, is the failure this ownership exists to prevent.

## A foreign DNS record is refused

The row adopts a record only when its id is in this database or its content
already points at this tunnel. Anything else fails the route with "a DNS record
for X already exists and is not odu's — remove it or choose another name", and
a record somebody repointed is left alone on clearing. The board's own hostname
is no exception.

## What a name serves

At `cache.example.org` the CACHE answers: `/` is the bucket's public page, the
Nix protocol's paths are served, and everything else — the board, `/mcp`,
`/auth`, `/rpc/ws` — is the cache row's 404. The host's bucket-domain gate reads
`BucketDomains.paths` to enforce that; this row only makes the name resolve.

## Tests

- `src/server.test.ts` — the API/connector conversation, against a stub that
  answers Cloudflare's documented envelope and a real fake `cloudflared`.
- `e2e/` — the browser world (`@tunnel`): a name becomes live, clearing it
  removes the route and stops the connector, a name in a zone the token cannot
  see is `failed` with the reason, and `odu cloudflare status` reads it.
