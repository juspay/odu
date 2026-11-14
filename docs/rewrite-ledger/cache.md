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
