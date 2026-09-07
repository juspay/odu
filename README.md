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
odu attach                    # live matrix + logs from another terminal
odu wait --run latest         # fail-fast JSON verdict (or add --settle)
odu rerun --run latest unit   # retry a recipe: a new attempt, or a linked run
odu web             # every run, in a browser — one service, all your repos
                    # (--background to leave it running)
odu mcp             # every run, agent face (MCP over stdio) — a bridge to
                    # the same service the browser draws
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
# serving in this terminal — Ctrl-C stops it
```

**`odu web` serves in the foreground**; Ctrl-C stops the server, and runs it
started keep going, because a coordinator is a process group of its own. To
leave one running instead — which is what an agent wants — ask for it:

```sh
nix run github:juspay/odu -- web --background
```

Either way it is a per-user singleton — one gate, one fixed address, one catalog
— so the board in your browser, `odu surface` in a terminal and an agent over
MCP are three views of **one** truth rather than three programs that agree by
convention:

```sh
odu surface run_start --input '{"checkout":"/code/app","expectedSha":"'$SHA'","requestId":"fix-1"}' --json
odu surface run_wait  --input '{"runId":"'$RUN'","after":"'$CURSOR'"}' --json
odu surface log_read  --input '{"key":"'$LOG_KEY'","offset":-4096}' --json
```

An agent reaches the same five verbs as MCP tools, either over **Streamable
HTTP** at `http://127.0.0.1:18440/mcp` or through `odu mcp`, a stdio bridge to
the singleton that holds no run authority of its own — so a harness restarting
it kills nothing. There is one agent face, not two. The per-checkout MCP
server and its nine tools (`run`, `node_rerun`, `wait_for_settle`, `cancel`,
`runs`, `node_cancel`, `lane_cancel`, `lease`, `release`) are **gone**, and
`odu mcp` *is* this bridge. `--service` is still parsed, ignored and named on
stderr for one release, so an existing `.mcp.json` starts instead of crashing
on an unknown option.

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
process · **3** nothing is serving, run `odu web --background` · **130**
interrupted, and the
run carries on.

## One way to run it, one vocabulary, three faces

**Nix is the only supported way to run odu.** There is no source entry point,
no `bun run start`, no npm install. The Nix wrapper is what makes odu odu: it
bakes odu's own absolute path (`ODU_SELF`), the browser bundle (`ODU_WEB_DIST`),
this build's identity (`ODU_BUILD_ID`, the package's own store path — a dirty
local build is a real build with a real identity), the process-facts binary
(`ODU_OSFACTS_BIN`), the runner flake and the pinned `nix` / `git` / `gh` /
`just` it shells out to. Every one of those used to have a runtime repair beside
it, and each repair turned a packaging defect into a subtly degraded application
that looked like a mode somebody had chosen. They are gone. A binary missing any
of them refuses, naming the variable, rather than half-working:

```sh
nix run github:juspay/odu -- run          # unpinned, from anywhere
nix run . -- run                          # in a checkout; `just run --` is this
```

**There is one public vocabulary: the shared service contract**
([`packages/service-client/src/surface.ts`](packages/service-client/src/surface.ts)).
Five verbs — `run_start`, `run_wait`, `run_retry`, `run_cancel`, `log_read` —
plus the `service`, `runs` and `logTails` resources and `get` / `keys` / `watch`
/ `list`. Every mutation an agent, a browser or a terminal makes crosses that
wire to the singleton daemon.

**Three faces project it, and none has a verb of its own.** The board in a
browser, `odu surface <verb>` as argv, and `odu mcp` as MCP over stdio (with the
same tools reachable over Streamable HTTP at `/mcp`). All three are derived from
one `expose` map rather than hand-written per face, which is what makes "a verb
means the same thing to an agent and to a person" a property of the code instead
of a claim about it. Every public client also **bootstraps**: it dials the
singleton and, at the default origin only, starts one and waits for it to be
ready. It never recovers a failed dial by executing the run locally — that would
be exactly the second authority this consolidation exists to remove, reappearing
where it is least visible.

The per-checkout MCP face is deleted: `run`, `node_rerun`, `wait_for_settle`,
`cancel`, `runs`, `node_cancel`, `lane_cancel`, `lease` and `release` are gone,
and bare `odu mcp` is the shared bridge. `--service` is still parsed, ignored
and warned about on stderr for one release, so argv already sitting in a
consumer's `.mcp.json` starts instead of crashing. Two other capabilities went
with the consolidation: **`odu runs` is removed** (use `odu history list`; its
JSON is a catalog row, not the old `.ci` record), and **`odu run --linger` is
removed from the public verb** — it only ever meant something to a human
attached to a coordinator directly, and retrying after settlement is
`odu rerun --run R`.

### What deliberately stays local, and why

Three commands do **not** go through the service, and it is a decision rather
than an omission:

- **`odu dump` and `odu graph`** are pure `just --dump` reads of the checkout in
  front of you. No execution, no socket, no catalog write, no venue lease —
  nothing a cross-run authority would arbitrate. Routing them through a daemon
  would only mean handing it a working directory so it could read the same
  files.
- **`odu protect`** mutates GitHub using the **caller's own** `gh` credential.
  The daemon has no credential-delegation story: it would have to hold or borrow
  a token to write a repository's ruleset, and bringing merge-blocking policy
  into existence is not something to do with an ambient identity nobody chose.
  So the write stays in the process the person authenticated.

Separately, the in-checkout live commands — `status`, `attach`, `hosts`,
`lease`, `release` — speak the **run's own** contract on `.ci/odu.sock`, which
is about one run and exists only while that run does. That is a different
contract from the service's, not a second copy of it: the service answers "what
is my CI doing across all my repositories", which is not a question any one
coordinator can be asked.

A run started by `odu run` in a terminal appears on the board the moment the
service reads the catalog, with nothing having told it.

## CLI

```text
odu run [recipe[@platform]…] [--platform P]… [--host P=ADDR]… [--root NAMEPATH]
    [--no-deps] [--no-strict] [--no-snapshot] [--no-post] [--supersede]
    [--no-wait] [--request-id ID] [-o json]
                                  # run_start on the shared service, then
                                  # observe the run it names. Ctrl-C stops
                                  # OBSERVING; the run keeps going. Explicit
                                  # cancellation is run_cancel.
                                  # --no-wait: start and return, unobserved
odu status [-o json]              # this checkout's live run
                                  # json shape: { nodes, posting, run }
odu logs <log-key> [--offset B] [--limit B] [-o json]
                                  # one attempt's bytes, addressed by the
                                  # logKey a failure reported — echo it, do not
                                  # build one. A NEGATIVE offset is a tail and
                                  # must be joined: --offset=-4096
odu attach [-o json]
odu wait --run R [--after CURSOR] [--deadline-ms N] [--settle] [-o json]
                                  # bounded, resumable. Returns on the first red
                                  # you can act on, not on settle. Exits: 0 passed
                                  # 1 a failure to act on · 2 still going, nothing
                                  # red · 3 owner lost · 4 no such run · 5 refused
odu rerun --run R [--request-id ID] [--expect-attempt N] [-o json] <selector>
                                  # a new attempt if its coordinator is still up,
                                  # else a new linked run. odu decides, and says so
odu cancel --run R [node|@platform] [--request-id ID] [-o json]
                                  # bare = whole run; node or @plat = partial
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
odu web [--background] [--upgrade] [-o json]
                                  # every run, in a browser. Bare: serves in
                                  # this terminal until Ctrl-C (runs you start
                                  # keep going). --background: ensure one that
                                  # outlives the shell, print its URL, return.
                                  # --upgrade drains a running one of another
                                  # build and starts this one
odu surface <verb> [--input JSON] [--json]
                                  # every registered run, as argv: run_start,
                                  # run_wait, run_retry, run_cancel, log_read,
                                  # plus get/keys/watch/list. Exits: 0 answered
                                  # (red CI included) · 1 refused · 2 usage ·
                                  # 3 nothing serving · 130 interrupted
odu mcp                           # the agent face (MCP, stdio): the same five
                                  # verbs, bridged to the shared service. There
                                  # is no --service — it is parsed and ignored
                                  # for one release

--origin URL is accepted by every service client; default $ODU_WEB_ORIGIN or
http://127.0.0.1:18440. A named origin is dialled and only dialled.

Removed: `odu runs` (use `odu history list`; the JSON shape differs) and
`odu run --linger` (retry a settled run with `odu rerun --run R`).
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
macOS, `ODU_STATE_DIR` overriding both. The `.ci` ledger is still written, and
the in-checkout live commands still read it. What did NOT survive is the
per-checkout listing: `odu runs` is removed, `odu history list` is the
per-user view across every checkout, and its `-o json` is a catalog row
(`runId`, `manifest`, `liveness`, `verdict`, `expiry`) rather than the old
`.ci` record. What is new is that a run can be **addressed**
after nobody is serving it: `--run R` on `wait`, `rerun` and `cancel`, where `R`
is a run id, a unique prefix of one, the `<sha7>#<seq>` ref the faces already
print, or the word `latest`.

That is enough for an agent loop that survives its own subject: start → bounded
wait → diagnose → retry → resume.

```sh
odu run                                              # or run_start, from any face
odu wait --run latest --deadline-ms 30000 -o json    # → exit 2: still going, nothing red
odu wait --run latest --after "$cursor" -o json      # → exit 1, and here is what is red
odu logs "$log_key" --offset=-4096                   # the logKey that failure reported
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
belonging to another run, and the refusal carries the resync command. `--run` is
required: a run is addressed by its id from anywhere, never by which directory
you happen to be standing in.

`odu wait --run` returns on the first **actionable** red — a failure whose log
has had its last word — rather than on settle, so a unit failure is reported at
eight seconds instead of after the e2e lane finishes. `--settle` asks for the
whole run instead. `--after CURSOR` resumes: you are not shown the same events
twice, and the cursor advances only through events actually delivered, so a
trimmed payload cannot swallow what a reconnecting caller came back for. It
suppresses repeats and resolves nothing — a red node you already acknowledged is
still listed, because it is still red.

Evidence is per **attempt** and old attempts are immutable, so a retry adds
`N+1` and never overwrites the log you are reading; `odu logs` reports
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
