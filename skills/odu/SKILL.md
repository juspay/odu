---
name: odu
description: Drive CI with `odu` — one shared service, reached from a terminal (`odu surface`), from an agent (`odu mcp`), or from a browser. Trigger when the user asks to "run CI", "run the pipeline", "re-run a check", to run named lanes or recipes (e.g. "run fmt and nix", "just the e2e lane", bare selectors like `fmt`/`nix`/`e2e`), or names a recipe by `<recipe>@<platform>`. This skill — not a repo's local `just ci` / `just <recipe>` — is how an odu-run request is served, whichever face you are on.
---

# odu

[`odu`](https://github.com/juspay/odu) (Tamil ஓடு — "run") runs a repository's
`just` recipe DAG tagged `[metadata("ci")]` across machines, posts a GitHub
commit status per `<recipe>@<platform>`, and keeps every run in a per-user
catalog.

**There is one shared service and one vocabulary.** A per-user singleton
(`http://127.0.0.1:18440`) owns every run and every Nix binary cache bucket.
Three faces project the same verbs — and none of them has a verb of its own:

```
run_start · run_wait · run_read · run_list · run_retry · run_cancel · log_read
catalog_import · catalog_prune · pipeline_read
venue_probe · venue_hold · venue_release · protect_apply
cache_bucket_create · cache_bucket_list · cache_bucket_describe · cache_bucket_paths
cache_bucket_domain · cache_bucket_retention · cache_bucket_migrate · cache_bucket_delete
cache_token_mint · cache_token_list · cache_token_revoke
cache_pin_create · cache_pin_list · cache_pin_delete
cache_gc_plan · cache_gc_run · cache_stats_read
cloudflare_status_read
metrics_token_mint · metrics_token_list · metrics_token_revoke
auth_user_whoami · auth_user_grant · auth_grant_list
auth_token_create · auth_token_list · auth_token_revoke
auth_session_list · auth_session_end
```

The cache's verbs are a ROW of their own — the daemon serves it beside the runs
— so their names carry its word (`cache_`) and then the thing and the act. The
`auth_` verbs are the door's row, and only exist when the server has one (see
"Signing in" below).

| Face | Spelling | Who uses it |
| --- | --- | --- |
| terminal | `odu surface <verb> --input '{…}' --json` | you, with shell access |
| agent | MCP tools of the same names | you, in an MCP host |
| browser | `odu web` | the human |

The two spellings below are the same call. Use whichever face you have; never
mix vocabularies, and never reach for a face-specific workaround.

> **A request to run CI is a request to run `odu` — never `just ci`.** Many
> consuming repos expose a `just ci` (or `just <recipe>`) that runs a pipeline
> locally. Do **not** shell out to it: it bypasses everything odu gives you —
> the durable run record, per-node GitHub statuses, structured failures with
> addressed evidence, fail-fast, retry and cancel. "run CI", "run fmt and nix",
> "re-run the e2e lane" all mean *drive an odu run through the verbs below*.

**Run keys are host-global.** Every address is a run id or a key built from one
— never a path relative to whoever is calling. Your cwd is not a fact about
what the user meant, so `run_start` takes the checkout as an explicit absolute
path, and `run_start` is the only verb a filesystem path appears in at all.

**The face holds no run authority.** Every call goes over the wire to the
singleton. A harness restarting your MCP server kills nothing, two agents are
two clients of one truth, and the run outlives whoever started it.

---

## The loop

```
1. bootstrap   — a face, once, unpinned from upstream
2. run_start   — absolute checkout + expectedSha + YOUR requestId
3. run_wait    — bounded; feed the returned cursor back as `after`
4. log_read    — on a failure's logKey, echoed verbatim
5. run_retry   — same commit; a NEW commit is a new run_start
6. verify      — scope, sha, contentSha, reportingDebt, before you say "green"
```

### 1. Bootstrap

Nix is the only supported way to run odu, and the reference is **unpinned
upstream**. `--accept-flake-config` is not optional for an agent: odu's flake
declares a binary cache, and without the flag `nix run` stops on an interactive
trust prompt your tool call cannot answer.

```sh
nix run --accept-flake-config github:juspay/odu -- web --background
```

Every face bootstraps for you: `odu surface …` and the MCP bridge dial the
singleton and, **at the default origin only**, start one and verify it is ready
before issuing your call. So in practice you just issue the verb. Run `web
--background` explicitly when you want the service up before the first verb, or
want its URL to hand the human.

- Bare `odu web` **serves in this terminal until Ctrl-C**. Never run it from a
  tool call — it will block until your timeout. `--background` is the agent's
  spelling.
- A face **never** recovers a failed dial by executing locally. If bootstrap
  fails you get exit 3 and a reason, not a silent local run.
- An `--origin` naming somewhere OTHER than your own service is dialled and only
  dialled — a typo reports "nothing is serving there" rather than spawning a
  daemon that could not bind that address anyway. Your own origin still
  bootstraps, whether it is the default or one `$ODU_WEB_ORIGIN` moved.

### 2. Start

```sh
odu surface run_start --input '{"checkout":"/abs/path/to/repo","expectedSha":"'"$SHA"'","requestId":"fix-lint-1"}' --json
```

```jsonc
// MCP tool: run_start
{ "checkout": "/abs/path/to/repo", "expectedSha": "<sha>", "requestId": "fix-lint-1" }
// optional: selectors[], platforms[], hostPins[], root, noDeps,
//           noStrict, noSnapshot, noPost, supersede
// hostsFile is a terminal's own $ODU_HOSTS. Omit it — you have no shell,
// and omitting it keeps the service's configured inventory.
```

`selectors` are `recipe[@platform]` — `["ci::e2e"]`, `["fmt","nix"]`,
`["ci::unit@x86_64-linux"]`. Empty means the whole `[metadata("ci")]` DAG on
every configured platform. `platforms` slices the fanout; `noDeps` runs only
the named nodes.

- **`checkout` is absolute and explicit.** Read it from the repo you are working
  in; do not pass a relative path and do not assume the service shares your cwd.
- **`expectedSha` is a hard check.** A checkout that has moved on is refused
  (`checkout_refused`), never quietly a different run.
- **`requestId` is mandatory, and that is the feature.** See below.
- A checkout that already has a live run does **not** get a second one, and this
  is an ANSWER rather than a refusal: you get `accepted: false` with `existing`
  naming the run that is already there. Observe it, or repeat the call with
  `supersede: true` — which cancels the WHOLE live run in that checkout.

The receipt carries `runId`, `requestId`, `sha`, `scope`, a usually-null
`endpoint` (the coordinator has not bound its socket yet), and a `cursor`
positioned at the run's beginning — pass that cursor straight into your first
`run_wait` so you resume rather than replay.

**A run pushes what it builds, and nothing in the repository says so twice.**
The `extra-substituters` line already in `flake.nix` `nixConfig` — the line a
consumer keeps in order to READ from a bucket — is the whole declaration;
`run_start` resolves it, and every recipe's `result*` closure is pushed to the
one odu cache the serving daemon has. There is no request field, no flag, no
recipe step and no token in the tree: do NOT add `odu cache push` to a justfile
to get this. `run_read` answers `push` — the bucket and how much landed, or
`target: null` and a `skipped` reason saying why nothing was pushed (no flake, no odu
cache named there, or one this daemon does not serve). A push that fails makes
that node RED, so a green run means the cache is warm. Two odu caches this
daemon serves is a `checkout_refused` at start naming both: a repository builds
for one cache.

**Lost replies are why `requestId` exists.** Mint one id per *intent*, never per
attempt. If a reply is lost — a timeout, a killed tool call, a restarted harness
— repeat the call with **the same id and the same input**: you get the recorded
receipt back with `replayed: true`, and no second run. A fresh id is a licence
to run twice; never mint one to "retry a call". Two rules follow:

- `request_conflict` — that id was used for a *different* input. Pick a new id
  for the new intent, or resend the original input.
- `request_unresolved` — the request was accepted and its outcome is genuinely
  unknown. Do **not** re-issue it with a new id. Look for the run
  (`odu surface keys runs` / `get runs`, or the board) and reconcile from what
  is actually there.

### 3. Wait — bounded, resumable, fail-fast

```sh
odu surface run_wait --input '{"runId":"'"$RUN"'","after":"'"$CURSOR"'","deadlineMs":120000}' --json
```

```jsonc
// MCP tool: run_wait
{ "runId": "<run>", "after": "<cursor>", "deadlineMs": 120000 }
// optional: settle (wait for the whole run), limit (page size)
```

`reason` is what you branch on:

| `reason` | Meaning | Next move |
| --- | --- | --- |
| `failure` | A red node whose evidence is ready. **A normal result, not an error.** | Read `failures[].excerpt`, then `log_read` its `logKey`. Start fixing now. |
| `still_running` | The deadline passed with nothing red. | Ask again with the returned `cursor` as `after`. |
| `settled` | The whole run is done. | Verify (step 6). |
| `owner_lost` | The coordinator is provably gone without finalizing. | Start a fresh run. |

**Fail-fast is the point.** `run_wait` returns on the first *actionable* red —
a failure whose log has had its last word — while the slow lanes keep running.
`failures[]` is a floor, not the final tally: more lanes may still go red. Do
**not** sit through the remaining lanes to "see the full status", and do not pad
`deadlineMs` and block. The loop is wait → fix → wait again.

**`passed: true` is only trustworthy with `settled: true`.** Never infer green
from a bounded wait that saw nothing red.

**Feed the cursor back.** Every answer carries a `cursor`; pass it as `after`
next time and you are not shown the same events twice. It suppresses repeats and
resolves nothing — a red node you already saw is still red. A cursor from
another run is refused (`bad_cursor`) with a `resync` route rather than silently
restarted; that bites hardest after a retry that relaunched (step 5).

**Terminal handling: Ctrl-C ends an OBSERVATION, not the run.** An interrupted
or disconnected wait exits 130 and the run carries on — as does a wait that
simply hit its deadline. Re-attach with `run_wait` and your last cursor.
**Stopping work is an explicit act**: `run_cancel`.

### 4. Diagnose — addressed evidence

```sh
odu surface log_read --input '{"key":"'"$LOG_KEY"'","offset":-4096}' --json
```

```jsonc
// MCP tool: log_read
{ "key": "<logKey from failures[]>", "offset": -4096 }   // negative offset = tail; limit pages
```

- **Echo the `logKey` verbatim.** A run id, a node and an attempt travel as one
  token precisely so no caller reassembles them from parts. Never build a path.
- `complete: false` means the producer's last word is missing — the evidence is
  truncated, not "the recipe was quiet". Say so rather than concluding from it.
- `excerptSource: "none"` on a failure means the log was unreadable. That is
  never a pass and never "flaky".
- Page forward with `nextOffset`; `eof` is about this read, `complete` is about
  the log.
- **`log_read` also FOLLOWS.** Pass `waitMs` and it holds until the log grows
  past the end of this page, the attempt finishes, or the deadline passes. Feed
  `nextOffset` back as `offset` — that is the cursor, and YOU hold it, so a call
  that dies is re-issued rather than resumed. Stop when `open` is false. A
  `size` smaller than the offset you asked for means that attempt was re-run and
  its log rewritten: start again from 0. `odu ci logs -f` / `--wait-ms` is the same
  follow from a terminal.
- Watching a live node instead of reading evidence? Subscribe to the
  `logTails` resource — `surface://collections/logTails/<key>` as MCP, or
  `odu surface get logTails "$KEY" --follow` as ndjson. (`watch` is not mounted
  on `logTails`: it carries no delta verb, because its key set is whatever
  happens to be subscribed rather than a set of runs.) Evidence for a verdict is
  always `log_read`.

### 5. Retry the same commit — or start the new one

```sh
odu surface run_retry --input '{"runId":"'"$RUN"'","selector":"ci::unit@x86_64-linux","requestId":"retry-unit-1"}' --json
```

```jsonc
// MCP tool: run_retry
{ "runId": "<run>", "selector": "ci::unit@x86_64-linux", "requestId": "retry-unit-1" }
// optional guard: expectAttempt { node, attempt }
```

`selector` is `<recipe>@<platform>`, `@<platform>`, or a bare recipe name.

- **Retrying is not your choice to make.** `run_retry` resets nodes on a live
  coordinator when there is one and starts a linked replay run when there is
  not, and tells you which in `mode` (`live` | `relaunched`).
- **Watch `effectiveRun`, not the run you asked about**, and use the receipt's
  `cursor`. A `relaunched` retry is a NEW run; your old cursor belongs to its
  parent and will be refused.
- **Siblings are preserved.** `roots` are the nodes actually reset and
  `resetDependants` their consequence; every other lane keeps running, keeps its
  venue and keeps its statuses.
- `expectAttempt` refuses (`stale_attempt`) if the node moved past the attempt
  you read. Use it when acting on a reading you took a while ago.
- `requestId` is mandatory here too, with exactly the semantics of step 2.

**Retry vs. supersede — the rule that costs the most to get wrong.**

| Situation | Verb | What it does |
| --- | --- | --- |
| One lane failed; same commit | `run_retry` | Re-runs that selector (and its dependants). Cancels nothing. |
| A **new commit** fixes it | `run_start` on the new sha, `supersede: true` if a run is live in that checkout | Replaces the WHOLE run, every lane. |

A new commit is a new run — never a retry, which replays recorded inputs with
the old commit pinned. And superseding to retry a flaky lane throws away the
darwin lane that was still running and green: the expensive operation for a job
the cheap one does.

**Cancelling** is `run_cancel` with an explicit scope — `{"kind":"run"}`,
`{"kind":"node","node":"ci::fmt@x86_64-linux"}` or
`{"kind":"lane","platform":"aarch64-darwin"}` — plus a `requestId`. The answer
echoes what was actually cancelled; `effective: "nothing"` with a `detail` means
nothing was, and is not a cheerful ok.

### 6. Verify before you call CI green

Three checks, every time, from the wait answer or the board row:

- **`scope` — a selection is not a pipeline.** `{selectors, platforms, root?,
  noDeps}`. A green over three recipes is a green over three recipes. Only an
  empty `selectors` and empty `platforms` (and no `noDeps`) is "CI is green".
  Say what you actually ran.
- **`sha` and `contentSha` — are these the inputs you meant?** Compare the base against the commit you asked
  for. A `dirty` run on the board is a verdict about a working tree, not about a
  commit.
- **`reportingDebt` — statuses that did not land.** Debt never blocks settle
  (the test verdict is the truth), but an unwritten required context is what
  blocks a merge. A green run with debt is not a green PR; report it.

And say `passed` only from `settled: true`.

---

## Verb reference

| Verb | argv | MCP tool | Input | Answers |
| --- | --- | --- | --- | --- |
| start | `odu surface run_start --input '{…}' --json` | `run_start` | `checkout`, `expectedSha`, `requestId`, `selectors?`, `platforms?`, `hostPins?`, `hostsFile?` (a terminal's own `$ODU_HOSTS`; agents omit it), `root?`, `noDeps?`, `noStrict?`, `noSnapshot?`, `noPost?`, `supersede?` | `accepted`, `runId`, `replayed`, `sha`, `scope`, `endpoint`, `cursor`, `existing?` |
| wait | `odu surface run_wait --input '{…}' --json` | `run_wait` | `runId`, `after?`, `deadlineMs?` (30s default), `settle?`, `limit?` | `reason`, `settled`, `passed`, `outcome`, `failures[]`, `failuresTotal`, `cursor`, `remaining`, `reportingDebt[]`, `scope`, `sha`, `contentSha?`, `dirty?`, `actor?` (who started it) |
| diagnose | `odu surface log_read --input '{…}' --json` | `log_read` | `key`, `offset?` (negative = tail), `limit?`, `waitMs?` (follow) | `text`, `offset`, `size`, `nextOffset`, `eof`, `complete`, `open` |
| retry | `odu surface run_retry --input '{…}' --json` | `run_retry` | `runId`, `selector`, `requestId`, `expectAttempt?` | `mode`, `effectiveRun`, `parentRun`, `roots[]`, `resetDependants[]`, `scope`, `sha`, `cursor` |
| cancel | `odu surface run_cancel --input '{…}' --json` | `run_cancel` | `runId`, `scope`, `requestId` | `effective`, `detail` |
| read | `odu surface run_read --input '{…}' --json` | `run_read` | `runId`, `after?`, `limit?` | `run_wait`'s answer, without the waiting |

### Beyond one run

The same vocabulary reaches everything else odu does. These used to be local
commands that each did their own work in your process — which meant an agent
and a browser simply could not do them at all. Now every one of them also has a
board control (Machines, Maintenance, New run's Preview pipeline, the Cache
view, People), so a person you hand the result to can repeat it without a
terminal.

| Verb | argv | MCP tool | Input | Answers |
| --- | --- | --- | --- | --- |
| find runs | `odu surface run_list --input '{…}' --json` | `run_list` | `checkout?` (absolute), `sha?` (≥7 hex prefix), `seq?` (needs `sha`), `limit?` | `rows[]` (newest first), `total` — the board filtered by the service, in one call |
| resolve a pipeline | `odu surface pipeline_read --input '{…}' --json` | `pipeline_read` | `checkout`, `root?` | `checkout`, `name`, `tasks[]`, `mermaid` — the DAG, without running it |
| list machines | `odu surface venue_probe --input '{}' --json` | `venue_probe` | *(none)* | `source`, `warnings[]`, `rows[]` — the lanes and who holds them |
| hold a machine | `odu surface venue_hold --input '{…}' --json` | `venue_hold` | `checkout`, `platforms?`, `hostsFile?`, `noWait?`, `requestId` | `results[]` (`held` / `waiting` / `already`), `replayed` |
| release it | `odu surface venue_release --input '{…}' --json` | `venue_release` | `checkout`, `platforms?`, `hostsFile?`, `requestId` | `released[]` (`effective`: `released` / `nothing`), `replayed` |
| import old runs | `odu surface catalog_import --input '{…}' --json` | `catalog_import` | `checkout`, `dryRun?`, `requestId` | `imported[]`, `skipped[]`, `catalog` |
| expire old runs | `odu surface catalog_prune --input '{…}' --json` | `catalog_prune` | `retentionDays?`, `dryRun?`, `requestId` | `expired[]`, `kept[]`, `retentionDays`, `dryRun`, `replayed` |
| require odu's checks | `odu surface protect_apply --input '{…}' --json` | `protect_apply` | `checkout`, `branch?`, `platforms?`, `hostsFile?`, `dryRun?`, `create?`, `requestId` | `repo`, `branch`, `contexts[]`, `rulesetId`, `applied`, `created`, `derivedFrom`, `detail`, `replayed` |
| create a cache bucket | `odu surface cache bucket_create --input '{…}' --json` | `cache_bucket_create` | `rootToken`, `name`, `public`, `retentionDays?` (absent is 90 days), `upstreamKeys?`, `store?` (a declared store; default `local`, `unknown_store` otherwise, and `bad_input` for a PRIVATE bucket onto a store with a `publicUrl` — a bound domain serves every prefix in it) | `name`, `public`, `retentionDays`, `keyName`, `publicKey`, `upstreamKeys[]`, `objects`, `bytes`, `created`, `domain`, `url`, `pushUrl`, `store`, `readsFrom` (`store` the store's own domain answers reads, `odu` the daemon does), `writesTo` (`store` a push uploads straight into the store, `odu` the bytes cross the daemon), `migration` (a store move in flight, or `null`) |
| list buckets | `odu surface cache bucket_list --input '{…}' --json` | `cache_bucket_list` | `rootToken` | `buckets[]` (the shape above) |
| one bucket's public identity | `odu surface cache bucket_describe --input '{…}' --json` | `cache_bucket_describe` | `bucket` — **no root token** | `name`, `public`, `publicKey`, `domain`, `url`, `readsFrom` only — the substituter's identity, not the operator's counts |
| give a bucket a DNS name | `odu surface cache bucket_domain --input '{…}' --json` | `cache_bucket_domain` | `rootToken`, `bucket`, `domain` (omit to clear) | the bucket row; `url` becomes the name and `pushUrl` stays the path |
| change a bucket's retention | `odu surface cache bucket_retention --input '{…}' --json` | `cache_bucket_retention` | `rootToken`, `bucket`, `retentionDays` (days from `lastWanted`; `0` keeps only what is referenced or pinned) | the bucket row |
| move a bucket to another store | `odu surface cache bucket_migrate --input '{…}' --json` | `cache_bucket_migrate` | `rootToken`, `bucket`, `store` (a name from the `stores` resource) | the bucket row, with `migration` on it. The copy runs in the background and the bucket keeps serving from the OLD store until it is done; refused for an undeclared store, the store it is already on, a bucket already moving, and a PRIVATE bucket onto a store with a `publicUrl` |
| delete a bucket | `odu surface cache bucket_delete --input '{…}' --json` | `cache_bucket_delete` | `rootToken`, `bucket` | `name`, `objects`, `bytes` — the store objects removed and what they weighed. The objects go first, then the bucket's rows, its paths, its pins and the tokens scoped to exactly this name (a wider glob like `team-*` is left alone); refused for a bucket with a DOMAIN bound (clear the domain first, so no DNS record points at nothing) and for one with a move in flight |
| one bucket's paths | `odu surface cache bucket_paths --input '{…}' --json` | `cache_bucket_paths` | `bucket`, `filter?`, `after?`, `group?` (`"name"` — one row per PACKAGE), `name?` (one package's versions), `sort?` (`name`/`size`/`pushed`/`reads`), `descending?` — **no root token** | `paths[]` (`storePath`, `narSize`, `created`, `hits`, `lastWanted`) or `groups[]` (`name`, `versions`, `bytes`, `hits`, `pushed`, `wanted`, `storePath` — counted over the WHOLE bucket, not the page), `next?` — 20 a page |
| the last venue probe, kept | `odu surface get venues` | the `venues` resource | *(none)* | `null`, or `at`, `platforms[]`, `source`, `warnings[]`, `rows[]` — what `venue_probe` last answered for the service's own fleet (a probe naming your own `hostsFile` is answered, not kept), so a reader need not dial every machine again |
| the rows a board follows | `odu surface watch cache buckets` | the `buckets` resource | *(none)* | `name`, `public`, `retentionDays`, `keyName`, `publicKey`, `upstreamKeys[]`, `objects`, `bytes`, `created`, `domain`, `url`, `pushUrl`, `lastPush`, `hits`, `store`, `readsFrom`, `writesTo`, `migration` (`{to, state: copying\|flipping\|deleting, copied, total, bytes}`, or `null`) — one row per bucket, published as it moves |
| the stores a bucket can live in | `odu surface get cache stores` | the `stores` resource | *(none)* | `[{ name, kind, default, publicUrl }]` — `local` (the server's disk, `default: true`, `publicUrl: null`) first, then each declared S3 store; never an endpoint or a credential |
| mint a cache token | `odu surface cache token_mint --input '{…}' --json` | `cache_token_mint` | `rootToken`, `bucket`, `scope` (`read`/`write`/`admin`), `expiresDays?`, `bucketGlob?` | `token` (plaintext, ONCE), `facts` |
| list cache tokens | `odu surface cache token_list --input '{…}' --json` | `cache_token_list` | `rootToken`, `bucket?` | `tokens[]` — never a plaintext |
| revoke a cache token | `odu surface cache token_revoke --input '{…}' --json` | `cache_token_revoke` | `rootToken`, `id` | `id`, `revoked` |
| pin a closure | `odu surface cache pin_create --input '{…}' --json` | `cache_pin_create` | `rootToken`, `bucket`, `name`, `paths[]` | `bucket`, `name`, `rootPaths[]`, `created`, `createdBy` — a name that exists is RE-POINTED |
| what the pins hold | `odu surface cache pin_list --input '{…}' --json` | `cache_pin_list` | `rootToken`, `bucket` | `pins[]` (`bucket`, `name`, `rootPaths[]`, `created`, `createdBy`: `write` a push made it, `admin` a person did) |
| drop a pin | `odu surface cache pin_delete --input '{…}' --json` | `cache_pin_delete` | `rootToken`, `bucket`, `name` | `bucket`, `name` — admin only, even where a write token may pin |
| what a collection WOULD take | `odu surface cache gc_plan --input '{…}' --json` | `cache_gc_plan` | `rootToken`, `bucket?`, `retentionDays?` (4.4 — plan as if every bucket in scope kept a path that many days from `lastWanted`; absent is each bucket's own, `0` is only what a reference or a pin holds; a non-integer or negative is `bad_input`. Nothing is written, and `gc_run` deliberately has no such field) | `buckets[]` (`evicted`, `bytes`, `remaining`, `paths[]` — a readable head, oldest want first), `evicted`, `bytes`. THE DRY RUN: read it before `gc_run` |
| reclaim cache space | `odu surface cache gc_run --input '{…}' --json` | `cache_gc_run` | `rootToken`, `bucket?` (absent collects every bucket, and only then sweeps orphans) | `buckets[]` (`evicted`, `kept`, `bytes`, `orphans`), `evicted`, `kept`, `bytes`, `orphans` |
| cache sizes and reads | `odu surface cache stats_read --input '{…}' --json` | `cache_stats_read` | `rootToken` | `buckets[]`, `objects`, `bytes`, `hits`, `lastWanted` (the newest renewal anywhere, or null) |
| the tunnel and its names | `odu surface cloudflare status_read --json` | `cloudflare_status_read` | *(none)* | `tunnel` (`state`, `name`, `id`, `reason`) and `routes[]` (`domain`, `bucket`, `state` `wiring`/`live`/`failed`, `reason`, `updated`) — a route with `bucket: null` is the server's own public origin |
| mint a scrape credential | `odu surface metrics token_mint --input '{…}' --json` | `metrics_token_mint` | `rootToken`, `label?` | `token` (plaintext, ONCE), `facts` — the credential a Prometheus holds for `GET /metrics`, and it opens nothing else |
| list scrape credentials | `odu surface metrics token_list --input '{…}' --json` | `metrics_token_list` | `rootToken` | `tokens[]` (`id`, `label`, `created`, `lastUsed`, `revoked`) — never a plaintext |
| revoke a scrape credential | `odu surface metrics token_revoke --input '{…}' --json` | `metrics_token_revoke` | `rootToken`, `id` | `id`, `revoked` — effective at once, with no restart |
| who am I | `odu surface auth user_whoami --json` | `auth_user_whoami` | *(none)* | `who` — a `user` with a `login` and `role`, or `anonymous` |
| mint a personal token | `odu surface auth token_create --input '{…}' --json` | `auth_token_create` | `name`, `expiresDays?` (absent = never; the profile form defaults to 90) | `token` (plaintext, ONCE), `facts` |
| my tokens | `odu surface auth token_list --json` | `auth_token_list` | *(none)* | `tokens[]` — never a plaintext |
| revoke a token | `odu surface auth token_revoke --input '{…}' --json` | `auth_token_revoke` | `id` | `id`, `revoked` |
| my sessions | `odu surface auth session_list --json` | `auth_session_list` | *(none)* | `sessions[]` (`id`, `created`, `lastSeen`, `expires`, `agent`) |
| end a session | `odu surface auth session_end --input '{…}' --json` | `auth_session_end` | `id` | `id`, `ended` |
| set a role | `odu surface auth user_grant --input '{…}' --json` | `auth_user_grant` | `login`, `role` (`owner`/`admin`/`member`), `rootToken` (checked only when no session authorises it; `""` when one does) | `login`, `role` |
| who is in | `odu surface auth grant_list --json` | `auth_grant_list` | *(none)* — an owner's verb | `people[]` (`login`, `role`, `granted`, `lastSeen`) |

### Cache verbs

**A cache bucket keeps the compressed NAR a push uploaded** (`FileHash`/`FileSize`
are real, `CA:` is proved from name, references and bytes) and keeps no Nix
store: references are names, so a push records a path even when they are not in
the bucket. A bucket's objects live in its **store** — `local` disk, or an
S3-compatible bucket the operator declared (`services.odu.cache.stores`) — chosen
at `cache_bucket_create`, moved afterwards with `cache_bucket_migrate`; every
store holds the whole protocol (`<bucket>/nar/<file>`, `<bucket>/<hash>.narinfo`,
`<bucket>/nix-cache-info`).
Setting up R2 for one (the operator's job, either way; full steps in the cache
docs, "Set up an R2 bucket"):

- **Dashboard:** R2 → create a private bucket; R2 → Manage API Tokens → Create
  Account API token, **Object Read & Write** scoped to that bucket → Access Key
  ID and Secret Access Key, plus the Account ID for the endpoint.
- **`cf` CLI:** `cf auth login`; `cf r2 buckets create --name <bucket>`;
  `cf user tokens create --name … --policies @policy.json` with the
  `Workers R2 Storage Bucket Item Write`/`Read` groups (ids from
  `cf user tokens permission-groups list`) on
  `com.cloudflare.edge.r2.bucket.<ACCOUNT_ID>_default_<bucket>`. Access Key ID =
  the token's `id`; Secret Access Key = SHA-256 hex of its `value`
  (developers.cloudflare.com/r2/api/tokens/). Not `cf accounts tokens create`:
  an OAuth login is refused it (`9109 Unauthorized`, 403).
- **Then:** a credentials file of `AWS_ACCESS_KEY_ID=` and
  `AWS_SECRET_ACCESS_KEY=` lines, and `services.odu.cache.stores.<name> = {
  endpoint = "https://<ACCOUNT_ID>.r2.cloudflarestorage.com"; bucket; region =
  "auto"; credentialsFile; publicUrl?; }` — `publicUrl` being the custom domain
  bound to that bucket, an origin with no path, which public buckets on the
  store are then advertised at.
The cache row is at contract 4.6 (3.0 removed `held` and `--wait`; 3.1 added
`store` and the `stores` resource; 4.0 moved retention onto `lastWanted` — the
old last-access field is gone from a path and from `stats_read` — and added
`bucket_retention`, `pin_list`, `pin_delete`, `gc_plan` and `orphans`; 4.1 added
`readsFrom`, `publicUrl` on a store, `migration` on a bucket row and
`bucket_migrate`; 4.2 added `writesTo` on a bucket row and the push client's
upload negotiation; 4.3 added `bucket_delete`; 4.4 added `gc_plan`'s
`retentionDays`, the dry run's own retention, which `gc_run` does not take; 4.5
added `bucket_paths`' `group`, `name`, `sort` and `descending` — a bucket
counted and ordered by the row rather than by whoever holds one page; 4.6 added
`label` on a token's public half, so the Tokens list says `run <id>` for a
credential odu minted for a run).

- **WRITES LEAVE ODU TOO, on an S3 store.** `odu cache push` asks the bucket
  where a NAR's bytes go before it sends any. A bucket whose store takes its
  own writes answers `writesTo: "store"`: odu signs URLs, the client PUTs the
  NAR to the store itself, and odu then streams the object back, verifies its
  `NarHash`, size and `CA:`, copies it into place inside the store and only
  then records the path — it never signs a hash a client claimed. A disk-backed
  bucket is `writesTo: "odu"` and takes the bytes through the daemon. The push
  reports which it used as `mode` in `--output json`. There is no flag: the
  store decides, and an origin too old to negotiate is refused by name.

- **READS LEAVE ODU WHERE THEY CAN.** A store may declare a `publicUrl` — an
  R2 custom domain the operator bound to the bucket (`cf r2 buckets domains
  custom create <r2-bucket> --domain <host> --zone-id <zone>`; odu binds
  nothing). A PUBLIC bucket on such a store answers `readsFrom: "store"` and a
  `url` of `<publicUrl>/<bucket>`: its reads never reach the daemon, so the
  cache serves while odu is down. Everything else is `readsFrom: "odu"`, and a
  NAR on any S3 store is a **307** to a presigned URL good for ten minutes —
  which is what makes a PRIVATE bucket work too: odu authorises, then the
  store serves, and the client re-sends its own `Range` there. A disk store
  streams from odu as before.

- **RETENTION COUNTS FROM `lastWanted`, which a read does not move.** A path's
  clock is renewed by a stored push and by the `missing` query that named it
  (missing or not); a read moves `hits` and nothing else, because reads are
  leaving odu and a clock a read wound would make the busiest paths the first
  to look idle. 90 days by default, per bucket with `cache_bucket_retention`.
- **Nothing is evicted while retention holds, something retained references it,
  or a pin holds it**, and the reference closure of anything kept is kept. The
  row collects every bucket **once a day on its own**; `cache_gc_run` is that
  same collection asked for sooner, and `cache_gc_plan` is it with nothing
  done. Ask the plan first and read the count and the bytes. The plan alone
  takes `retentionDays` (cache 4.4), a retention to ask about rather than one
  to keep — `0` is "what is here that nothing references and no pin holds" —
  and it writes nothing; `cache_gc_run` takes no such field, so a retention a
  plan asked about can never be one a collection evicts by.
- **A pin is a name over a closure**, re-pointed by pinning the same name
  again. A WRITE token may create or re-point one over HTTP
  (`POST /_odu/v1/buckets/<bucket>/pin`, and `odu cache push --pin NAME`),
  because a token that may push can already keep a closure alive forever by
  pushing it again; deleting a pin stays admin-only.
- **No CLI verb administers a cache at all** (2.10), and this step added none:
  retention, the pins, the dry run and the collection are the board's controls
  and these verbs. `--pin` on `odu cache push` is the one word a shell has in
  it. Do not invent `odu cache retention` or `odu cache gc --dry-run`.

- **`requestId` is an idempotency key on these three too.** A repeat with the
  same id replays the recorded answer and performs nothing — which is what
  stops a lost reply's retry from releasing a hold somebody else has taken
  since, or overwriting a ruleset edited in between. A repeat with the same id
  and DIFFERENT input is `request_conflict`; one whose first attempt's outcome
  is unrecorded is `request_unresolved`, and the answer to that is to read the
  current state, never to re-issue under a fresh id. `replayed` says which you
  got.
- **A hold outlives your session.** `venue_hold` records the lease against a
  *checkout*, and the holder is the service's child rather than yours — so it
  survives your process ending, and you must `venue_release` it. `noWait` gives
  you `waiting` instead of a queue.
- **`protect_apply` writes to GitHub.** Run it with `dryRun: true` first and read
  `contexts` — that is exactly the set odu will require. `derivedFrom` being
  non-null means the platform set came from this machine's hosts file rather
  than from you; a repository's required checks should not depend on whose
  laptop ran the command, so name `platforms` explicitly when it matters.
  `create: true` is needed to make a ruleset that does not exist yet, because
  creating protection nobody asked for is not a recovery. Writing needs a `gh`
  the serving process can authenticate with; without one you get
  `no_credential`, which is fixable rather than fatal — `dryRun` still answers.
- **`catalog_prune` never expires a run with a live owner** — it reports it in
  `kept` with a reason instead.

- **A workflow pushes in ONE step.** `juspay/odu/.github/actions/push@<sha>`
  takes `cache`, `token` and `paths` — `cache` is the SUBSTITUTER URL the
  repository already substitutes from, and the push origin and the bucket are
  read off that cache's `nix-cache-info` (`Odu-Origin`, `Odu-Bucket`), never
  spelled in the workflow. It builds the `odu` it pushes with from the
  revision it is pinned to, and then proves the push where Nix asks: each
  served path's narinfo at the bucket's SUBSTITUTER URL (its domain
  when it has one), and the NAR that narinfo names at the `FileSize:` it
  claims — truncated objects are a narinfo that answers and a NAR that does not.
  Each failure is named and reddens the step. An empty `token` builds and pushes
  nothing on a pull request, and fails a `push` event with the secret to set.
  When asked to add a cache push to a repository's CI, this is the step — not
  `attic login` + `attic push`, and not a hand-rolled `nix run … odu cache
  push` with a token in `env`.
- **One more line keeps a repository's default branch out of GC.** `pin:` is a
  BOOLEAN; the workflow holds the policy and the action holds none:

  ```yaml
      # one more line in the step's `with:`, beside cache/token
      pin: ${{ github.ref_name == github.event.repository.default_branch }}
  ```

  The pin's name is DERIVED — `<owner>/<repo>@<ref>/<system>` — so several
  repositories can share one bucket and a Linux job and a macOS job of the
  same push hold their own closures instead of re-pointing each other's pin.
  Anything falsy pins nothing. When a repository asks "how do we stop our
  master closure being collected", that line is the whole answer.
- **Omit `paths:` and the whole flake is pushed** — every
  `packages.<system>`, `devShells.<system>` and `checks.<system>` output for
  the runner, enumerated by Nix. Name `paths:` to push exactly those instead.

### Metrics

`GET /metrics` is a Prometheus text exposition of the whole daemon — the cache
row's hit rates, bytes and storage (`odu_cache_requests_total`,
`odu_cache_bytes_total`, `odu_cache_paths`, `odu_cache_hits`, …), the
runs' durations (`odu_runs_total`, `odu_run_duration_seconds`,
`odu_node_duration_seconds`) and lane use (`odu_lane_reachable`,
`odu_lane_held`).

It is never anonymous. A scrape carries `Authorization: Bearer` with the root
token or a **metrics token** (`metrics_token_mint`), which opens this route and
nothing else; anything else is `401`. Revocation (`metrics_token_revoke`) takes
effect at once. Counters are process-local and reset on restart — that is
standard, and `rate()` handles it — and they only ever grow within one process:
each run and each journal entry is folded once, never recomputed from a sliding
window. The numbers read from storage are gauges (`odu_cache_paths`,
`odu_cache_bytes`, `odu_cache_pins`, `odu_cache_hits` — a collection lowers that
last one, which is why it is not a `_total`).
`odu_cache_last_gc_timestamp_seconds` is `0` when there has been no collection
since boot.

### Signing in

A server may have a **door**: GitHub sign-in, roles, and personal tokens. You are
told because four things change for an agent.

- **A remote server needs a token.** Set `ODU_TOKEN` to a personal access token
  (its holder mints one signed in — `odu surface auth token_create --input
  '{"name":"laptop"}'` — or on the server's profile page) and pass `--origin`
  (or export `ODU_WEB_ORIGIN`). Every `odu` command and the MCP bridge send it
  as `Authorization: Bearer` on the connection they open. Without one, the
  daemon answers only `auth_user_whoami`, `auth_user_grant` and its own
  identity — every other verb is refused.
- **A remote run names a remote checkout.** Your cwd is a fact about your
  machine, so `odu ci run --checkout <abs path on the server> --sha <sha>`
  sends both verbatim. `--sha` is REQUIRED with `--checkout` (it is the strict
  gate: a checkout that moved on is refused, not quietly run), and
  `--checkout` without a named service is refused because a loopback daemon
  already has your working directory. The run resolves hosts from the
  SERVER's `$ODU_HOSTS`.

  ```sh
  odu surface auth token_create --input '{"name":"laptop"}' --json   # signed in; shown once
  export ODU_TOKEN=odu_… ODU_WEB_ORIGIN=https://odu.example.com
  odu ci run --checkout /data/checkouts/kolu --sha "$(git rev-parse HEAD)" --no-post
  ```

- **A run records who started it.** `run_read` answers `actor` — the token's
  login, or `local` on a loopback daemon — and the board and `odu ci history
  list` show `started by <login>`. Provenance, not authority: revoking a token
  stops the next call, not a run already launched.
- **Your role bounds what you may do.** `member` starts, retries and cancels
  runs; `admin` also administers cache buckets; `owner` grants roles. On a
  daemon with a door the ROOT TOKEN is not an administrator — it bootstraps the
  first owner and nothing else:
  `odu surface auth user_grant --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","login":"<login>","role":"owner"}' --json`.

**The `auth_*` verbs exist only on a daemon with a door.** With no
`ODU_GITHUB_*` configured the auth row is not mounted: `odu surface auth
user_whoami` has no verb to call, and the MCP bridge does not advertise the seven. That is the
loopback shape and it is unchanged — the daemon is nobody's to authenticate,
every caller is its local owner, and the runs answer without a credential.

Reading state without a verb — the same three resources on both faces:

```sh
odu surface keys runs            # the board: every registered run
odu surface get runs "$RUN"      # one row (state, sha, scope, passed, reportingDebt, cursor)
odu surface get service          # who is serving, which build, is it ready
odu surface watch runs           # follow the board
odu surface --help               # the whole projection
odu ci history list [--all] [--limit N] [-o json]   # the catalog from a terminal
```

MCP resources: `surface://cells/service`, `surface://collections/runs`,
`surface://collections/logTails/{key}`.

`odu ci run` is the human's one-shot spelling of the same thing: it calls
`run_start` for the checkout you are standing in and then observes. Its options
are `run_start`'s inputs plus six of its own — `--checkout` with `--sha` (name
a checkout on a REMOTE service instead of this one; see "Signing in"),
`--no-wait` (start and return without observing), `--request-id`, `--origin`
and `-o json`. Ctrl-C stops observing; the run keeps going.

## Refusals, and what to do about them

A refusal is odu declining the request — not CI failing, and not a transport
error. `code` is what you branch on; `message` is for the human; `resync` and
`suggestion` carry the recovery where there is one.

| `code` | Next move |
| --- | --- |
| `bad_input` | Fix the input; it could not have meant anything. |
| `unknown_run` / `expired` | The run is not in the catalog (or aged out). Find it on the board, or start a fresh run. |
| `bad_cursor` | Run the `resync` it carries. Usually a cursor from a parent run after a `relaunched` retry. |
| `checkout_refused` | Not a git repo, or the checkout moved off `expectedSha`. Re-read HEAD and re-issue. |
| `not_replayable` | Dirty live tree, or the checkout is gone. Start a new run instead of retrying. |
| `request_conflict` | Same id, different input. New intent ⇒ new id. |
| `request_unresolved` | Outcome unknown. **Do not re-issue with a new id** — find the run and reconcile. |
| `stale_attempt` | The node moved past your `expectAttempt`. Re-read, then decide again. |
| `launch_failed` | The service could not start the coordinator; the message says why. |
| `pipeline_refused` | The checkout's `justfile` could not be resolved into a DAG; the message says what broke. |
| `no_venue` | No lane matched — the hosts file configures none for that platform. Read `venue_probe`. |
| `no_credential` | The serving process has no usable `gh`. Authenticate it, or use `dryRun`. |
| `no_root_token` | The service has no `$ODU_ROOT_TOKEN`, or yours is wrong. Cache administration and the metrics verbs need it; the substituter keeps serving without it. |
| `unknown_bucket` / `bucket_exists` | No such bucket, or one already exists — creating it again would rotate a key out from under every client that trusts it. |

## Exits — two vocabularies, and `1` means opposite things

**`odu surface` exits are about the CALL**, not about CI:

| Exit | Meaning |
| --- | --- |
| 0 | Answered — **including an answer that reports red CI**. |
| 1 | odu declared a refusal (one JSON line on stderr, with a `code`). |
| 2 | Usage error; the call never left the process. |
| 3 | Nothing serving (and, at the default origin, odu tried to start it and says why). |
| 130 | Interrupted — the observation ended, the run carries on. |

**`odu ci run` / `odu ci wait` exits are about CI**, because that is what they answer:

| Exit | Meaning |
| --- | --- |
| 0 | Settled, and it passed. |
| 1 | **There is a failure to act on.** Not a refusal — red CI. |
| 2 | Still going, nothing red yet. Ask again with the returned cursor. |
| 3 | Its coordinator is gone and it never finalized. Start a fresh run. |
| 4 | No such run, or its evidence expired. |
| 5 | The request itself was refused. |

Read that difference carefully before you branch on a number: exit 1 from
`odu surface` is odu refusing you, and exit 1 from `odu ci run` is your tests
failing. An agent that conflates them reports a broken test as a broken tool.

## Wiring the MCP face

This skill ships in odu's [Agent Plugin](https://agent-plugins.org/), which is
this repository's root. Its `mcp.json` wires the MCP face beside it — unpinned
upstream, over stdio:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "odu": {
      "type": "stdio",
      "command": "nix",
      "args": ["run", "--accept-flake-config", "github:juspay/odu", "--", "mcp"]
    }
  }
}
```

A client that loads the plugin gets both. A harness configured by hand runs the
same command: `nix run --accept-flake-config github:juspay/odu -- mcp`.
`--accept-flake-config` is load-bearing — odu's flake declares a binary cache,
and without it `nix run` stops on a trust prompt no MCP host can answer.

The bridge dials the singleton, bootstraps it if nothing is serving, and
projects the fourteen verbs and three resources. It starts no coordinator and
holds no run authority, so a harness restarting it kills nothing.

## Nothing stays local

Every public command goes through the service, including `odu ci dump` and
`odu ci graph` — both are `pipeline_read`, and an agent can call that verb
directly. They used to be listed here as a deliberate exception on the grounds
that a `justfile` read touches no run. That was wrong: what odu will run for a
checkout is a question `run_start` answers through the same engine, so a face
answering it locally is a SECOND RESOLVER of the one thing you most need to be
able to trust — and it could disagree with the run it is meant to predict.

## Hosts

Lanes need machines. `$ODU_HOSTS` (a file path) → `~/.config/odu/hosts.json`:

```json
{ "x86_64-linux": ["ci-1", "ci-2"], "aarch64-darwin": "me@mac-mini.local" }
```

Keys are Nix system tuples; values are anything ssh dials, a list of them (a
pool), or `localhost`. A run that resolves **zero** lanes is refused, never
defaulted to `localhost`. `hostPins` (`"P=ADDR"`) pins one box for one run;
`venue_probe` shows the inventory from any face; `odu ci hosts [platform…]` is its
terminal spelling.

**`$ODU_HOSTS` belongs to the caller, and travels with the request.** The
service is a per-user singleton, so the process that starts your coordinator is
not the one a person typed into. Every verb that resolves a host inventory —
`run_start`, `venue_probe`, `venue_hold`, `venue_release`, `protect_apply` —
takes `hostsFile`: a path, or `""` for "this shell has none". **An agent omits
the field entirely**, which means "I have no shell and no preference" and
leaves the service's own configuration standing.

A finalized retry replays the PARENT's inventory, recorded in its manifest, and
refuses (`not_replayable`) for a record written before odu wrote it down — a
replay that resolved against today's fleet is not a replay.

A lane host needs ssh + Nix + outbound https, and the source arrives by
`git fetch` of the **pushed** SHA — remote lanes fetch pushed commits in strict
mode. With `noStrict`, odu ships a snapshot of the working tree, unpushed
commits included. The lane runner itself is resolved from the build that shipped
the coordinator, so a host whose Nix trusts nothing still works on Linux with
Nix 2.17–2.34: a published revision is pulled by the host, content-addressed. A
macOS host, or a Linux one on Nix ≥ 2.35, must trust the cache odu's flake
declares.

## What changed (state it honestly if asked)

- **A RUN PUSHES WHAT IT BUILDS** (`ci` 2.5, PLAN 4.1): every recipe's
  `result*` closure goes to the odu cache the repository's `flake.nix`
  `nixConfig` already reads from, when THIS daemon is the one serving it. The
  target is decided from the URL against what the daemon advertises — the
  bucket's path under its public origin, or a domain bound to that bucket —
  and never from anything a server says about itself, so a flake cannot aim a
  run's credential at a host somebody else runs. No recipe step, no token in
  the tree, no request field, no flag. The run's write token is minted for
  that run, scoped to that one bucket, expires in 24 hours as a backstop and
  is revoked as soon as nothing is serving the run — a `--linger` coordinator
  keeps it, because a rerun still pushes (it reads `run <id>` in the bucket
  page's Tokens list, cache 4.6); the recipe's own environment never has it; a
  push that fails reddens its node. A repository naming TWO caches this daemon
  serves is refused at start, except on a replay, which runs without pushing.
  `run_read` answers `push`, and a node answers `pushed`. The interim bound is
  the operator's: with no org row saying which repository owns which bucket,
  any checkout this daemon runs may push to any bucket it serves.
- **The daemon can be scraped** (`metrics` 1.0, PLAN 6.2): `GET /metrics` is a
  Prometheus exposition of the cache row's hit rates and storage, the runs'
  durations and lane use. It needs the root token or a `metrics` token
  (`metrics_token_mint`); there is no anonymous access.
- **A bucket can live on S3** (cache 3.1): R2, AWS, Garage, versitygw — declared by the
  operator, chosen per bucket with `store`, served exactly like local disk.
- **GC and pins reach every bucket** (cache 4.0): retention counts from `lastWanted` —
  renewed by a push and by the `missing` query, never by a read, since reads are leaving
  odu — 90 days by default and per bucket with `cache_bucket_retention`; `cache_gc_plan`
  is the dry run, and takes an optional `retentionDays` of its own (cache 4.4) to plan at a
  retention it does not write, which `cache_gc_run` has no field for;
  `cache_pin_list`/`cache_pin_delete` read and drop pins (a write token may pin, and may
  re-point only a pin a write token made, because re-pointing releases what the pin held);
  the row collects
  every bucket daily on its own; and a collection speaks only the object store's `list`
  and `delete`, so an R2 bucket collects exactly as one on disk. The old
  last-access field is gone from a path and from `cache_stats_read`.
- **A bucket can be deleted** (cache 4.3): `cache_bucket_delete` takes its objects out of
  its store, then the bucket row, its paths, its pins and the tokens scoped to exactly
  that name, and answers how many objects went and what they weighed. It refuses a bucket
  with a domain bound (clear the domain first) and one with a move in flight. Admin only,
  and on the board it is the bucket page's **Delete this bucket**, which makes you type
  the bucket's name first.
- **A SHELL CAN RUN A REMOTE SERVER'S CI** (`ci` 2.6, PLAN 4.4): `odu ci run
  --checkout <abs path on the server> --sha <sha>` sends both verbatim, so a
  laptop no longer has to be standing in the repository the run is about.
  `--sha` is required with `--checkout` (the strict gate compares what the
  caller believes, never a value the service supplied itself), and
  `--checkout` is refused without a named remote service, because a loopback
  daemon already has your cwd. The run then resolves hosts from the SERVER's
  `$ODU_HOSTS`. Every run also records `actor` — the connection's principal,
  a login or `local` — answered by `run_read` and shown as `started by
  <login>` on the board and in `odu ci history list`. It is provenance, not
  authority: a revoked token stops the next call, not a launched run.
- **Each row versions its own surface.** The host is at 2.5, `ci` at 2.6, `cache` at 4.6,
  and `auth` and `cloudflare` at 2.4. A client is refused only when the host's major or the
  major of a row **it reads** differs. The refusal names that row
  (`serves the cache row at 4.0; this build reads cache 3.1`): run `odu web --upgrade`.
  A runs-only reader is never refused because the cache moved.
- The cache's `held` resource and `odu cache push --wait` are gone (cache 3.0).
- `odu cache push --output json` also answers `served` — the paths the bucket
  serves after the push, by name — and `substituter`, the URL a Nix client is
  told to use. A caller proving a push checks that list at that address, not
  the closure: the closure still holds the upstream-signed paths a bucket
  refuses by design.
- The repository ships a GitHub Actions push step
  (`juspay/odu/.github/actions/push@<sha>`), which verifies its own push. Its
  `cache:` input is the substituter URL and is now OPTIONAL: omitted, the push
  reads it out of `./flake.nix`'s `nixConfig`, the one declaration a repository
  that reads from the cache already keeps.
- `odu cache push --cache <substituter>` is the same discovery in a shell: it
  GETs `<substituter>/nix-cache-info`, requires `Odu-Origin` and `Odu-Bucket`,
  and pushes to them. It is exclusive with `<bucket> --origin <url>`, which
  stays for a person who has both in hand. A cache that states neither — or
  does not answer — is refused with a sentence naming the URL. With NEITHER a
  `--cache` nor a bucket, `odu cache push <path>…` reads the substituter out of
  `./flake.nix`'s `nixConfig` and pushes to the one odu cache named there; two
  is a refusal listing both. That inference probes ANONYMOUSLY, and the push
  that follows uses ONLY a credential saved for that origin
  (`odu cache login`): the URL came out of a repository, so `--token-file` and
  `$ODU_CACHE_TOKEN` — which are credentials for wherever a push ends up — are
  out of scope, and a flake pointing at somebody else's host collects nothing.
  With none saved the push goes out anonymously and the bucket's 401 says so.
  A PRIVATE bucket therefore cannot be inferred and must be named with
  `--cache` or `<bucket> --origin`.
- `odu cache push --pin NAME` re-points a pin at the closure the push landed
  (nothing is pinned if a path was refused). The push action takes `pin: true`
  instead of a name and derives `<owner>/<repo>@<ref>/<system>`; when to pin is
  the workflow's own `${{ github.ref_name == … }}` line.

- **The admin CLI is retired.** The CLI is `odu ci <verb>` (every run command
  now carries the `ci` word: `odu ci run`, `odu ci wait`, `odu ci logs`,
  `odu ci history list`, `odu ci status`, `odu ci protect`, …), plus
  `odu cache use|login|push`, `odu auth login`, `odu web`, `odu surface`,
  `odu mcp`. Cache, people and tunnel administration is the board or
  `odu surface <row> <verb>`; the old `odu cache create|list|domain|token|pin|gc|stats`,
  `odu auth whoami|grant|people|token` and `odu cloudflare status` are unknown
  commands now, with no aliases.
- `odu runs` is gone. Use `odu ci history list` (or the `runs` resource); the
  JSON shape differs.
- `ci run --linger` is gone from the public verb — it only meant something when
  a human attached to a coordinator directly.
- There is one MCP face. Bare `odu mcp` **is** the shared-service bridge; the
  old per-checkout tools (`run`, `node_rerun`, `wait_for_settle`, `cancel`,
  `runs`, `node_cancel`, `lane_cancel`, `lease`, `release`) no longer exist.
  `--service` is still parsed, ignored and warned about for one release, so
  existing `.mcp.json` argv does not crash.
- The per-run coordinator is internal execution machinery, reached only through
  a hidden verb. Do not invoke it, and do not dial `.ci/odu.sock`.

## When NOT to use this skill

- Questions about odu's internals or design history — read the
  [README](https://github.com/juspay/odu/blob/master/README.md).
- Project-specific CI operations (warm pools, banned flags, which lanes are
  required) — that is the consuming repo's operational docs, layered on top of
  this reference.

### Working-tree development

Use `run_start` with `noStrict: true` to snapshot current tracked edits, deletions and non-ignored new files consistently across local and remote workers/shards. This never posts GitHub statuses, even on a clean tree. `noSnapshot: true` takes precedence and runs in place on localhost only (including ignored dependencies/build outputs).

When verifying, compare the answer's base `sha` **and** `contentSha`: a `contentSha` means a working tree was tested, not just `sha`. The board, `run_read` and `run_wait` expose this identity, and each lane's `_ci-setup` lists the overlay. A new edit is a new intent: use a new request id. Cache-hit evidence requires identical `contentSha`; red-to-green edits change it. Finalized working-tree runs need a new `run_start`; live retries retain the same snapshot.

`.ci/` and ignored files are excluded. Sparse checkouts and submodule changes are refused; Git clean filters apply and LFS files travel as pointers. Capture fails on any Git error. Bundles are limited to 64 MiB (`ODU_SNAPSHOT_MAX_BYTES`); oversized captures name the largest paths. Recipes recreate ignored dependencies and outputs in their detached workspace.

Bundle creation and `ODU_SNAPSHOT_MAX_BYTES` apply only when the selected pool may use remote transport. Local-only working-tree runs need no origin and do not pack repository history.

To see `dirty` and `contentSha` over MCP, run the `odu mcp` bridge from the same build as the service; older bridges can drop these fields.
