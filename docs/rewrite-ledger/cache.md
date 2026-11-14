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
