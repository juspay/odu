# Ledger: `website/src/content/cache.md`

- Rewritten from: `21bb94d` (`website/src/content/cache.md`, 10,216 words of running text).
- Split into the pages below. `/docs/cache/` is now the cache start page (`cache/index`), and every old `##` anchor on it that is not a heading there is a `<span id>` on a row of its page map.
- This ledger is committed while the PR is open and deleted before merge.

## Headings

Every heading of the old page (`.waterfall/old-anchors-cache.txt`), and where its content went.

| Old heading | New home |
| --- | --- |
| Reads leave odu | `cache/how-it-works` "Reads leave odu"; the narinfo backfill → `cache/operations` |
| A NAR is a redirect | `cache/how-it-works` "Why a NAR is a redirect"; the `endpoint` caution → `cache/s3` |

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
