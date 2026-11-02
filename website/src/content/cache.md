# Nix binary cache

`odu web` also serves Nix binary caches. The same loopback service that runs CI answers the standard Nix HTTP binary cache protocol, so every Nix client works unchanged.

A bucket is one cache: one substituter URL under the service's origin and one ed25519 public key. The server generates the keypair and signs each narinfo on ingest; a pusher never holds a signing key. Client signatures are kept. By default the cache binds loopback, like the board: `$ODU_WEB_ORIGIN` is the address it listens on, and the NixOS module puts nginx in front of it — proxying the cache's protocol paths only, unless [server mode](../docs/#server-mode) is configured, where the board and `/mcp` are behind the same door. The cache keeps the compressed NAR a pusher sent (like Cachix and Attic) and no Nix store of its own; see [Where the data lives](#where-the-data-lives).

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
❌ /nix/store/…-bad-output refused: the upload was truncated or corrupted
```

A push records each path as it lands. There is no hold to wait for: references are names in the narinfo, not paths the server must already hold. The exit is non-zero only for refusals. The server keeps and serves the upload as it arrived — `nix copy --to` defaults to xz, `?compression=zstd` sends zstd — and `--wait` is deprecated: it returns at once, and `/held` answers an empty list until the cache row's next major.

A NAR larger than `--part-size` (64 MiB by default) is sent in parts, each retried on its own; the server reassembles them and the same hash proof decides. That is what makes a push work through a proxy with a request-size ceiling — Cloudflare's is 100 MB.

`push` asks the bucket which paths it is missing, then uploads only those, with retries. It talks to the cache's HTTP API directly, so it runs on the machine that holds the paths.

In GitHub Actions there is an action for it, and it pushes with the checkout's own `odu`: see [Push from GitHub Actions](#push-from-github-actions).

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
| Skips paths cache.nixos.org already has | yes | yes | yes: the server drops paths signed by an upstream key, `cache.nixos.org-1` by default — or nothing, with `--no-upstream` (which also stores upstream closures, costing disk, for consumers that cannot reach cache.nixos.org) |
| Streams NARs, parallel uploads | yes | yes | yes: `nix store dump-path` through zstd, several paths at a time, retry per path |
| Uploads bypass the server | yes, straight to S3 | no | no; a later release adds it for object storage |
| Dedup | per NAR | per chunk | per NarHash per bucket |
| Pushes every build as it happens | `watch-exec`, `watch-store` | `watch-store` | not yet; a later release adds a post-build hook for lane hosts |
| Client signs with its own key | optional | no | no; the server signs |
| Client to install | cachix | attic | odu itself, or nothing: use `nix copy` with netrc |

Until the hook ships, a CI job pushes only the closures it names. Plain `nix copy --to` compresses each NAR in memory on the CLIENT before uploading and checks the cache one path at a time; the server keeps and serves the bytes exactly as they arrived (`nix copy --to` defaults to xz, `?compression=zstd` asks for zstd). That client-memory limit is why `odu cache push` exists; prefer it for large closures.

## Push from GitHub Actions

One step, in any repository. The action odu ships pushes with **its own `odu`** — built from the revision you pin the action to, so the pin is the pusher. A bucket page fills the revision in with the commit *its* server was built from, so the pusher matches the cache; a build that cannot say which commit it is from leaves the placeholder.

Then it proves the push. For every path the bucket serves, `check.sh` asks `<substituter>/<hash>.narinfo` — the address a Nix client asks, which is the bucket's own domain when it has one — reads the narinfo's `URL:` and `FileSize:`, and requires the NAR to answer `200` with a matching `Content-Length`. Plain HTTP throughout, so no local narinfo cache can answer for the bucket, and an object truncated by a proxy's body cap is caught rather than counted as landed.

```yaml
# .github/workflows — with Nix installed in an earlier step
- uses: juspay/odu/.github/actions/push@<odu-revision>
  with:
    origin: https://odu.example.com
    bucket: main
    token: ${{ secrets.ODU_CACHE_TOKEN }}
    paths: |
      .#your-package
```

`paths` takes store paths, `result` links, or flake installables, space- or newline-separated; installables are built first. A bucket page prints this block filled in with its own origin and name under **Push from GitHub Actions**.

**Nix must already be on the runner.** The action never installs it — the `extra_nix_config` block above is the `nix_conf` of whichever install step you already run.

**Your build is yours.** The installables named in `paths` are built with `--accept-flake-config` and nothing else: your flake's `nixConfig` and the runner's own configuration. The action adds no substituter and no key to a build it does not own. Where *odu itself* comes from is decided by odu's flake, which the pusher build accepts and does not overrule.

The token rides in an input fed from a secret, is never echoed, and is never consulted in an `if`. Leave it empty and the action's answer depends on the event:

| event | no token |
| --- | --- |
| `pull_request` | builds the paths, pushes nothing, says so, succeeds |
| `push` | fails, naming the missing secret — a push is where the job must publish |

The step summary is a table read from the push's own JSON (pushed, already present, skipped upstream, failed), not from its human output.

### From `attic push`

Chutney's workflow, before — a binary to install, a login that reads a JWT, a push:

```yaml
      - name: attic login
        run: attic login chutney https://cache.nixos.asia ${{ secrets.ATTIC_LOGIN_TOKEN }}
      - name: om ci
        run: om ci run --systems "${{ matrix.system }}"
      - name: attic push
        run: attic push chutney:oss result
```

After — the same three steps, with the first and last replaced by one that carries no credential of its own:

```yaml
      - name: om ci
        run: om ci run --systems "${{ matrix.system }}"
      - uses: juspay/odu/.github/actions/push@<odu-revision>
        with:
          origin: https://cache.kolu.dev
          bucket: chutney
          token: ${{ secrets.ODU_CACHE_TOKEN }}
          paths: result
```

What changes in behaviour, not just in spelling:

| | `attic push` | the odu action |
| --- | --- | --- |
| Client to install | the `attic` binary | none: the action builds the pusher from its own pin |
| Credential | `attic login`, which writes a token to a profile | an input, from a secret |
| Upstream-signed paths | filtered client-side by config | dropped by the bucket in its `missing` query |
| Did it land? | trust it, or `nix path-info` against the cache | every served path's narinfo is asked over HTTP; a miss is red and named |
| What a maintainer reads after a run | attic's log | a table in the step summary, from the push's JSON |

Chutney's `attic` cache is `chutney:oss` — a cache and a sub-cache. An odu bucket is one cache, so the migration is a bucket named for the project (`chutney`), and its upstream filter is what `oss` was for.

## Private buckets

A public bucket reads without a token. Reads from a private bucket need the same credential as a write: netrc for `nix copy` and substitution, or `Authorization: Bearer <token>` for HTTP clients. Writes always need a token.

An unauthenticated read of a private bucket answers **404**, not 401: "you need a token" would confirm the bucket exists, and a private name must not be enumerable. A caller who presents a token that is wrong, revoked, expired or scoped elsewhere gets 403.

## Keep and reclaim

```sh
odu cache pin main release-1.2 ./result
odu cache gc main
odu cache stats
```

On the board: a bucket page's **Pin a closure**, **Run GC** and **Stats** sections. Pins are named and root a closure. Garbage collection applies per-bucket retention on last access: an object is evicted only when nothing retained in the bucket references it and it is not under a pin. `odu cache stats` reports the objects, their bytes on disk and hit counts.

## Where the data lives

The cache keeps **the compressed NAR the pusher sent**, once, and no Nix store of its own. That is the Cachix/Attic model: an object is a content-named file (`<bucket>/nar/<narHash>.<ext>`, where the extension is the stored compression), references are names in the narinfo, and nothing is imported. On the pod this replaced a 166 GB `/nix/store` of upstream closures nobody pulled from us.

- A push assembles (or receives) `nar/<narHash>.<ext>`, decompresses and hashes it against the narinfo's `NarHash`, then **keeps the file** and records its sha256 and length as `FileHash:`/`FileSize:`. One write, no second copy; the same NarHash+compression keeps the existing file, and twins share one object until GC deletes it with the last row.
- Serving is the file, with `Content-Length` and `Range`: Cloudflare's 512 MB per-file CACHE limit means larger objects are served uncached through the tunnel, not refused — and its 100 MB request cap is why pushes are chunked. A 634 MB NAR pulls through a cold edge. The server never re-dumps or re-compresses a path per reader.
- A narinfo whose references are absent is recorded anyway: references are names, not paths a store must hold first. A `.drv` path, or a reference to one, is still refused with 400.
- `CA:` is **proved from the object we hold**: odu recomputes Nix's `fixed:r:sha256` store path from (name, references and bytes) and serves the line only when the formula reproduces the path. A non-self row uses its NarHash; a self-referencing row uses Nix's hash-modulo-self-references, computed while the NAR streams through verification. Old rows get a one-time background pass after the cache is serving (two workers, progress logged), and the verdict is persisted so a row is read once. Nothing is taken from the pusher.
- GC deletes the object with its row; an object with no row (a crash between put and record) is swept at boot and logged.
- **The one-time migration.** A deployment upgrading from the store-backed cache has rows whose object is not on disk. After the cache is mounted and serving, two at a time, odu dumps each from the old store (`$ODU_CACHE_STORE`, or the host's own `/nix/store` when unset) into the object store. It pauses below 10 GiB free and re-checks every minute, resuming without a restart. Until a row's object lands, its NAR is served through the old store (logged as `source: transition`); a row the old store does not have answers 404 and is named once. A row whose object is missing or unreadable is retried by the next boot's background work, not by a request. The log line `cache.migration.complete` says every row has its object and the old store can be deleted. On the module shape the old store is the host's `/nix/store`: delete the abandoned roots under `<state>/cache/gcroots`, then let `nix-collect-garbage` reclaim the paths; do not delete `/nix/store`.
- **Sizing.** Disk is the compressed objects plus staging for the largest in-flight NAR; memory is constant per NAR, not proportional to its size. A `--no-upstream` bucket also stores every upstream-signed closure it is pushed, so budget that disk deliberately.

```text
<state>/cache/cache.sqlite            metadata, bucket signing keys, token hashes, pins
<state>/cache/objects/<bucket>/nar/   the objects: <narHash>.<ext>, immutable
<state>/cache/staging/                uploads between their NAR and their narinfo
```

An upload sits in `staging/` until its narinfo arrives; one that never gets it is swept after an hour, so a client killed between the two PUTs cannot leak a NAR. Back up the database **and** `objects/`: the bytes are not rebuilt from anywhere else.

`<state>` is `$ODU_STATE_DIR` if set, else `$XDG_STATE_HOME/odu` (`~/.local/state/odu` by default) on Linux and `~/Library/Application Support/odu` on macOS, the same place as the run catalog. Tokens are stored only as hashes, so a copy of the database cannot be used to push. The signing keys are in it, so treat it as a secret.

**The daemon's own home is the one thing that is not under `<state>` by default.** It holds the singleton's gate and control socket, and its name is derived from the origin — `odu-web` at the default origin, `odu-web-<hash>` at any other, so two services cannot share one. Without `$ODU_STATE_DIR` it is `$HOME/.local/state/odu-web*`: a SIBLING of `odu` rather than a child of it, and deliberately not under `$XDG_STATE_HOME` — that variable varies by launch context (a login shell, a bare ssh, a systemd unit), and two contexts computing two "state" homes would split one daemon's identity. Set `$ODU_STATE_DIR` and the home moves inside it, which is what a container with a read-only `$HOME` wants.

The service needs no `nix.settings.trusted-users` entry and no Nix store: it never imports a path. Running all of this on a NixOS host, with the state under `/var/lib/odu` and nginx in front, is [Self-host on NixOS](../docs/#self-host-on-nixos).

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
4. starts the `cloudflared` connector as a child of the daemon (as it does `nix` only during a migration).

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

## Operating it

Watch these lines on a foreground `odu web` (it prints a row's operational `info`, and drops host narration):

- `cache.migration.start` / `.progress` / `.pause` / `.resume` / `.complete` / `.incomplete` — objects, NAR bytes, free space. On `incomplete`, the rows it names have no object and no old-store copy: their NAR answers 404 until re-pushed.
- `cache.self_ca.start` / `.progress` / `.complete` — the one-time self-reference proof pass, with rows, bytes, proved/refused/unreadable.
- `cache.nar.served` — path, bytes actually written, ms, `source` (`file`/`object`/`transition`), `cancelled`.
- `cache.nar.unavailable` — no object and the old store lacks it; served as 404 once per path.
- `cache.boot.orphans`, `cache.boot.ca` — sweep and metadata-CA counts at boot.
- `cache.import.recorded`, `cache.request.refused`, `cache.object.put_failed`.

## Protocol

One bucket is one substituter. Point any Nix-compatible tool at these routes:

```text
GET  /cache/<bucket>/nix-cache-info             StoreDir, WantMassQuery: 1, Priority: 40
HEAD /cache/<bucket>/<hash>.narinfo
GET  /cache/<bucket>/<hash>.narinfo
GET  /cache/<bucket>/nar/<narHash>.<ext>       the object file, Content-Length + Range
PUT  /cache/<bucket>/nar/<narHash>.<ext>         Bearer or Basic; any ext Nix sends
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
| `odu cache create <bucket> [--no-upstream]` | Create a bucket; print its substituter URL and public key. `--no-upstream` takes everything, including upstream-signed closures (costs disk; for consumers that cannot reach cache.nixos.org) | Cache → **Create bucket**, **Skip upstream paths** off |
| `odu cache list` | List buckets | Cache |
| `odu cache use <bucket>` | Print the substituter and key settings, the `nixConfig` block, and the netrc lines. No account for a public bucket | a bucket page's block |
| `odu cache domain <bucket> <name>\|--none` | Give a bucket a DNS name of its own, or take it away | bucket → **Domain** |
| `odu cache token mint <bucket> --write\|--read\|--admin` | Mint a token, printed once | bucket → **Mint token** (write or read) |
| `odu cache token list` | List tokens with scope, expiry and last use | bucket → Tokens |
| `odu cache token revoke <id>` | Revoke one token | bucket → Tokens → **revoke** |
| `odu cache login <origin>` | Save a token for an origin in `~/.config/odu/cache/credentials` | — (a machine's disk) |
| `odu cache push <bucket> <paths…> [--part-size MiB]` | Upload only the paths the bucket is missing; the bucket keeps what it takes | — (a build box's job) |
| `odu cache pin <bucket> <name> <paths…>` | Pin a closure against garbage collection | bucket → **Pin closure** |
| `odu cache gc [bucket]` | Evict objects past retention that nothing references and no pin holds | bucket → **Run GC** |
| `odu cache stats` | Show storage and hit counts | bucket → Stats |
