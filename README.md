# odu

<img src="./logo.svg" width="112" align="right" alt="odu — a CI runner you attach to" />

**A CI runner you attach to.** odu (Tamil ஓடு — *run*) runs your
[`just`](https://just.systems) recipe DAG across machines, posts GitHub commit
statuses, and holds the run as **live typed state** — for a terminal dashboard
and for coding agents over MCP.

[Website](https://juspay.github.io/odu/) · [Docs](https://juspay.github.io/odu/docs/) · [Announcement](https://kolu.dev/blog/odu/)

```sh
nix run github:juspay/odu -- run --host x86_64-linux=localhost
```

```sh
odu attach          # live matrix + logs from another terminal
odu wait            # fail-fast JSON verdict (or `wait --settle`)
odu wait --run latest   # the same question, after the coordinator is gone
odu rerun unit      # restart a recipe on the still-live run
odu web             # every run, in a browser — one service, all your repos
odu mcp             # same run, agent face (MCP over stdio)
```

Batch CI leaves log files. odu keeps the pipeline alive: attach late and replay
from the top, fail-fast when a node goes red, rerun only that node and its
dependants. Tag one recipe with `[metadata("ci")]` — that dependency closure
*is* the pipeline. Hosts are always explicit (localhost or ssh); nothing is
guessed.

Long terminal checks can opt into bounded fleet sharding without changing the
command. Independent leaf checks share the leased workers:

```just
[metadata("odu:shard=4")]
e2e: install
    CUCUMBER_SHARD="$((ODU_SHARD_INDEX + 1))/$ODU_SHARD_TOTAL" just test-e2e

[metadata("odu:shard=2")]
test: install
    just test-shard "$ODU_SHARD_INDEX" "$ODU_SHARD_TOTAL"
```

A bare `odu run` opportunistically uses available execution slots up to the
largest ceiling. Every sharded leaf can use those same workers up to its own
ceiling: the lease belongs to this run, not to one recipe, and stays held until
all lanes on that worker settle. Odu posts one aggregate GitHub status per
logical recipe. Cold slots may bootstrap through Nix normally;
a slot whose connection fails is skipped instead of entering the retry cycle.
The primary lane starts its ordinary CI work while cold burst slots bootstrap;
only the sharded roots wait. After provisioning, Odu re-verifies every lease,
fixes each shard total, and appends the roots with their immutable index/totals
to the already-running primary lane. Dead optional slots simply shrink the totals.
In a multi-platform run, each platform starts as soon as its own mandatory
venue is ready; a cold Linux claim does not hold a ready Darwin lane in setup.
Odu continuously verifies that held locks still name this run. Ownership loss
fails closed, including while execution lanes are still starting.
Configure shared host capacity with
`{"host":"ci-1","slots":2}`; legacy host strings remain one slot.
The aggregate duration is the slowest slice's execution time, not staggered
checkout/install/build time. Each burst lane dispatches that private dependency
closure in parallel; the primary reuses prerequisites it ran during capacity
discovery. Both expose nodes such as `e2e[2-of-4]::install` in the UI, logs,
timing sidecar, and run record without creating extra GitHub contexts.

## Every run, in one place

A run used to be something you watched from the terminal that started it. The
catalog made a run *addressable* after its coordinator was gone; `odu web` makes
every one of them visible at once:

```sh
nix run github:juspay/odu -- web
# http://127.0.0.1:18440
```

That prints a URL and returns. The service is a per-user singleton that outlives
the shell — one gate, one fixed address, one catalog — so the board in your
browser, `odu surface` in a terminal and an agent over MCP are three views of
**one** truth rather than three programs that agree by convention:

```sh
odu surface run_start --input '{"checkout":"/code/app","expectedSha":"'$SHA'","requestId":"fix-1"}' --json
odu surface run_wait  --input '{"runId":"'$RUN'","after":"'$CURSOR'"}' --json
odu surface log_read  --input '{"key":"'$LOG_KEY'","offset":-4096}' --json
```

An agent reaches the same five verbs as MCP tools, either over **Streamable
HTTP** at `http://127.0.0.1:18440/mcp` or through `odu mcp --service`, a stdio
bridge to the singleton that holds no run authority of its own. (Bare `odu mcp`
is unchanged: the nine tools of the live run in one checkout.)

That HTTP endpoint is loopback-only and gated the way the websocket is: a JSON
content type, a `Host` this service actually answers to, and an `Origin` that is
same-origin or named in `ODU_WEB_ALLOWED_ORIGINS`. A page you merely visited
cannot post `run_cancel` at it.

The board shows every registered run across every checkout: project, worktree,
branch, the exact commit tested, what the run covered, where it is, whether
anything is red and whether any commit status is still owed. Opening a run shows
its nodes, each attempt's own log, and the three controls — retry, cancel at an
explicit scope, run again — every one of which is a single procedure call on the
same wire the other two faces use. A failing node's output is linkable: the URL
carries the same log key an agent echoes back.

**The exits are a different question from `odu wait`'s, on purpose.** `odu wait
--run` answers *what did CI do*, so it spends its codes on CI's answer. `odu
surface` answers *what happened to my call*, so it spends them on the call: **0**
answered — including an answer that reports red CI — · **1** odu declared a
refusal (one JSON line on stderr) · **2** a usage error that never left the
process · **3** nothing is serving, run `odu web` · **130** interrupted, and the
run carries on.

Nothing is superseded. `odu run`, `odu wait`, `odu logs`, `odu history` and the
existing `odu mcp` tools behave exactly as before; a run started by `odu run` in
a terminal appears on the board the moment the service reads the catalog, with
nothing having told it.

## CLI

```text
odu run [recipe[@platform]…] [--platform P]… [--host P=ADDR]… [--root NAMEPATH]
    [--no-deps] [--no-strict] [--no-snapshot] [--no-post] [--progress json]
    [--supersede] [--linger] [--no-wait]
odu status [-o json]              # json shape: { nodes, posting }
odu logs [-f] <node>              # the LIVE run's log (replay + follow)
odu logs --run R [--attempt N] [--offset B] [--limit B] [-o json] <node>
                                  # one RECORDED attempt, after the run is gone
odu attach [-o json]
odu wait [--settle] [--timeout-ms N] [--expected-sha SHA]
                                  # fail-fast verdict JSON; --settle = full settle
odu wait --run R [--after CURSOR] [--deadline-ms N] [--settle] [-o json]
                                  # bounded, resumable. Returns on the first red
                                  # you can act on, not on settle. Exits: 0 passed
                                  # 1 a failure to act on · 2 still going, nothing
                                  # red · 3 owner lost · 4 no such run · 5 refused
odu rerun <node|@platform|recipe> # restart node(s) on the still-live run
odu rerun --run R [--request-id ID] [--expect-attempt N] [-o json] <selector>
                                  # retry a RECORDED run: a new attempt if its
                                  # coordinator is still up, else a new linked run
odu cancel [node|@platform]       # bare = whole run; node or @plat = partial
odu runs [-o json]                # this checkout's run history
odu history list [--all] [--limit N] [-o json]
                                  # the per-user catalog, newest first
odu history show --run R [--after CURSOR] [-o json]
                                  # one run's attention payload, without waiting
odu history import [--dry-run] [-o json]
                                  # bring this checkout's .ci records in
odu history prune [--days N] [--dry-run] [-o json]
                                  # expire finished runs past the window (30d)
odu hosts                         # venue inventory (free / busy / held by)
odu lease [PLAT…] [--no-wait]     # hold a free venue across runs (agent layer)
odu release [PLAT…]               # drop agent-held lease(s)
odu dump [--root NAMEPATH]        # resolved pipeline as JSON
odu graph [--root NAMEPATH]       # dependency graph (Mermaid)
odu protect [--dry-run] [--branch B] [--platform P]… [--create]
                                  # --create: make the branch's ruleset if absent
odu web [--upgrade] [-o json]     # ensure the singleton web service; prints its
                                  # URL and returns (the service outlives the
                                  # shell). --upgrade drains a running one of
                                  # another build and starts this one
odu surface <verb> [--input JSON] [--json]
                                  # every registered run, as argv: run_start,
                                  # run_wait, run_retry, run_cancel, log_read,
                                  # plus get/keys/watch/list. Exits: 0 answered
                                  # (red CI included) · 1 refused · 2 usage ·
                                  # 3 nothing serving · 130 interrupted
odu mcp                           # serve the agent face (MCP, stdio)
```

## The run catalog, and the loop it makes possible

Evidence used to live in the checkout that produced it — a record at
`.ci/<sha7>/runs/<seq>.json`, one log per *(commit, node)*. Three things follow
from that address, and all three are things people hit. `git worktree remove`
deletes the logs of the run you are debugging. A rerun of the same commit
overwrites the failure you were half-way through reading. And once the
coordinator exits nothing can be asked at all, so a bounded wait that came back
empty could not distinguish *not yet* from *it failed* — which is how a slow
lane gets reported as a red one.

So every run is now also written to a per-user catalog: `$XDG_STATE_HOME/odu/runs`
(`~/.local/state/odu/runs`) on Linux, `~/Library/Application Support/odu/runs` on
macOS, `ODU_STATE_DIR` overriding both. Nothing was retired. The `.ci` ledger is
still written and `odu runs` still answers about *this checkout*; `odu history
list` is the per-user view across all of them, and every live command and every
MCP tool behaves exactly as before. What is new is that a run can be **addressed**
after nobody is serving it: `--run R` on `logs`, `wait` and `rerun`, where `R` is
a run id, a unique prefix of one, the `<sha7>#<seq>` ref the faces already print,
or the word `latest`.

That is enough for an agent loop that survives its own subject: start → bounded
wait → diagnose → retry → resume.

```sh
odu run                                              # elsewhere, or via MCP `run`
odu wait --run latest --deadline-ms 30000 -o json    # → exit 2: still going, nothing red
odu wait --run latest --after "$cursor" -o json      # → exit 1, and here is what is red
odu logs --run latest --attempt 2 ci::unit@x86_64-linux
odu rerun --run latest --request-id fix-1 ci::unit   # → the run it started, and a cursor
odu wait --run "$effective_run" --after "$cursor" -o json
```

The exits are the contract, because *there is something to fix*, *nothing has
happened yet* and *its coordinator died* need three different next moves:
**0** it passed · **1** there is a failure to act on — which does **not** mean
the run has settled, since a red unit lane beside a lane with ninety seconds to
go is already actionable · **2** still going and nothing red at the deadline
(ask again with the returned cursor) · **3** owner lost — the coordinator is
provably gone and never finalized, so start a fresh run · **4** no such run, or
its evidence expired · **5** the request itself was refused, e.g. a cursor
belonging to another run, and the refusal carries the resync command. The bare
`odu wait`, with no `--run`, is unchanged and still exits 0 or 1.

`odu wait --run` returns on the first **actionable** red — a failure whose log
has had its last word — rather than on settle, so a unit failure is reported at
eight seconds instead of after the e2e lane finishes. `--settle` asks for the
whole run instead. `--after CURSOR` resumes: you are not shown the same events
twice, and the cursor advances only through events actually delivered, so a
trimmed payload cannot swallow what a reconnecting caller came back for. It
suppresses repeats and resolves nothing — a red node you already acknowledged is
still listed, because it is still red.

Evidence is per **attempt** and old attempts are immutable, so a retry adds
`N+1` and never overwrites the log you are reading; `odu logs --run` reports
`complete` as a field, so a truncated log says it is truncated instead of looking
like a quiet recipe. `odu rerun --run` retries a *recorded* run, and odu decides
what that means rather than the caller: a new attempt if its coordinator is still
up, otherwise a new run linked to it, replayed from the recorded inputs with the
commit pinned. A run of a dirty live tree cannot be replayed — its inputs were
never committed — and is refused rather than substituted with today's tree.
`--request-id` makes a repeat safe: the same id with the same input replays the
recorded answer instead of starting a second run. Finished runs are kept 30 days
by default (`odu history prune`), and expiry leaves a tombstone, so a month-old
run id gets "it existed, it failed, its evidence aged out" rather than the answer
a typo gets.

The catalog's own design — the ownership fence, the journal, the attention fold,
the export map — is documented in
[`packages/run-history/README.md`](packages/run-history/README.md).

AGPL-3.0-or-later
