# Nix binary cache

`odu web` also serves Nix binary caches. The same loopback service that runs CI answers the standard Nix HTTP binary cache protocol, so every Nix client works unchanged.

A bucket is one cache: one substituter URL under the service's origin and one ed25519 public key. The server generates the keypair and signs each narinfo on ingest; a pusher never holds a signing key. Client signatures are kept. By default the cache binds loopback, like the board: `$ODU_WEB_ORIGIN` is the address it listens on, and the NixOS module puts nginx in front of it — proxying the cache's protocol paths only, unless [server mode](../docs/#server-mode) is configured, where the board and `/mcp` are behind the same door. On a single machine the cache and the store are the same bytes; see [Where the data lives](#where-the-data-lives).

## Create a bucket

```sh
odu cache create main
```

On the board: the Cache view's **Create bucket** form, with the same upstream switch. `create` prints the substituter URL and the bucket's public key. Behind a proxy that URL is the address you published the service at, not the loopback one — `$ODU_PUBLIC_ORIGIN`, which the NixOS module derives for you. `odu cache use main` prints the same as two Nix settings, ready for `nix.conf` — and needs no token at all, because a bucket's URL and public key are what it publishes to every client that talks to it. On a server with a door that is a PROTOCOL read, not a session: `GET /cache/<bucket>/` answers a public bucket's facts with no account (a small page for `curl`, add `Accept: application/json` for a terminal). A private bucket's facts need a reader, and `odu cache use` says so:

## Use it

The bucket's page shows these as separate, titled blocks — one per thing you paste somewhere. Trust the key, then a build substitutes from the bucket instead of the network.

`nix.conf`:

```sh
extra-substituters = http://127.0.0.1:18440/cache/main
extra-trusted-public-keys = main-1:<public-key>
```

NixOS / nix-darwin:

```nix
nix.settings = {
  extra-substituters = [ "http://127.0.0.1:18440/cache/main" ];
  extra-trusted-public-keys = [ "main-1:<public-key>" ];
};
```

`flake.nix`:

```nix
{
  nixConfig = {
    extra-substituters = [ "http://127.0.0.1:18440/cache/main" ];
    extra-trusted-public-keys = [ "main-1:<public-key>" ];
  };
}
```

GitHub Actions — inside the step that installs Nix:

```yaml
extra_nix_config: |
  extra-substituters = http://127.0.0.1:18440/cache/main
  extra-trusted-public-keys = main-1:<public-key>
```

A **private** bucket's page also carries the netrc block, because reading it needs a credential:

```sh
# netrc — Nix reads only the file named by netrc-file, never ~/.netrc,
# and it does NOT expand ~ there: give it an absolute path.
# (replace <home> below with yours — a page cannot know it)
netrc-file = <home>/.netrc
machine 127.0.0.1:18440 password <your-read-token>
```

Or let a terminal print them: `odu cache use main`.

## Tokens

```sh
odu cache token mint main --write
odu cache token mint main --write --buckets 'team-*'   # one token, several buckets
```

On the board: a bucket page's **Tokens** section mints one (write or read scope), lists them, and revokes one. The token is printed once; the server keeps only its hash, in the database described under [Where the data lives](#where-the-data-lives). A token carries a bucket glob, a scope (`--read`, `--write` or `--admin`), an expiry, and its last use. It expires in **ninety days** unless `--expires-days` says otherwise; `--no-expiry` is the explicit never, and both pages' forms default to ninety days with **never** a visible choice. An expired token's refusal names the date it expired. Revoke one without touching the rest:

```sh
odu cache token list
odu cache token revoke <id>
```

Administration — creating buckets, minting and revoking tokens, pinning and collecting — needs the root token, which the service reads from `$ODU_ROOT_TOKEN`:

```sh
export ODU_ROOT_TOKEN=...
odu cache create main
```

**On a server with a door, the rule is your role.** Once [server mode](../docs/#server-mode) is configured, the root token is not an administrator — it exists to grant the first owner — and administration needs an `admin` or an `owner`:

```sh
odu auth whoami                    # who this machine's token belongs to, and its role
odu cache create main              # as an admin, through the token odu auth login stored
```

A `member` sees every bucket and may read a bucket's URL, key and paths, but `create`, `token mint` and `gc` are refused with `not_permitted` — and the board draws them none of those controls. On a daemon with no door the Cache view asks for the root token once per visit (kept in the page, never stored), because that is what this daemon's administration checks. Pushing does not change: a write token from `odu cache token mint` is what a pusher carries, whoever minted it.

## Push

Save a write token for an origin once:

```sh
odu cache login http://127.0.0.1:18440
```

It reads the token from stdin (or `--token <token>`), and writes one entry per origin to `~/.config/odu/cache/credentials` (mode 0600). `odu cache push` resolves the token in this order:

1. `--token-file <path>`
2. `$ODU_CACHE_TOKEN`
3. the credentials entry for the bucket's origin

The bucket argument is a name resolved against the logged-in origin, or a full `https://<host>/cache/<bucket>` URL — the substituter URL `odu cache use` prints. CI exports the secret and never logs in — this is the block a bucket's page shows under **Push to it**, with the token filled in the moment you mint one there:

```sh
# push — a write token, exported where the build runs (a build secret)
export ODU_CACHE_TOKEN=<your-write-token>
odu cache push main <paths> --origin https://odu.example.com
```

What it says while it works — one preamble, then one line per path as the bucket answers:

```text
118 paths in the closure: 6 to push, 108 already here, 4 upstream
✅ /nix/store/…-odu-0.1.0/bin/odu stored
⏳ /nix/store/…-big-output part 3
⏸ /nix/store/…-hello-2.12.3 held: waiting for 1 reference that is neither here nor upstream: /nix/store/…-glibc-2.44-57
❌ /nix/store/…-bad-output refused: the upload was truncated or corrupted
held 1 path — see https://odu.example.com/#/cache/main
```

A `held` path is one the bucket accepted and cannot serve yet: a reference it needs is neither in the bucket nor signed by one of its upstream keys. The push reports it and **returns** — the exit is non-zero only for refusals — and the bucket's page lists the same paths with the same sentence.

The server fetches a hold's references in **one job over the whole missing set**, started when the hold is recorded and not tied to the upload request; the sentence's count is that set's size. A held row is stored, so a restart re-queues it at row apply and the fetch resumes with no new push. The bucket page shows which references the job has already landed beside the ones still missing. `--wait` is the explicit choice to stay: it **reads that progress** until the referrer is recorded, and never re-uploads it.

A NAR larger than `--part-size` (64 MiB by default) is sent in parts, each retried on its own; the server reassembles them and the same hash proof decides. That is what makes a push work through a proxy with a request-size ceiling — Cloudflare's is 100 MB.

`push` asks the bucket which paths it is missing, then uploads only those, with retries. It talks to the cache's HTTP API directly, so it runs on the machine that holds the paths.

A GitHub Actions step, with the token as a secret:

```yaml
- run: |
    paths=$(nix build -L --no-link --print-out-paths .#your-package)
    nix run --accept-flake-config github:juspay/odu -- \
      cache push kolu --origin https://cache.kolu.dev $paths
  env:
    ODU_CACHE_TOKEN: ${{ secrets.ODU_CACHE_TOKEN }}
```

Prefer plain Nix? `nix copy --to` works without any odu code on the client:

```sh
nix copy --to http://127.0.0.1:18440/cache/main ./result
```

Nix reads credentials only from the file named by its `netrc-file` setting (default `/etc/nix/netrc`), never `~/.netrc` on its own. `odu cache use main` prints a `netrc-file` line pointing at your own file and the credential line to put in it:

```sh
netrc-file = /home/<you>/.netrc
machine 127.0.0.1 password <your-write-token>
```

`use` prints the placeholder rather than the token it could read: the block is pasted into a `nix.conf` and a `flake.nix`, which are read by people and committed.

For CI, put the token in the URL instead of provisioning a file:

```sh
nix copy --to "http://x:$ODU_CACHE_TOKEN@127.0.0.1:18440/cache/main" ./result
```

The server accepts any username and the token as the password.

### Compared with `cachix push` and `attic push`

| | cachix push | attic push | `odu cache push` |
| --- | --- | --- | --- |
| Closure, batched missing query, retries | yes | yes | yes |
| Skips paths cache.nixos.org already has | yes | yes | yes: the server drops paths signed by an upstream key, `cache.nixos.org-1` by default — or nothing, with `--no-upstream` |
| Streams NARs, parallel uploads | yes | yes | yes: `nix store dump-path` through zstd, several paths at a time, retry per path |
| Uploads bypass the server | yes, straight to S3 | no | no; a later release adds it for object storage |
| Dedup | per NAR | per chunk | per store path |
| Pushes every build as it happens | `watch-exec`, `watch-store` | `watch-store` | not yet; a later release adds a post-build hook for lane hosts |
| Client signs with its own key | optional | no | no; the server signs |
| Client to install | cachix | attic | odu itself, or nothing: use `nix copy` with netrc |

Until the hook ships, a CI job pushes only the closures it names. Plain `nix copy --to` compresses each NAR in memory before uploading and checks the cache one path at a time, which is why `odu cache push` exists; prefer it for large closures.

## Private buckets

A public bucket reads without a token. Reads from a private bucket need the same credential as a write: netrc for `nix copy` and substitution, or `Authorization: Bearer <token>` for HTTP clients. Writes always need a token.

An unauthenticated read of a private bucket answers **404**, not 401: "you need a token" would confirm the bucket exists, and a private name must not be enumerable. A caller who presents a token that is wrong, revoked, expired or scoped elsewhere gets 403.

## Keep and reclaim

```sh
odu cache pin main release-1.2 ./result
odu cache gc main
odu cache stats
```

On the board: a bucket page's **Pin a closure**, **Run GC** and **Stats** sections. Pins are named and root a closure. Garbage collection applies per-bucket retention on last access: an object is evicted only when nothing retained in the bucket references it and it is not under a pin. A path no bucket retains loses its root and is deleted from the store. `odu cache stats` reports sizes and hit counts.

## Where the data lives

The cache keeps no second copy of your builds. The server's own `/nix/store` holds the paths; a bucket is metadata over it.

- A push imports the paths into the server's store through the Nix daemon. Pushing from the machine that built them moves nothing.
- An upload is accepted only when the bytes are there: the server hashes the NAR it staged against the narinfo's `NarHash` before importing it. `nix copy --from` alone would not do, because it copies nothing and exits 0 for a path the store already has — which on a single machine is the ordinary case.
- A narinfo whose references are not in the store yet answers **202** and is imported when they arrive; anything else that cannot be imported answers **400** with Nix's own sentence. A reference `odu cache push` skipped as upstream is FETCHED BY THE SERVER: `nix-store -r` substitutes it into this store, trusting only the keys the bucket names, and the referrer imports. The 202 remains for a reference that is neither in the bucket nor signed by one of those keys — the held state the bucket publishes.
- A NAR read streams the path out of the store, compressed on the fly.
- Every path a bucket retains is rooted under odu's state directory, so the machine's own garbage collection never removes what the cache serves. `odu cache gc` drops the roots of what retention has expired and deletes those paths.
- The database, signing keys, token hashes, narinfo metadata and pins live in one SQLite file:

```text
<state>/cache/cache.sqlite    metadata, bucket signing keys, token hashes, pins
<state>/cache/gcroots/        one root per retained path, per bucket
<state>/cache/staging/        uploads between their NAR and their narinfo
```

An upload sits in `staging/` until its narinfo arrives; one that never gets it is swept after an hour, so a client killed between the two PUTs cannot leak a NAR.

`<state>` is `$ODU_STATE_DIR` if set, else `$XDG_STATE_HOME/odu` (`~/.local/state/odu` by default) on Linux and `~/Library/Application Support/odu` on macOS, the same place as the run catalog. Tokens are stored only as hashes, so a copy of the database cannot be used to push. The signing keys are in it, so treat it as a secret. Back up the database; the paths themselves are rebuilt or re-pushed.

**The daemon's own home is the one thing that is not under `<state>` by default.** It holds the singleton's gate and control socket, and its name is derived from the origin — `odu-web` at the default origin, `odu-web-<hash>` at any other, so two services cannot share one. Without `$ODU_STATE_DIR` it is `$HOME/.local/state/odu-web*`: a SIBLING of `odu` rather than a child of it, and deliberately not under `$XDG_STATE_HOME` — that variable varies by launch context (a login shell, a bare ssh, a systemd unit), and two contexts computing two "state" homes would split one daemon's identity. Set `$ODU_STATE_DIR` and the home moves inside it, which is what a container with a read-only `$HOME` wants.

Importing paths built on another machine requires the user running `odu web` to be in `nix.settings.trusted-users` on the server, because those paths carry no signature the daemon trusts. Pushing from the same machine needs nothing. Running all of this on a NixOS host, with the state under `/var/lib/odu` and nginx in front, is [Self-host on NixOS](../docs/#self-host-on-nixos).

## A domain for a bucket

A bucket is served at `https://<your odu>/cache/<bucket>`. Give it a name of its own — `https://cache.kolu.dev` — and that is the URL people put in `nix.conf`, and it stays the same when the server moves.

Odu does the wiring itself through Cloudflare. Hand it one API token and set the domain on the bucket; there is nothing else to run.

### Create the Cloudflare token

In Cloudflare, **My Profile → API Tokens → Create Token → Custom token**:

| Field | Value |
| --- | --- |
| Token name | `odu` |
| Permissions | **Zone → DNS → Edit**, **Zone → Zone → Read**, **Account → Cloudflare Tunnel → Edit** |
| Zone Resources | Include → Specific zone → `kolu.dev` (one line per zone you will use) |
| Account Resources | Include → your account |

### Give it to odu

| | |
| --- | --- |
| `ODU_CLOUDFLARE_API_TOKEN_FILE` | a file holding the token — a systemd credential under the module |

With the NixOS module, `services.odu.cloudflare.apiTokenFile`. The token is verified at boot: a missing or inactive one refuses the row with Cloudflare's own sentence, rather than a panel that never moves.

### Set the domain

On the bucket's page, under **Domain**, type `cache.kolu.dev` and save. Or, for parity:

```sh
odu cache domain kolu cache.kolu.dev --origin https://odu.example.com
```

Odu then:

1. creates one Cloudflare Tunnel for this server, named after its public origin, the first time any name is set;
2. routes every name through that tunnel to the cache;
3. creates each proxied DNS record;
4. starts the `cloudflared` connector as a child of the daemon — the way it runs `nix`.

A name is **wiring** while that happens, **live** once `https://<name>/nix-cache-info` answers, or **failed** with Cloudflare's reason (a token without the DNS permission; a zone the token cannot see). The bucket page's route strip and the board's **Tunnel** page show it, and `odu cloudflare status` asks from a terminal. The tunnel page also shows the connector: running, connected, stopped, or failed with the last words `cloudflared` said.

Once live, the bucket's **Use it** block and `odu cache use kolu` print the new URL; the old `/cache/kolu` URL keeps working. Pushes are unchanged: `odu cache push kolu` finds the bucket by name.

**The name serves only the bucket.** `/` is the bucket's public page, the Nix protocol's paths (`/nix-cache-info`, `/<hash>.narinfo`, `/nar/<file>`, the push API) are served, and everything else on that hostname — the board, `/mcp`, `/auth`, `/rpc/ws` — is the cache row's 404. The tunnel forwards every path, so the daemon's `Host` routing is what keeps the control plane off a substituter's name; the board stays on `cache.domain`.

**The server's own origin rides the same tunnel** when its host is in a zone the token can edit — the board, `/mcp` and the websocket. That is what lets a Tailscale Funnel retire; the GitHub App's callback URL then moves to that name.

### Remove it

Clear the **Domain** field, or `odu cache domain kolu --none`. Odu removes the route and the DNS record. The tunnel itself is this server's and stays; the connector stops when the last name goes.

### What it does not do

A domain is a name, not a lock. Reads on a public bucket stay anonymous whether you reach it by `/cache/kolu` or by `cache.kolu.dev`. Private buckets — read with a token — come with teams.

The connector needs outbound HTTPS from the server and nothing inbound: no port is opened on your network, and your server's address never appears in DNS.

## The Cache view

`odu web`'s page has **Runs** and **Cache** in the header. `#/cache` lists the buckets — name, public or private, how many paths, how much space, when it last took a push, how many reads — and `#/cache/<bucket>` is one bucket: its substituter URL, its public key, the `nix.conf` / netrc block above ready to copy, and its paths newest first with a filter box.

**The view does everything `odu cache` does**, except push, which is a build box's job. Anyone may read: the page asks `cache_bucket_describe` and `cache_bucket_paths`, which take no credential, because a bucket's URL, its key and its path list are what the substituter already publishes. An admin is also drawn the administration: **Create bucket** (with **Skip upstream paths** — off is `--no-upstream`) on the list, and on a bucket page **Tokens** (mint write or read, shown once; list; revoke), **Pin a closure**, **Run GC** and **Stats**. The controls are drawn by role and refused by the row on its own, so a hidden button is never the only check.

The rows arrive over the wire the page already holds, so a path pushed from a build box appears without a reload; reads are folded into a bucket's counters at most once a second rather than once per NAR.

## Protocol

One bucket is one substituter. Point any Nix-compatible tool at these routes:

```text
GET  /cache/<bucket>/nix-cache-info             StoreDir, WantMassQuery: 1, Priority: 40
HEAD /cache/<bucket>/<hash>.narinfo
GET  /cache/<bucket>/<hash>.narinfo
GET  /cache/<bucket>/nar/<filehash>.nar.zst     streamed from the store, compressed on the fly
PUT  /cache/<bucket>/nar/<filehash>.nar.<ext>   Bearer or Basic; any ext Nix sends
PUT  /cache/<bucket>/<hash>.narinfo             server re-signs with the bucket key
POST /_odu/v1/buckets/<bucket>/missing          batch "which of these are you missing"
GET  /cache/<bucket>/                           a public bucket's facts: the use block,
                                                or JSON on Accept: application/json
```

On a bucket's own domain the same four Nix paths sit at `/`: `/nix-cache-info`, `/<hash>.narinfo`, `/nar/<file>` and their uploads. `Host` names the bucket.

`/cache` is a literal, and it is load-bearing: the board answers `/assets/<hashed
bundle>` on the same origin, and a bucket at the origin's first segment would
shadow the page's own JavaScript. A bucket called `cache` lives at
`/cache/cache`.

Writes, and reads of private buckets, accept `Authorization: Bearer <token>` or HTTP Basic with any username and the token as the password. Nix uses the second through curl on every request, uploads included. The `missing` route backs `odu cache push`; it is not part of the Nix protocol. It answers `missing` — the paths to send — and `skippedUpstream`, the paths the bucket will never take because an upstream key signed them, so a push can report the two as different things.

## CLI reference

| Command | What it does | On the board |
| --- | --- | --- |
| `odu cache create <bucket> [--no-upstream]` | Create a bucket; print its substituter URL and public key. `--no-upstream` takes everything, for a store that is not the builder's | Cache → **Create bucket**, **Skip upstream paths** off |
| `odu cache list` | List buckets | Cache |
| `odu cache use <bucket>` | Print the substituter and key settings, the `nixConfig` block, and the netrc lines. No account for a public bucket | a bucket page's block |
| `odu cache domain <bucket> <name>\|--none` | Give a bucket a DNS name of its own, or take it away | bucket → **Domain** |
| `odu cache token mint <bucket> --write\|--read\|--admin` | Mint a token, printed once | bucket → **Mint token** (write or read) |
| `odu cache token list` | List tokens with scope, expiry and last use | bucket → Tokens |
| `odu cache token revoke <id>` | Revoke one token | bucket → Tokens → **revoke** |
| `odu cache login <origin>` | Save a token for an origin in `~/.config/odu/cache/credentials` | — (a machine's disk) |
| `odu cache push <bucket> <paths…> [--wait] [--part-size MiB]` | Upload only the paths the bucket is missing; holds are reported, `--wait` stays until they land | — (a build box's job) |
| `odu cache pin <bucket> <name> <paths…>` | Pin a closure against garbage collection | bucket → **Pin closure** |
| `odu cache gc [bucket]` | Evict objects past retention that nothing references and no pin holds | bucket → **Run GC** |
| `odu cache stats` | Show storage and hit counts | bucket → Stats |
