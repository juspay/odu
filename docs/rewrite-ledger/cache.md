# Ledger: `website/src/content/cache.md`

- Rewritten from: `21bb94d` (`website/src/content/cache.md`, 10,216 words of running text).
- Split into the pages below. `/docs/cache/` is now the cache start page (`cache/index`), and every old `##` anchor on it that is not a heading there is a `<span id>` on a row of its page map.
- This ledger is committed while the PR is open and deleted before merge.

## Headings

Every heading of the old page (`.waterfall/old-anchors-cache.txt`), and where its content went.

| Old heading | New home |
| --- | --- |
| Reads leave odu | `cache/how-it-works` "Reads leave odu"; the narinfo backfill → `cache/operations` |
| Nix binary cache (h1) and the intro | `cache/index` (title kept); signing and the kept NAR → `cache/how-it-works`; loopback and nginx → `self-host` |
| Create a bucket | `cache/index` "Create a bucket" (same anchor) |
| Use it | `cache/index` "Use it" (same anchor) |
| Private buckets | `cache/index` "Private buckets" (same anchor); the 404 reason → `cache/how-it-works` |
| A NAR is a redirect | `cache/how-it-works` "Why a NAR is a redirect"; the `endpoint` caution → `cache/s3` |
| Push | `cache/push`; the anchor is a map row on `/docs/cache/` |
| Compared with `cachix push` and `attic push` | `cache/push` "Compared with `cachix push` and `attic push`" (same heading) |
| Push from GitHub Actions | `cache/github-actions` (title verbatim); the anchor is a map row on `/docs/cache/` |
| From `attic push` | `cache/github-actions` "From `attic push`" (same heading) |
| Tokens | `cache/tokens`; the anchor is a map row on `/docs/cache/` |
| Keep and reclaim | `cache/retention`; the anchor is a map row on `/docs/cache/`. The bucket page's layout paragraph → `cache/reference` "The board's Cache view" |
| Delete a bucket | `cache/retention` "Delete a bucket" (same heading) |
| Keep a bucket on S3 | `cache/s3`; the anchor is a map row on `/docs/cache/` |
| Set up an R2 bucket | `cache/s3` "Set up an R2 bucket" (heading verbatim; `skills/odu/SKILL.md` and `nix/module.nix` name it) |
| A public URL for a store | `cache/s3` "A public URL for a store" (same heading) |
| Move a bucket to another store | `cache/s3` "Move a bucket to another store" (same heading) |
| A domain for a bucket | `cache/domain`; the anchor is a map row on `/docs/cache/` |
| Create the Cloudflare token | `cache/domain` "Create the Cloudflare token" (same heading) |
| Give it to odu | `cache/domain` "Give it to odu" (same heading) |
| Set the domain | `cache/domain` "Set the domain", "Check that it is live" |
| Remove it | `cache/domain` "Remove it" (same heading) |
| What it does not do | `cache/domain` "What a domain does not do" |
| Where the data lives | the model → `cache/how-it-works`; files, `<state>`, the service's home, sizing, backup and the migration → `cache/operations`. The anchor is a map row on `/docs/cache/` |
| Operating it | `cache/operations` "Log lines"; the anchor is a map row on `/docs/cache/` |
| Protocol | `cache/protocol`; the anchor is a map row on `/docs/cache/`. Priority 41 and the `/cache` literal → `cache/how-it-works` |
| The cache describes itself | `cache/protocol` "The cache describes itself" (same heading); "Naming a cache is trusting it" → `cache/push`; the object rewrite → `cache/operations` |
| The Cache view | `cache/reference` "The board's Cache view"; "Kept by" → `cache/retention`. The anchor is a map row on `/docs/cache/` |
| Command reference | `cache/reference`; the anchor is a map row on `/docs/cache/` |

## cache/how-it-works

- Kind: explanation. Reader: anyone asking why.
- Written from: the model part of "Where the data lives", "Reads leave odu", "A NAR is a redirect", the priority-41 and `/cache`-literal paragraphs of "Protocol", the direct and staged upload paragraphs of "Push", the 404 reason of "Private buckets", the read-clock reason of "Keep and reclaim", and server-side signing from the intro.
- Fact home: direct and staged uploads.

### Moved

- The `endpoint` must be reachable from clients, and `cache.store.endpoint.unreachable` → `cache/s3` (the caution) and `cache/operations` (the log line).
- The one-time background `CA:` pass over old paths → `cache/operations` (`cache.self_ca.*`).
- What a collection deletes first (narinfo, then NAR, then the path), and the boot sweep of objects with no path → `cache/operations`.

### Cut

| Fact | Tag |
| --- | --- |
| "Every byte used to cross the odu machine's uplink. It no longer has to" | history |
| "On the pod this replaced a 166 GB `/nix/store` of upstream closures nobody pulled from us" | history |
| "A disk store still streams from odu … exactly as before" | history ("as before"); the fact stays |
| "the row it records in SQLite" | implementation; now "odu's database" |
| "One write, no second copy" | implementation |
| "the server reassembles them and the same hash proof decides" | implementation |
| "rather than refreshing a URL" | implementation |
| "Its 100 MB request cap is why pushes are chunked" (in the serving bullet) | duplicate (stated with `--part-size`) |
| "An anonymous read of a private bucket is still 404" (end of "A NAR is a redirect") | duplicate ("Why a private bucket answers 404") |

## cache/index

- Kind: how-to. Reader: someone who wants a cache.
- Written from: the intro, "Create a bucket", "Use it" and "Private buckets", plus the page map. The five bound "Use it" blocks are unchanged (`useCopy.test.ts` passes).

### Moved

- The service binding loopback, `$ODU_WEB_ORIGIN`, and nginx proxying only the cache's paths → `self-host`.
- "keeps the compressed NAR … like Cachix and Attic" → `cache/how-it-works`.
- `packages/cache/src/surface.ts`'s `bucket_create` input → the "Create a bucket" table and `cache/reference` "`bucket_create`".

### Cut

| Fact | Tag |
| --- | --- |
| "ed25519" | implementation (the key's type is in its value) |
| "On a server with a door that is a PROTOCOL read, not a session" | private word; the fact (no account needed) stays |
| "`upstreamKeys: []` is the old `--no-upstream`" | history; the flag never existed in the code |

### Changed because the code disagreed

| Old | New | Decided by |
| --- | --- | --- |
| "A private bucket's facts need a reader, and `odu cache use` says so:" (nothing after the colon) | the refusal, quoted: "if it is private, sign in (`odu auth login`) or set $ODU_TOKEN to a read token", and that a read token in `$ODU_TOKEN` makes it print the block | `packages/cache/src/cli.ts` `useCommand` (both refusal sentences end with that clause) |
| The board's create form sets `public` and `retentionDays` | it creates public buckets only, and leaves retention to the **Retention** panel | `packages/cache/src/face.tsx` (`public: true`; "RETENTION IS NOT A CREATION FORM'S BUSINESS") |
| "the **Create bucket** form, with the same upstream switch" | **Cache** → **New bucket** → **Create bucket**, with **Skip upstream paths** and **where its objects live** | `packages/cache/src/face.tsx` |

## cache/push

- Kind: how-to. Reader: whoever pushes.
- Written from: "Push", "Compared with `cachix push` and `attic push`", and the `cache push` cell of the old CLI reference (`docs.md`). The bound push block is unchanged.
- Fact homes: provenance (`--run`, `--commit`, "Say what built a path"); the push to the flake's cache and why only a saved credential is sent; the "Naming a cache is trusting it" caution (from "The cache describes itself").

### Moved

- Direct and staged uploads, part sizes, presigned URL lifetime → `cache/how-it-works` (calibration).
- "In GitHub Actions there is an action for it" → `cache/github-actions` (linked from the opening of `your-repository` step 4 and from here via "Say what built a path").

### Cut

| Fact | Tag |
| --- | --- |
| "`--wait` is deprecated: it returns at once, and `/held` answers an empty list until the cache row's next major" | history: cache 3.0 removed both (`packages/cache/src/surface.ts` 3.0 note, `packages/cache/src/cli.ts` push options). `contract-versions` keeps the removal. |
| "`--output json` is unchanged: it still answers" | history ("unchanged", "still"); the fields stay |
| "a push aimed at a guessed origin is a push at a URL nobody owns" | rationale |
| "they answer the same question from opposite ends" | rationale |
| "not yet; a later release adds a post-build hook for lane hosts", "Until the hook ships" | roadmap |
| "That client-memory limit is why `odu cache push` exists" | rationale; the advice "Prefer `odu cache push` for large closures" stays |
| "There is no hold to wait for" | history |

### Changed because the code disagreed

| Old | New | Decided by |
| --- | --- | --- |
| `--no-upstream` in the comparison table | `upstreamKeys: []` | `packages/cache/src/cli.ts` (no such flag), `packages/cache/src/surface.ts` (`upstreamKeys`) |
| "`odu cache use main` prints … the credential line": `machine 127.0.0.1 password <your-write-token>` | the netrc lines `odu cache use` prints (on `cache/index` "Use it"), with a write cache token in place of `<your-read-token>`. The old block is not repeated: `use` prints `machine <host:port> password <your-read-token>` | `packages/cache/src/surface.ts` `netrcBlock` (the URL's `host`, port included, and `READ_TOKEN_PLACEHOLDER`) |

## cache/github-actions

- Kind: how-to. Reader: a workflow author.
- Written from: "Push from GitHub Actions", "From `attic push`", and the step 4 bullets of `docs.md` "Use odu from your repository". The bound Actions push block is unchanged.
- Fact home: the action's `pin:` input. What a pin is → `cache/retention`; `odu:pin` in recipes → `your-repository`.

### Moved

- "[Use odu from your repository] is the consumer's whole of it" → the link to `your-repository` sits in "`pin`".

### Cut

| Fact | Tag |
| --- | --- |
| "`check.sh`" | implementation |
| "They cannot be derived any more: a bucket whose reads are served from a store answers `GET` at an address that takes no push at all" | history ("any more") and rationale |
| "The action holds none of its own beyond a default" | rationale |
| "Where *odu itself* comes from is decided by odu's flake, which the pusher build accepts and does not overrule" | implementation |
| "not from its human output" | implementation |
| "the pin is the pusher" | duplicate (the revision you pin builds the pusher) |

### Changed because the code disagreed

| Old | New | Decided by |
| --- | --- | --- |
| "minted on the bucket's page (**Tokens → Mint**, scope *write*)" (`docs.md` step 4) | **Tokens** → **Mint token**, with scope `write` | `packages/cache/src/face.tsx` (button `Mint token`) |
| "Each row it stores records `$GITHUB_SHA` as the commit that built it" (`docs.md` step 4) | `$GITHUB_SHA`, except on `pull_request`, where it is the pull request's head commit | `.github/actions/push/push.sh` (reads `.pull_request.head.sha` from the event), `src/pushAction.test.ts` ("states the pull request's HEAD sha") |

## cache/tokens

- Kind: how-to. Reader: a bucket's administrator.
- Written from: "Tokens".

### Moved

- Where the database is → `cache/operations` (the old link to "Where the data lives").
- Roles in server mode → one table on `server-mode`; this page keeps what a member may and may not do in the cache.

### Cut

| Fact | Tag |
| --- | --- |
| "On a server with a door", "On a daemon with no door" | private words; now "in server mode", "without server mode" |
| "because that is what this daemon's administration checks" | rationale |
| "the board draws them none of those controls" | private word ("draws"); now "shows a member none of those controls" |
| "Pushing does not change" | history; now "Pushing is the same in both" |

### Changed because the code disagreed

| Old | New | Decided by |
| --- | --- | --- |
| "a bucket page's **Tokens** section mints one" | the **Tokens** panel's **Mint token** button | `packages/cache/src/face.tsx` |

## cache/retention

- Kind: how-to. Reader: a bucket's administrator.
- Written from: "Keep and reclaim", "Delete a bucket", the "Kept by" paragraph of "The Cache view", and "Disk does not grow forever" from `docs.md` "Self-host on NixOS".
- Fact homes: retention, the dry run, the daily collection, and what a pin is.

### Moved

- Why a read does not renew retention → `cache/how-it-works` (linked).
- The bucket page's two-column layout → `cache/reference` "The board's Cache view".
- `bucket_delete` returning objects and bytes, and its refusals → also one entry in `cache/reference`.

### Cut

| Fact | Tag |
| --- | --- |
| "the override is a row the plan makes up for the length of the answer" | implementation |
| "so a dry run at a retention nobody agreed to cannot become a collection by another name" | rationale |
| "never a service's XML" | implementation |
| "drawn as the red line in the GC box" | visible on screen; kept as "shown in red in the **Garbage collection** panel" |
| "The write lock is held for the plan and for each batch's decision, never across a delete" | implementation; the reader's fact stays: "A push lands while a collection runs, without waiting for it" |
| "and with no CDN in front nothing is purged because nothing was cached" | duplicate |
| "goes solid red once you have" (delete button), "lights up" | visible on screen |
| "a temp a dead put left" | implementation |
| "because it was never this bucket's token" | rationale |
| "or the delete would race it" | rationale |
| "(closing any open package, whose versions were read beside the old answer)" | implementation |
| "because every cell is a sentence about that number" | rationale |
| "the column and `cache_gc_run` read one function" | implementation; kept as "the same one `gc_run` acts on" |

### Changed because the code disagreed

| Old | New | Decided by |
| --- | --- | --- |
| "the **dry run retention days** field beside the button, placeholder 'its own'" (both pages) | the **retention** field, placeholder `bucket's (90d)` (the bucket's own number) | `packages/cache/src/face.tsx` (field label `retention`, placeholder `` `bucket's (${retentionDays}d)` ``) |
| Kept-by cell "**pin release**" | `pin <name>`, as in `pin release` | `packages/cache/src/face.tsx` (`` `pin ${name}` ``) |

## cache/s3

- Kind: how-to. Reader: an operator.
- Written from: "Keep a bucket on S3", "Set up an R2 bucket", "A public URL for a store", "Move a bucket to another store", and the `endpoint` bullet of "A NAR is a redirect".
- Fact home: S3 stores. R2 set-up is two numbered lists, dashboard and `cf`. The store comparison table is unchanged apart from "never — always there" → "never: always there" and "the CLIENT" → "the client".

### Moved

- `cache.store.endpoint.unreachable` → `cache/operations` "Log lines". The caution about a client-unreachable `endpoint` is a blockquote here.
- The narinfo backfill at start → `cache/operations` "What the service does at start".

### Cut

| Fact | Tag |
| --- | --- |
| "Since reads left odu", "The store's `endpoint` is now a CLIENT's address" | history ("since", "now") |
| "(eviction, OOM, `kill -9`)" | implementation |
| "A move that flipped first would be a substituter that 404s everything until the copy caught up" | rationale |
| "the move's own row survives a restart" | implementation; kept as "A move resumes after a restart" |
| "The cloudflare row has no R2 API: it binds tunnels, creates DNS records and purges the edge, and it is untouched by this" | implementation; kept as "odu does not bind the domain: you do" |
| "because a domain that is still propagating must not take the cache down" | rationale; kept as "because a domain may still be propagating" |
| "whatever odu's own routes decide" | rationale |

### Changed because the code disagreed

| Old | New | Decided by |
| --- | --- | --- |
| "Uploads still go through odu; sending them straight to the store is a later release" | cut. A push to an S3 store sends its bytes straight to the store (`writesTo: "store"`), as `cache/how-it-works` says. A move (`bucket_migrate`) copies through odu, which the move's steps now say. | `packages/cache/src/staging.ts` (`uploadMode` is `direct` when the store can presign parts), `packages/cache/src/migrateStore.ts` (`copyOne` reads from the old store and puts to the new one) |
| "pick a store under **Where to move it**" | **where to move it** | `packages/cache/src/face.tsx` (fieldset legend) |
| "the **Create bucket** form offers the declared stores" | **New bucket** offers them under **where its objects live** | `packages/cache/src/face.tsx` |

## cache/domain

- Kind: how-to. Reader: an operator.
- Written from: "A domain for a bucket" and its five subsections, and the domain paragraph of `docs.md` "Self-host on NixOS".
- Fact home: a bucket's own domain. The code block keeps its `kolu` / `cache.kolu.dev` example, and the prose follows it.

### Cut

| Fact | Tag |
| --- | --- |
| "(as it does `nix` only during a migration)" | implementation |
| "rather than a panel that never moves" | rationale |
| "for parity" | rationale |
| "so the daemon's `Host` routing is what keeps the control plane off a substituter's name" | implementation; kept as "odu routes by `Host`" |
| "which are odu's either way" | rationale |
| "lets a Tailscale Funnel retire" | history; kept as "A Tailscale Funnel is then not needed" |

### Changed because the code disagreed

| Old | New | Decided by |
| --- | --- | --- |
| "Private buckets — read with a token — come with teams." | "To limit who reads a bucket, make it private", linking `cache/index` "Private buckets". Private buckets work now, and nothing named teams exists. | `packages/cache/src/cache.ts` (a read of a non-public bucket needs a cache token), `packages/cache/src/surface.ts` (`public` on `bucket_create`); a search of the repository finds "teams" only in GitHub's team membership probe and the `team-*` glob example |
| "refuses the row with Cloudflare's own sentence" | "stops the tunnel part of the service from starting, with Cloudflare's own sentence" | word table ("row"); the behaviour is the old page's |

## cache/operations

- Kind: reference. Reader: an operator.
- Written from: the file layout, `<state>`, the service's own home, sizing, backup and migration parts of "Where the data lives", the narinfo backfill paragraph of "Reads leave odu", the object rewrite of "The cache describes itself", and "Operating it".
- Fact home: the state directory, file layout and what to back up. Every log line, field and `verify_failed` reason is kept, as a table.

### Moved

- "The service needs no `trusted-users` entry and no Nix store" → `cache/how-it-works` "A bucket keeps the NAR it was sent".
- The upgrade steps → `self-host` "Upgrade from a store-backed cache"; this page keeps what the service does.

### Cut

| Fact | Tag |
| --- | --- |
| "the singleton's gate" | implementation; now "the service's lock" |
| "a SIBLING of `odu` rather than a child of it, and deliberately" | capitals and rationale; the fact stays ("beside `odu` rather than inside it") |
| "skipped on one HEAD" | implementation |
| "(it prints a row's operational `info`, and drops host narration)" | private words; now "keeps its other logging quiet" |
| "since reads left odu" | history |
| "a PRIVATE bucket" | capitals |
| "The one record of a bucket whose own rows are gone, so it is what an operator reads afterwards" | kept, shortened to "It is the only record left of the bucket" |

### Changed because the code disagreed

| Old | New | Decided by |
| --- | --- | --- |
| "A `--no-upstream` bucket also stores every upstream-signed closure" | "A bucket created with `upstreamKeys: []`" | `packages/cache/src/cli.ts`, `packages/cache/src/face.tsx` (no such flag) |

## cache/protocol

- Kind: reference. Reader: a tool author.
- Written from: "Protocol" and "The cache describes itself", and the `x-odu-upload` sentence from `docs.md` "Upgrading from a store-backed cache". The routes block and the `Odu-Origin` block are unchanged.
- Fact home: the routes. Direct and staged uploads are explained on `cache/how-it-works` and linked.

### Cut

| Fact | Tag |
| --- | --- |
| "the 2.9 negotiation" | implementation (an internal plan section); the contract version, 4.2, stays |
| "on purpose" | rationale |
| "rather than quietly given the old path" | rationale |
| "ONE multipart upload", "the cache row's 404", "WRITE token" in prose | capitals and private words |
| "in both spellings of it" | kept as "both from odu and in the copy the store holds" |
| "compared by the stored sha256 rather than by length" | implementation |

## cache/reference

- Kind: reference. Reader: anyone.
- Written from: "Command reference", "The Cache view" (what each control does), the bucket page layout paragraph of "Keep and reclaim", and, from `docs.md` "MCP", the cache verb table and the paragraph after it.
- Fact home: the cache's CLI ≡ API verb ≡ board mapping. Cells over 40 words became `###` entries (`odu cache push`, `bucket_create`, `bucket_delete`, `gc_plan`). The rename table is kept as "Verbs renamed since odu 1.5".

### Cut

| Fact | Tag |
| --- | --- |
| "`#/cache`", "`#/cache/<bucket>`" | implementation (URL fragments of the board) |
| "(again to reverse; the header says which way, and so does `aria-sort`)" | visible on screen; kept as "again to reverse" |
| "the order and the paging are the row's too … rather than re-sorting what arrived" | implementation; kept as "**Show 20 more** continues in the same order" |
| "`cache_bucket_paths` takes `group: \"name\"`, and opening a row reads that package's versions with `name`" | duplicate (`contract-versions` 4.5 names `group` and `name`) |
| "because a bucket is mostly one package over and over" | rationale |
| "since the admin CLI retired", "having been retired" | history; the old command names stay in the rename table's lead |
| "Every one was renamed when the cache became a surface served beside the runs rather than behind the service" | history |
| "because a sibling's commands mount under its key — and that argv face" | private words |
| "'what am I about to lose' is a question a report answers too late, and a question nobody asked must not answer in red" | rationale |
| "The bucket rows arrive over the wire the page already holds" | private word ("the wire"); kept as "A push updates it without a reload" |
| "rather than once per NAR" | implementation |
| "drawn from the bucket's own published row" | private words |

### Changed because the code disagreed

| Old | New | Decided by |
| --- | --- | --- |
| "**A name of its own**" (a settings panel) | **Domain** | `packages/cache/src/face.tsx` (panel `Domain`) |
| "roots folded behind *what it holds*" | a pin's roots, ten until **show all** | `packages/cache/src/face.tsx` (no "what it holds" label; `show all ${n}` after `PIN_ROOTS_SHOWN = 10`) |
| "Cache → **Create bucket**, … the **store** field" | **Cache** → **New bucket** → **Create bucket**; the store is chosen under **where its objects live** | `packages/cache/src/face.tsx` |
| "Press **group by name**" | "Click **group by name**" | rule 23 (a control is clicked) |

## Review round 1

- `cache/s3`: the `endpoint` caution names the line odu logs (`cache.store.endpoint.unreachable`, at start, for a loopback or link-local endpoint), as the old page did. Decided by `packages/cache/src/server.ts`.
- `cache/reference` holds the whole `odu cache push` entry and the `bucket_create` field table with its board controls; `cli` and `cache/index` link to them.
- `cache/domain`, `cache/retention`: example names follow rule 26 (`main`, `cache.example.com`, `example.com`).
- `cache/retention` "Pins": who may re-point or delete a pin, in one line, linking to `cache/protocol`.
- `cache/tokens`: how a pusher and a reader send a cache token, linking to `cache/push` and `cache/index`.
- `cache/operations`: `cache.migration.object_failed`, `cache.nar.uploaded` and `cache.narinfo.served` are added, so the table is every line the cache logs. Source: `packages/cache/src/cache.ts`, `staging.ts`, `routes.ts`.
