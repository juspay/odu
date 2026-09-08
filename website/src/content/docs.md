# Docs

odu runs a [`just`](https://just.systems) recipe DAG locally or across machines, holds the run as live typed state, and exposes that state to humans and coding agents.

## Quick start

**Nix is the only supported way to run odu.** There is no source entry point
and nothing to install: the wrapper the Nix build produces is what bakes odu's
own absolute path, the browser bundle, this build's identity and the pinned
`nix` / `git` / `gh` / `just` it shells out to. A binary carrying none of them
is a misbuilt package, not a mode, and it refuses rather than half-working.
Run it straight from its flake, unpinned:

```sh
nix run github:juspay/odu -- run --host x86_64-linux=localhost
```

odu never guesses where to run. Use `--host SYSTEM=localhost` to opt into this machine, or configure ssh lanes in a hosts file. Add `--no-strict` for dirty-tree development with GitHub writes disabled.

Attach from another terminal while the run is live:

```sh
odu attach
```

Strict mode refuses a dirty tree, tests a pinned `HEAD`, and posts GitHub commit statuses. `--no-strict` runs the live working tree locally and disables GitHub writes.

## Why odu

Batch CI turns a task graph into a process and leaves logs behind. odu keeps the pipeline alive as a service you can query and mutate while it runs.

The runner serves three typed primitives over plain ssh using an [Effect RPC](https://effect.website) surface—no port and nothing preinstalled on the builder:

| Primitive | Call | Carries |
| --- | --- | --- |
| **Cell** | `surface.nodes.get()` | The whole pipeline: one snapshot, then deltas. |
| **Stream** | `surface.nodeLog.get({ id })` | Buffered node output, then live appends. |
| **Procedure** | `surface.node.rerun({ id })` | Reset a node and its dependents, then reschedule. |
| **Procedure** | `surface.node.cancel({ id })` | Cancel one pending/running node (also on the fan-in). |

Fan-in only (coordinator on `.ci/odu.sock`, not the lane runner): `run.cancel` tears down the whole run; `lane.cancel({ platform })` drops one platform mid-run.

That is the wire for **one** run, served on that run's `.ci/odu.sock`, alive only while the run is. The shared service is the only thing that dials it — no public command does, which is what stops a face from being able to do anything at all to a run. The cross-run faces read a *different* contract, the shared service's ([`packages/service-client/src/surface.ts`](https://github.com/juspay/odu/blob/master/packages/service-client/src/surface.ts)), because "what is my CI doing across all my repositories" is not a question any one coordinator can be asked. See [Every run at once](#every-run-at-once-the-web-service).

This is built with [**@kolu/surface**](https://kolu.dev/surface/), a framework for defining typed reactive state once and serving it locally, remotely, or through purpose-built projections such as MCP.

## How a run works

```text
odu run-coordinator  (the coordinator, your machine)
 ├─ strict gate: refuse a dirty tree, pin HEAD via git worktree
 ├─ ingest: just --dump → [metadata("ci")] dependency DAG
 ├─ serve: .ci/odu.sock is live from here on — before any machine is claimed
 ├─ venue lease: pick a free host per platform (pool) and hold it
 │    (or reuse an agent-held lease from `odu lease`)
 ├─ per-platform lane:
 │    dial odu-runner over surface-remote → configure over the surface →
 │    fetch the pushed SHA → run each node with just --no-deps
 ├─ fan-in: merge lane state into the surface already being served
 ├─ logs: .ci/<sha>/<platform>/<recipe>.log
 ├─ record: .ci/<sha>/runs/<seq>.json
 └─ GitHub: one commit status per recipe@platform transition
```

`odu run` does none of that itself. It is a client: it calls `run_start` on the
shared service, the service launches the coordinator above through the hidden
`odu run-coordinator` verb — argv a launcher builds, never a command a person
types — and `odu run` then observes the run it was handed. Ctrl-C of that
observation stops **observing**; the run keeps going. Cancelling a run is
`run_cancel` (or `odu cancel --run R`).

A remote lane needs **ssh, Nix, and outbound HTTPS**. The runner travels as a Nix closure, the toolchain comes from the repository's dev shell, and the source arrives by `git fetch` of the pushed SHA.

The runner derivation belongs to odu, not the target repository. `ODU_RUNNER_FLAKE` is baked into the `odu` binary at build time, so coordinator and runner always ship together and share the exact RPC contract. Venue locking uses the **same odu-runner agent** (`lease.claim` / `lease.probe` / `lease.release` on the lane surface)—not a separate bash-over-ssh protocol.

## Configure your repo

### Tag the pipeline DAG

Exactly one [`just`](https://just.systems) recipe carries `[metadata("ci")]`. Its dependency closure is the pipeline:

```just
[metadata("ci")]
default: build test lint
```

### Shard long terminal checks

Mark independent leaf recipes with shard ceilings. The command stays a single
bare `odu run`:

```just
[metadata("odu:shard=4")]
e2e: install
    CUCUMBER_SHARD="$((ODU_SHARD_INDEX + 1))/$ODU_SHARD_TOTAL" just test-e2e

[metadata("odu:shard=2")]
test: install
    just test-shard "$ODU_SHARD_INDEX" "$ODU_SHARD_TOTAL"
```

Odu first obtains the normal platform lane, then leases optional capacity up to
the largest additional ceiling. Every sharded leaf can use the same workers up
to its own ceiling: a lease belongs to this run rather than one recipe, and is
held until every lane using it settles. Each leaf receives its own immutable
shard total. A cold candidate may finish normal Nix download/build progress—the first
bootstrap cost is real and amortized. A candidate whose connection or
provisioner actually disconnects is skipped immediately instead of entering the
session retry cycle. The primary lane does not wait behind that work: it starts
workspace setup, unrelated checks, and the sharded root's prerequisites while
optional slots are still bootstrapping. Only the roots wait for their immutable
shard counts. After every potentially slow bootstrap finishes, Odu re-verifies
the holds concurrently, fixes the totals, and extends the same primary runner
with its indexed roots. A dead optional transport is dropped; losing a primary
that has begun executing fails closed rather than pretending another machine
has its state. The number is a ceiling, not a fleet reservation: if two
slots are available, both shards receive `ODU_SHARD_TOTAL=2` and together run
the complete suite. `ODU_SHARD_INDEX` is zero-based. The recipe translates
those framework-neutral variables to Cucumber, Playwright, pytest, or its own
sharder.

Odu continuously verifies that held locks still name this run. Ownership loss
fails closed, including while execution lanes are still starting.

Shard instances appear as adjacent live/log nodes such as
`e2e[1-of-4]@x86_64-linux`. They do not create GitHub contexts. Odu aggregates
them into the stable logical `e2e@x86_64-linux` status, so `odu protect` and
existing branch rules do not change. A lost shard lane fails that aggregate.
Each burst lease is released after every shard lane using that worker settles;
the primary platform lease continues to cover the rest of CI.

The logical recipe's completed duration is the slowest slice's execution time,
the critical path for the parallel recipe itself. Staggered checkout, install,
or build prerequisites on burst lanes are not misattributed to `e2e`. Each
leased burst lane dispatches its private dependency closure in parallel with
the other lanes; the primary reuses the prerequisites it completed while
capacity was being discovered. Those executions are first-class UI, log,
timing, and run-record nodes such as `e2e[2-of-4]::install`; they remain
implementation-detail GitHub contexts, like the slice nodes themselves.

A sharded recipe must be a leaf. The constraint avoids allowing downstream
work after only one shard has passed; lifting it requires a downstream
aggregate barrier.

### Choose hosts explicitly

**A host is a decision.** odu resolves hosts from the first source that exists:

```text
$ODU_HOSTS → ~/.config/odu/hosts.json
```

If none configures a platform, `odu run` refuses and prints both the resolution chain and the ways to opt in. It never silently runs the pipeline on your workstation.

Run locally on purpose by naming the platform's lane `localhost` for one run or in a hosts file:

```sh
odu run --host x86_64-linux=localhost
```

```json
{ "x86_64-linux": "localhost" }
```

A localhost lane runs directly against your toolchain and skips the Nix closure copy. A pool must be pure-local or pure-remote — a localhost entry beside remote hosts is refused when a run leases that platform, since localhost needs no venue lock and would starve the busy remotes beside it.

### Fan out across machines

Define platform lanes in `~/.config/odu/hosts.json`, or point `$ODU_HOSTS` at another file:

```json
{
  "x86_64-linux": "my-linux-builder",
  "aarch64-darwin": "me@mac-mini.local"
}
```

`$ODU_HOSTS` is read from **your** shell, not the service's. Runs execute in a child of a per-user singleton that somebody's shell started — possibly days ago — so `odu run` sends your `$ODU_HOSTS` with the request (absolute, resolved against your cwd) rather than letting the daemon's environment decide where your work lands. Unset in your shell means unset for your run. A caller with no shell at all — an agent, the browser — sends nothing and gets the service's own configured inventory. Every verb that resolves an inventory carries it, so `odu hosts`, `odu lease` and `odu run` from one shell always address one fleet; a finalized retry replays the inventory its parent recorded, and refuses rather than resolving against today's.

Keys are Nix system tuples. Values are anything ssh can dial, or `localhost`. A bare `odu run` fans out to every configured platform. Platforms absent from an existing hosts file are intentionally omitted: a partial configuration is still a decision. Use `--platform P` to select a subset or `--host P=ADDR` to pin or add a lane for one run.

### Venue pools and execution slots

A platform can list several hosts. odu picks a free machine, locks it for the run, and releases when the run ends (or the holder dies):

```json
{
  "x86_64-linux": ["nix@ci-1", "nix@ci-2", "nix@ci-3"],
  "aarch64-darwin": ["nix-infra@rasam.example.ts.net", "srid@sincereintent"]
}
```

By default each host contributes one exclusive execution slot. Declare safe
parallel capacity on a larger builder explicitly:

```json
{
  "x86_64-linux": [
    { "host": "nix@ci-1", "slots": 2 },
    { "host": "nix@ci-2", "slots": 2 },
    "nix@ci-3"
  ]
}
```

Lease exclusivity is per slot, not per physical host. Odu scans slot zero on
each machine before stacking onto slot one, so a sharded check spreads across
hosts first. String entries and `--host` pins remain one-slot declarations.

Rules:

- **One run per declared slot.** The lock is an `flock` **on the builder**, held by the **odu-runner agent** the coordinator dials over surface-remote (`lease.claim`). Slot zero always uses the historical `/tmp/odu.lease`; additional slots use `/tmp/odu.lease.<zero-based-slot>`. A capacity edit therefore never changes an existing slot's identity. `flock` comes from odu-runner's Nix closure (util-linux on its PATH)—builders need ssh + Nix, not a system-installed flock.
- **Busy pool → wait in line** (and say who you're waiting for). That is the RUN's claim: a coordinator whose platform has no free slot queues rather than failing. The `odu lease` COMMAND is different — it answers as soon as its holder is spawned, reporting `waiting` and who it is behind, because through the service a blocking call would hold a request open for as long as somebody else's run takes, on a door a browser and an agent share. Its `--no-wait` governs the holder's persistence, not the call's.
- **`--host P=ADDR`** pins a specific machine for that run (waits if busy).
- **`localhost` is never an implicit fallback** (see [juspay/odu#46](https://github.com/juspay/odu/issues/46)). It participates only when you name it as the sole, pure-local pool; mixing it with remotes is refused.
- Multi-platform claims are independent: each ready platform starts immediately while the others keep claiming. The complete pool set is still validated up front, so one remote host cannot be assigned to two platform lanes.

`odu hosts` reports every declared slot as free / busy / held-by without acquiring. The probing is the service's — `venue_probe`, the same operation the board and an agent call — so the ssh dials come from the daemon rather than from your shell, and there is one answer to "who holds what" instead of one per face (the runner agent's `lease.probe` underneath is unchanged). Lock base default: `/tmp/odu.lease` (`ODU_LEASE_LOCK` to override).

#### Watching a run provision

Claiming a machine is not instant: a host that has never seen odu-runner
receives its whole Nix closure over ssh first, which on a cold store is minutes.
The coordinator serves `.ci/odu.sock` **before** it claims, so that window is a
phase you can watch rather than a silence
([juspay/odu#84](https://github.com/juspay/odu/issues/84)):

- `odu status` prints `provisioning <elapsed>`, the pool each lane is claiming from, and the hosts file that pool was declared in — `-o json` carries it as `run: {id, phase, elapsed_ms, lanes, hosts_source, commit_url}`, one roster entry per platform tagged `state: "claiming" | "leased"`. Those facts are folded out of the run's durable journal rather than dialled off the coordinator, so a run whose coordinator has since died still answers them.
- `odu attach` prints each frame that differs from the last, so the claim reads `claiming x86_64-linux=ci-1|ci-2` until a host is picked and `lanes x86_64-linux=ci-1` afterwards.
- `_ci-setup@<platform>` is `running` from the claim, and the copy narrates itself into that node's log — reachable by its log key through `odu logs`, or in the board.
- A ready platform leaves setup and begins its ordinary DAG without waiting for a sibling platform's cold claim or optional shard bootstrap.
- `odu wait --run R` blocks on the run instead of reporting there is nothing to wait for.

The pin carries **two** bounds, and the timeout message names which one fired:

| bound | default | env | fires when |
| --- | --- | --- | --- |
| idle | 180s | `ODU_LEASE_CLAIM_TIMEOUT_MS` | the dial goes **silent** for that long — it re-arms on every line, so a cold host is never killed for being slow, whether it is copying, evaluating or building |
| ceiling | 45m | `ODU_LEASE_PIN_CEILING_MS` | one pin has run that long in **total**, no matter how chatty |

The ceiling is not the total-elapsed cap [juspay/odu#84](https://github.com/juspay/odu/issues/84)
died of — it sits well above the framework's own 20-minute provisioning backstop,
so it cannot pre-empt honest cold-host work. It exists because the idle bound
alone has a hole: the surface-remote session's backstop *retries* rather than
giving up, and announces each retry as a progress line, which re-arms an
idle-only bound forever. A host that keeps talking and never finishes would hang
the run with no terminal bound at all.

A dial that goes silent still fails with what it was doing
(`still copying the runner closure — 24 store paths so
far, last python3-3.14.6`).
A claim that never succeeds ends the run as a red `_ci-setup@<platform>` with the
reason in its log, so it lands in `odu history list` and in an agent's `run_wait`
answer like any other failure.

On the agent, half-open links self-release after ~45s without inbound activity including framework `system.live` probes (`ODU_LEASE_DEAD_MAN_MS`). Forgotten holds self-release after 1h (`ODU_LEASE_MAX_HOLD_MS`; `0` = unlimited).

### Agent-held leases (cross-run)

A coding agent without a long-lived orchestrator can hold a venue across discrete tool calls:

```sh
odu lease                     # all platforms; prints wait/held lines
odu lease x86_64-linux --no-wait
odu run                       # reuses held hosts — no re-queue; lock untouched on exit
odu release                   # drop agent-held lease(s)
```

`odu lease` calls `venue_hold` on the service, which spawns the detached holder (`odu lease-hold`) that dials odu-runner and records state in `.ci/odu-lease.json` (`held` / `waiting`, host, holder pid) — unmoved, and unchanged in format. **The holder is the daemon's child rather than your shell's**, which is what finally makes "held across runs" true: it used to die with whatever terminal took it, and it is the only arrangement under which a browser or an agent can take a hold at all, since neither has a shell to be the parent. The call returns **immediately** with `held {host}` or `waiting {behind…}`; re-call `odu lease`, or `odu hosts`, to observe the queue. A run consumes agent-held hosts and skips its own claim/release for those platforms. `--host` still overrides. `venue_probe` / `venue_hold` / `venue_release` are on the shared vocabulary, so an agent reaches the same three operations under the same names — but a hold is still recorded per checkout, because a lease is a fact about the venues *that* checkout is about to claim, and the call names the checkout explicitly.

### Scope recipes by OS

odu respects `just`'s built-in [OS attributes](https://just.systems/man/en/attributes.html). A tagged recipe—and anything that depends on it—is pruned from lanes that do not match:

```just
[linux]
nix-bundle:
    nix bundle .#app
```

Multiple OS attributes are OR-ed. Untagged recipes run on every configured lane. `odu protect` applies the same filter, so a `[linux]`-only recipe is never required on a darwin lane that will never post it.

> **Same-OS limitation.** `just --dump` resolves OS attributes on the coordinator before odu sees the DAG. Attributes can prune a recipe from other lanes, but cannot introduce a foreign-OS recipe that was absent from the coordinator's dump. Run each OS family's exclusive recipes from a coordinator on that OS.

### Require the checks on a branch

`odu run` posts a commit status per `<recipe>@<platform>`; `odu protect` makes GitHub require exactly that set, so a merge waits for the pipeline a run actually produces. `--dry-run` prints the contexts and touches nothing:

```sh
odu protect --dry-run --platform x86_64-linux --platform aarch64-darwin
odu protect --platform x86_64-linux --platform aarch64-darwin
```

The contexts are written into the [repository ruleset](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets) governing the branch, replacing whatever it required before — the stale `build-and-test (ubuntu-latest)` contexts a repo carries over from GitHub Actions are exactly what must go, since nothing posts them any more. Every other rule in the ruleset, and the checks rule's own strictness policy, are left alone.

So the branch needs a ruleset. `--create` makes one when none covers the branch:

```sh
odu protect --create --platform x86_64-linux --platform aarch64-darwin
```

It holds exactly one rule — the required checks. Review requirements, deletion and force-push protection are the repo's own policy, and a `protect` that quietly decided reviews were required would be answering a question nobody asked it. Enforcement is `active`, and **`bypass_actors` is empty, so nobody is exempt — admins included**. Granting a bypass is a permission decision, easy to add afterwards under Settings → Rules and impossible to take back unnoticed. A branch odu resolved from the repo's default is matched as `~DEFAULT_BRANCH`, so the ruleset follows a later rename; a branch you named with `--branch` is pinned literally.

Creating is opt-in rather than automatic because `protect` is driven by agents and scripts here, and bringing merge-blocking policy into existence is not something a wrong `origin` should manage on the way past. `--create` is also only a fallback: against a branch a ruleset already covers it updates that one, since a second ruleset beside it would make GitHub require the union and strand the old contexts as permanently-blocking checks.

odu still refuses when two rulesets both require checks, for the same union reason, and when the ruleset is owned by an org or enterprise — the repo-scoped endpoint cannot write it.

The write goes through the service, as `protect_apply`, so the board and an agent can make it too. `protect` used to be kept local on the ground that it spends *your* `gh` credential rather than the daemon's — which described an odu that does not exist, since the coordinator the daemon launches has posted commit statuses with that same credential all along, and `--no-post` is the opt-out. A service with no credential behind it refuses `no_credential` and carries the `gh auth login` that fixes it, rather than half-writing a ruleset.

Classic branch protection is not written. A branch governed by a ruleset reports `protected: true` while the classic API answers `Branch not protected (HTTP 404)`, which is what an older `odu protect` ran into.

## CLI reference

```text
odu run [recipe[@platform]…]      run_start on the shared service, then observe
                                  the run it names. Ctrl-C stops OBSERVING; the
                                  run keeps going. Bare recipes fan out
    --platform P (repeatable)     select platforms
    --host P=ADDR (repeatable)    pin or add a host for one run
    --root NAMEPATH               use another DAG root
    --no-deps                     skip the dependency closure
    --no-post                     strict, but no GitHub writes
    --no-snapshot                 live tree; implies --no-post
    --no-strict                   --no-snapshot + --no-post
    --supersede                   take a checkout that already has a live run,
                                  cancelling that run first. Without it, a busy
                                  checkout is ANSWERED with the run already
                                  there rather than refused
    --no-wait                     start and return, without observing
    --request-id ID               makes a repeat safe (replays, never redoes)
    -o json                       the receipt, then the attention payload

odu status [-o json]              this checkout's newest unfinished run: its
                                  nodes, its lanes, and what it still owes
                                  GitHub (json: {nodes, posting, run})
odu logs <log-key>                one attempt's bytes, addressed by the logKey
                                  a failure reported. ECHO it; do not build one
    --offset B / --limit B        a byte range; --offset=-N is a tail and must
                                  be joined: --offset=-4096
    -f                            follow until the log can grow no further:
                                  exit 0 with the whole log, 1 if truncated
    --wait-ms N                   how long ONE followed read waits for growth
                                  before answering (default 30s)
    -o json                       the whole page: complete / eof / open /
                                  nextOffset / size. Under -f, one page per
                                  line as NDJSON
odu attach [-o json]              the same run, followed until it stops moving:
                                  every frame that differs from the last
odu wait --run R                  bounded, resumable wait on any registered run
    --after CURSOR                resume; you are not shown events twice
    --deadline-ms N               default 30s; reaching it is "still going"
    --settle                      wait for the whole run, not the first red
    -o json                       the attention payload as one line
                                  exits: 0 passed · 1 a failure to act on ·
                                  2 still going, nothing red · 3 owner lost ·
                                  4 no such run · 5 refused
odu rerun --run R <selector>      retry: a new attempt if that run's coordinator
                                  is still up, else a new linked replay run
    --request-id ID               makes a repeat safe (replays, never redoes)
    --expect-attempt N            refuse if the node has moved past attempt N
odu cancel --run R [node|@platform]
                                  bare = the whole run; node or @plat = partial
    --request-id ID               makes a repeat safe
odu history list [--all] [--limit N] [-o json]
                                  the per-user run catalog, newest first
odu history show --run R [--after CURSOR] [-o json]
                                  one run's attention payload, without waiting
odu history import [--dry-run] [-o json]
                                  bring this checkout's .ci records into it
odu history prune [--days N] [--dry-run] [-o json]
                                  expire finished runs past the window (30d)
odu hosts [-o json]               venue inventory (free / busy / held by), with
                                  hosts-file warnings on stderr
odu lease [PLAT…] [--no-wait] [-o json]
                                  hold a venue across runs. Answers at once —
                                  `held`, `already`, or `waiting` with who it is
                                  behind (exit 2); it does not block. The holder
                                  is the SERVICE's child, so it outlives the
                                  shell that asked for it
odu release [PLAT…] [-o json]     drop held lease(s)
odu dump | graph [--root NAMEPATH]
                                  the resolved DAG as JSON or Mermaid. Resolved
                                  by the SERVICE, through the same engine
                                  `run_start` uses, so the graph and the run it
                                  predicts cannot be two answers
odu protect [--dry-run] [-o json] sync required GitHub status contexts
    --platform P (repeatable)     explicit repo platform set; no hosts needed
    --branch B                    branch to protect (default: repo default)
    --create                      make the branch's ruleset if absent
odu web [--background] [--upgrade] [-o json]
                                  every run, in a browser. Bare: serves in this
                                  terminal until Ctrl-C; runs you start keep
                                  going. --background: ensure one that outlives
                                  the shell, print its URL and return.
                                  --upgrade drains a running service of another
                                  build and starts this one
odu surface <verb> [--json]       every registered run, as argv
    --input '{…}' | --input -     the whole input as JSON (or from stdin)
                                  verbs: run_start run_wait run_read run_retry
                                         run_cancel log_read catalog_import
                                         catalog_prune pipeline_read venue_probe
                                         venue_hold venue_release protect_apply
                                  readers: get keys watch list
                                  exits: 0 answered (red CI included) · 1 refused
                                         2 usage · 3 nothing serving · 130 interrupted
odu mcp                           the agent face over stdio: the same thirteen
                                  verbs the browser and `odu surface` use,
                                  bridged to the shared service, with no run
                                  authority of its own. `--service` is parsed,
                                  ignored and warned about for one release

--origin URL selects which service to dial (run, logs, wait, rerun, cancel);
default $ODU_WEB_ORIGIN or http://127.0.0.1:18440. Every command above is a
service client and every one honours $ODU_WEB_ORIGIN. A named origin is dialled
and only dialled — the singleton is started for you only when you meant the
default one.

Removed: `odu runs` (use `odu history list`; the JSON shape differs) and
`odu run --linger` (it only meant something to a human attached to a
coordinator; retry a settled run with `odu rerun --run R`).
```

### Watching a run

`odu attach` follows this checkout's newest unfinished run. Which run that is
gets resolved on the caller's side — read the board, keep the rows whose
`repoRoot` is this checkout, take the newest that has not reached a terminal
state — because where you are standing is the one kind of fact a face is still
allowed to know. It then prints every frame that differs from the last: the node
rows, a provisioning banner while no lane has a machine yet, and a warning line
for any commit status the run could not post. `-o json` emits one object per
frame. Ctrl-C ends the *watching*; the run is a detached process group with its
evidence in the catalog, so interrupting here changes nothing about it — the
same asymmetry `odu run` keeps.

**The curses dashboard went with the dial that fed it.** The recipes × platforms
matrix, its keybindings and its embedded log pane were bound to one coordinator
on one `.ci/odu.sock`, and a face allowed to dial a coordinator is a face that
can do anything to a run. What replaces it splits in two, and each half is
better at what the matrix was actually used for:

- **A transition stream** is what a person piping `odu attach` into a file
  wanted, what an agent can read, and what survives a coordinator restart — none
  of which was true of a curses view bound to a socket. Only what *changed*
  reaches the terminal: a frame is sent whenever something moved, and "something
  moved" includes a lane landing on a box, which alters no node row, so printing
  every frame would repeat the whole view for a reason the reader cannot see.
- **The board** is where the matrix lives now, for every run at once rather than
  the one in front of you, with per-attempt state and placement, each attempt's
  own log, and the retry / cancel / run-again controls — see
  [Every run at once](#every-run-at-once-the-web-service). Following one node's
  output in a terminal is `odu logs -f <log-key>`.

(`odu run` was never the dashboard either: it prints the run it started and then
the attention payload the service answers with.)

### After the coordinator is gone

Every run is also written to a **per-user catalog** — `ODU_STATE_DIR`, else
`$XDG_STATE_HOME/odu/runs` (`~/.local/state/odu/runs`) on Linux and
`~/Library/Application Support/odu/runs` on macOS. Evidence used to live in the
checkout that produced it, addressed by *(commit, node)*, and three things
followed from that: `git worktree remove` deleted the logs of the run you were
debugging, a rerun overwrote the failure you were half-way through reading, and
once the coordinator exited there was nothing left to ask.

`.ci` is still written by the coordinator, and `odu history import` is what
brings an existing ledger in; no public command reads it directly any more, and
none of them dials `.ci/odu.sock` — `status` and `attach` answer out of the
catalog, which is why they keep answering about a run whose coordinator is gone.
What is new is that a run can be **addressed** afterwards: `--run
R` on `wait` and `rerun` (and `cancel`), where `R` is a run id, a unique prefix
of one, the `<sha7>#<seq>` ref the faces already print, or `latest`. What did
not survive is the per-checkout listing — `odu runs` is removed, and
`odu history list` answers across every checkout with a catalog row rather than
the old `.ci` record.

```sh
odu run                                             # or run_start, from any face
odu wait --run latest --deadline-ms 30000 -o json   # exit 2: still going, nothing red
odu wait --run latest --after "$cursor" -o json     # exit 1, and here is what is red
odu logs -f "$log_key" --offset=-4096               # the logKey that failure reported
odu rerun --run latest --request-id fix-1 ci::unit  # the run it started, and a cursor
```

`odu wait --run` returns on the first **actionable** red — a failure whose log
has had its last word — rather than on settlement, so a unit lane that fails at
eight seconds is reported at eight seconds and not after the e2e lane finishes.
Its exit says which of three situations you are in, because they need three
different next moves: **1** there is a failure to act on (which does *not* imply
the run has settled), **2** still going with nothing red, **3** the coordinator
is provably gone and never finalized. `--after` resumes without repeating, and a
cursor belonging to another run is refused with the resync command rather than
silently restarted.

Evidence is per **attempt** and old attempts are immutable, so a retry writes
`N+1` and never over the log you are reading; `odu logs` reports
`complete` as a field, so a truncated log says so instead of looking like a
quiet recipe.

`odu logs -f` follows one attempt to its end. It stops when the page says `open`
is false, which is a fact the service carries rather than one a follower could
infer: a log whose writer was *killed* is at EOF, is not complete, and will
never grow again — from `eof` and `complete` alone, indistinguishable from a
slow recipe, so a follower that guessed would hang on exactly the run somebody
is waiting to hear about. `complete` then says whether you have the whole log or
a truncated one, and the exit says the same. Each call is bounded by
`--wait-ms`, and the cursor is `nextOffset`, which the **caller** holds: nothing
on the service side remembers a follower, so a follow that dies is re-issued
from the offset it reached rather than resumed from a session that has to be
garbage-collected. A `size` below the offset you hold means that attempt was
re-run and its log rewritten in place; the follow says so once and starts again
from the beginning, rather than printing another attempt's tail as a
continuation of this one.

`odu rerun --run` decides what retrying means rather than making the caller
choose: a new attempt if the coordinator is still up, otherwise a new run linked
to it, replayed from the recorded inputs with the commit pinned — **and with the
parent's placement**. Where a run was allowed to happen is part of what it was,
so the parent's `--host` pins are carried verbatim, and a replay whose placement
today's hosts file can no longer state — a platform it no longer configures, a
file that has become unreadable — is refused `no_venue` rather than launched
somewhere else. Two more refusals are `not_replayable`:

- **A run recorded by an older odu cannot be replayed at all.** Its manifest has
  no `hostPins`, and an absent field cannot be told apart from "no pins were
  asked for" — reading it as an empty pin set would let a retry of a run
  confined to one named machine fan out across every machine in the pool, under
  a run id claiming to be a replay of the confined one. The refusal says so, and
  the fix is a fresh run naming the placement you want with `--host`.
- **A run of a dirty live tree cannot be replayed**, because its inputs were
  never committed; it is refused rather than quietly replaced with today's tree.

Finished runs are kept 30 days by default (`odu history prune`), and expiry
leaves a tombstone: a month-old run id gets "it existed, it failed, its evidence
aged out" rather than the answer a typo gets.

### Cancel and supersede

`.ci/odu.sock` identifies the live run in a checkout. `odu cancel --run R` asks that run's coordinator to finalize statuses, close lanes, remove the socket, and then waits for teardown.

`odu cancel --run R <node>` (e.g. `ci::fmt@aarch64-darwin`) or `odu cancel --run R @<platform>` cancels only that node or the whole platform execution — all primary and shard lanes are stopped and marked `cancelled` (not `errored`/`failed`), and every run-owned venue lease for that platform is released. The rest of the run settles normally. Those three scopes are one verb on the shared service: `run_cancel` takes an explicit `scope` of `{kind: "run"}`, `{kind: "node", …}` or `{kind: "lane", …}`, so a cancel is addressed by run id from anywhere rather than by standing in the right directory.

`odu run --supersede` combines full-run cancel and start for the common “stop this run and test the fix” move. It is explicit because the default answer to "a run is already going in that checkout" is to hand you *that* run, not to kill it. A run exits when it settles; `--linger` is gone from the public verb. It only ever meant something to a human attached to a coordinator directly, and retrying after settlement is now `odu rerun --run R` (or `run_retry`), which decides between a new attempt on a live coordinator and a linked replay run rather than making the caller keep one alive to find out.

## Every run at once: the web service

Everything above is about one run in one checkout. `odu web` is the other
question — *what is my CI doing, across all my repositories* — and it is a
per-user singleton rather than a mode of a run:

```sh
nix run github:juspay/odu -- web
# http://127.0.0.1:18440
# serving in this terminal — Ctrl-C stops it
```

`odu web` **serves in the foreground**. Ctrl-C stops the server; runs it started
keep going, because a coordinator is a detached process group of its own. To
leave a service running instead — which is what an agent or a login script wants
— ask for it explicitly:

```sh
nix run github:juspay/odu -- web --background
```

If a service is already running, `--background` reuses it and says so, while
bare `odu web` refuses: it was asked to serve *here*, and here is taken.

That prints a URL and returns. The service outlives the shell that asked for it:
one gate, one fixed address, one catalog. Concurrent launchers converge through
the framework's pid gate — exactly one wins the atomic claim, every loser proves
the holder alive and yields — so the address is findable rather than variable. A
fixed port occupied by something else is an actionable refusal, never a quiet
relocation to a port nobody else can guess.

### One truth, three faces

The board in a browser, `odu surface` in a terminal and an agent over MCP are
three views of one typed contract, not three programs that agree by convention.
All thirteen verbs are derived from one surface spec, so they carry the same
names and the same input shapes everywhere:

```sh
odu surface run_start     --input '{"checkout":"/code/app","expectedSha":"SHA","requestId":"ID"}' --json
odu surface run_wait      --input '{"runId":"RUN","after":"CURSOR"}' --json
odu surface run_read      --input '{"runId":"RUN"}' --json
odu surface log_read      --input '{"key":"LOGKEY","offset":-4096,"waitMs":30000}' --json
odu surface run_retry     --input '{"runId":"RUN","selector":"ci::unit","requestId":"ID"}' --json
odu surface run_cancel    --input '{"runId":"RUN","scope":{"kind":"run"},"requestId":"ID"}' --json
odu surface pipeline_read --input '{"checkout":"/code/app"}' --json
odu surface venue_probe   --input '{}' --json
odu surface protect_apply --input '{"checkout":"/code/app","dryRun":true,"requestId":"ID"}' --json
```

**The list was five, and the growth is the whole point.** Five was how far the
move had got, not a design: `odu status`, `odu hosts`, `odu lease`, `odu history
import` and `odu protect` each did their own work in the caller's process, so a
browser and an agent could not do those things at all, and every command that
could was its own small authority. Now every public capability has exactly one
implementation and every face can reach it — `run_read`, `catalog_import`,
`catalog_prune`, `pipeline_read`, `venue_probe`, `venue_hold`, `venue_release`
and `protect_apply` are the eight that arrived with it.

The one capability that deliberately did **not** become a verb is the follow.
`log_read` takes a `waitMs` instead of there being a fourteenth member, because
a stream that requires an input cannot be a static MCP resource — the same rule
that keeps `nodes` off the agent face — so a stream would have given the browser
and the terminal a follow and left an agent with the one-page read.

An agent reaches the same thirteen as MCP tools, over **Streamable HTTP** at
`http://127.0.0.1:18440/mcp` or through `odu mcp`, a stdio bridge that dials the
singleton and holds no run authority of its own. It is the only agent face odu
has — there is no second, per-checkout MCP server to choose between.

### The board

Every registered run, across every checkout: project, worktree, branch, the
exact commit tested, what the run actually covered, where it is, whether
anything is red, and whether any commit status is still owed. Runs are
discovered from the per-user catalog — a run started by `odu run` in a terminal
appears without anything having told the service, and without scanning arbitrary
filesystem paths.

Opening a run shows its nodes with per-attempt state and placement, each
attempt's own log, and three controls: retry (odu decides whether that means a
new attempt on a live coordinator or a linked replay run, and the receipt says
which), cancel at an explicit run / node / lane scope, and run again. Every one
is a single procedure call on the same wire the other faces use — the browser
holds no execution or retry logic of its own.

A failing node's output is linkable: `#/run/<id>/<encoded node>/<attempt>` is
exactly the log key an agent echoes into `log_read`, so the address in the URL
bar and the address in a tool call are one address.

### Exits: the call, not the CI

`odu wait --run` answers *what did CI do*, so it spends its exit codes on CI's
answer. `odu surface` answers *what happened to my call*, so it spends them on
the call:

| Exit | Meaning |
| --- | --- |
| `0` | The call was answered — **including** an answer reporting red CI or a deadline. |
| `1` | odu declared a refusal. One JSON line on stderr, with a `code` to branch on. |
| `2` | A usage error that never left the process. |
| `3` | Nothing is serving. Run `odu web --background`. |
| `130` | Interrupted. The run carries on — cancelling an observation is not cancelling a run. |

`run_wait` returning `reason: "failure"` is CI going red, and it is a success at
every face: exit 0 on the CLI, a normal tool result over MCP. Only a request odu
*declines* is an error.

### Requests are identified, and repeats are safe

Every mutation takes a `requestId`. The id is claimed on disk before anything is
started, with the new run's id pre-minted — so a repeat of the same id returns
the recorded answer instead of starting a second run, and a crash between the
claim and the coordinator's registration leaves a question with an answer rather
than a choice between two mutations. Mint a fresh id per *intent*, never per
attempt.

### Upgrading a running service

```sh
odu web --upgrade
```

Reads the running daemon's identity off the framework's frozen control contract
(readable even when the application surface is skewed past speaking), asks it to
drain, waits for the **gate** to clear rather than for the process to look gone,
and starts this build. Nothing is signalled; a service that will not drain is
reported rather than killed — it may be finishing a write.

### Access

The listener binds loopback. Browser origins other than the page's own must be
named (`ODU_WEB_ALLOWED_ORIGINS`), and the origin gate runs on the raw
pre-upgrade socket, so a hostile page never gets a connection to argue about —
which is what stands between a web page somebody visited and `run_start` on an
arbitrary checkout. The MCP route can additionally require a bearer token
(`ODU_WEB_MCP_TOKEN`) for an operator who has chosen to front the port with a
proxy.

## Coding agents (MCP)

There is **one** agent face. `odu mcp` is a stdio bridge to the singleton web
service, projecting the same thirteen verbs the browser and `odu surface` use —
from the same `expose` map, so `run_start` is one verb with one name whichever
door an agent came through. The bridge starts no coordinator, dials no checkout
socket and holds no run authority of its own, which is what makes a harness
restarting it harmless: it kills nothing, because it owns nothing.

```jsonc
{
  "mcpServers": {
    "odu": {
      "type": "stdio",
      "command": "nix",
      "args": ["run", "github:juspay/odu", "--", "mcp"]
    }
  }
}
```

The flake ref is deliberately **unpinned**. A consumer gets whatever
`github:juspay/odu` is today, and there is no pin-override knob: a second
supported build is a second answer to "what did that verb do".

Repositories using [APM](https://github.com/juspay/apm) can depend on
`juspay/odu` and get this wired for them — the package deploys one skill and
one launcher, at `.agents/skills/odu/bin/serve`, which execs the same unpinned
`nix run github:juspay/odu -- mcp`.

The same tools are also reachable over **Streamable HTTP** at
`http://127.0.0.1:18440/mcp` on the service's own listener, for a host that
would rather not spawn a subprocess. That route is loopback-only and gated
exactly as the websocket is (JSON content type, a `Host` the service answers
to, a same-origin or allow-listed `Origin`), and can additionally require a
bearer token (`ODU_WEB_MCP_TOKEN`).

### The tools

| Tool | Purpose |
| --- | --- |
| `run_start` | Start a run in an **explicitly named** checkout (`checkout`, absolute) at an **expected commit** (`expectedSha`), under a caller-minted `requestId`. Optional `selectors`, `platforms`, `hostPins`, `root`, `noDeps`, `noStrict`, `noSnapshot`, `noPost`, `supersede`. Answers with a receipt: the `runId`, the `sha`, a `cursor` positioned at the run's beginning, and `accepted`. |
| `run_wait` | Bounded, resumable attention on one run: `runId`, optional `after` cursor, `deadlineMs` (default 30s), `settle`, `limit`. Returns on the first **actionable** red, not on settle. |
| `run_read` | `run_wait` without the waiting — the same answer, now. `runId`, optional `after` and `limit`. One answer shape deliberately: "what is this run's state" has one answer, and a second shape for the non-blocking case would be a second thing to keep true. |
| `run_retry` | Retry a recorded run by `runId` + `selector`, under a `requestId`. odu decides whether that is a new attempt on a live coordinator or a new linked run replayed from the recorded inputs. `expectAttempt` guards against retrying something that already moved. |
| `run_cancel` | Cancel at an explicit `scope` — `{kind: "run"}`, `{kind: "node", …}` or `{kind: "lane", …}` — under a `requestId`. |
| `log_read` | One attempt's bytes by log `key` and `offset` (a negative offset is a tail). The key is the one `run_wait` hands back and the one the board's URL carries. **This is also the follow:** pass `waitMs` and it holds until the log grows past the end of this page, the attempt finishes, or the deadline passes. |
| `pipeline_read` | The recipe DAG a `checkout` declares, resolved without running it — `tasks` with their `needs`, OS attributes and shard counts, plus the same `mermaid` `odu graph` prints. Optional `root`. |
| `venue_probe` | Every configured venue slot and who holds it: `rows` of `{platform, host, slot, slots, state, heldBy}`, the hosts file that won as `source`, and hosts-file `warnings`. Takes no input. |
| `venue_hold` | Take a venue for a `checkout` across runs, under a `requestId`. Optional `platforms` (empty means all) and `noWait`. Each result is `held` / `waiting` / `already`; the holder is the service's child, so the hold outlives the caller. |
| `venue_release` | Drop holds for a `checkout` and optional `platforms`, under a `requestId`. `effective: "nothing"` is an answer, not an error — releasing what nobody held is not a failure. |
| `catalog_import` | Bring a `checkout`'s legacy `.ci` records into the run catalog, under a `requestId`. `dryRun` reports what would land. |
| `catalog_prune` | Expire finished runs past `retentionDays` (30 by default), under a `requestId`. `kept` carries the reason each survivor survived. `dryRun` reports without deleting. |
| `protect_apply` | Set a branch's required status checks to exactly the contexts odu posts for a `checkout`, under a `requestId`. Optional `branch`, `platforms`, `create`. **Use `dryRun` first and read `contexts`** — this is merge-blocking policy. A platform set derived from the hosts file rather than named is reported in `derivedFrom` so a caller can refuse it. |

Every mutating tool takes a `requestId`; `run_wait`, `run_read`, `log_read`,
`pipeline_read` and `venue_probe` are the reads, and are the only ones an MCP
host may auto-execute without confirming.

### The resources

- `surface://cells/service` — who is serving, which build, and whether it is ready.
- `surface://collections/runs` (and `surface://collections/runs/{id}`) — the board: every registered run, one row each.
- `surface://collections/logTails` (and `surface://collections/logTails/{id}`) — one attempt's live tail, addressed by log key.

`nodes` is deliberately **not** a resource: it is a stream whose input is a run
id, and a stream that requires an input cannot be a static MCP resource. An
agent reads a run's shape out of `run_wait`'s answer, which is the payload built
for exactly that. The stdio bridge is half-duplex, so nothing is pushed: an
agent that wants to watch calls `run_wait` again with the cursor it was given.

### The loop

Six moves, and the fifth and sixth are what make it a loop rather than a gamble.

```sh
# 1. bootstrap — unpinned upstream, and the first call starts the daemon
#    if nothing is serving. There is no local-execution fallback: a client
#    that cannot reach the service starts one or says nothing is serving.
nix run github:juspay/odu -- mcp        # (or the .mcp.json above)

# 2. start — an explicit checkout, an explicit commit, a fresh request id
run_start {checkout: "/code/app", expectedSha: "<HEAD sha>", requestId: "fix-1"}
#   → {runId, sha, cursor, accepted}

# 3. wait — bounded, and resumed by cursor, never re-polled from the top
run_wait {runId, after: <cursor>, deadlineMs: 30000}
#   → still_running: ask again with the NEW cursor
#   → failure: here is what is red, with a logKey per failure

# 4. diagnose — the failure carries its own address. Add waitMs to FOLLOW:
#    it answers when the log grows past this page, or at the deadline
log_read {key: <logKey>, offset: -4096, waitMs: 30000}
#   → feed nextOffset back as offset — that is the cursor, and YOU hold it,
#     so a call that dies is re-issued rather than resumed. Stop when
#     open is false; complete then says whole or truncated. A size SMALLER
#     than the offset you asked for means the attempt was re-run and its
#     log rewritten — start again from 0.

# 5. retry, guarded — a fresh request id per INTENT, never per attempt
run_retry {runId, selector: "ci::unit", requestId: "fix-1-retry"}
#   → a receipt naming the run to watch next (a new attempt, or a linked run)
#   ... or, for a new commit, run_start again with a NEW expectedSha

# 6. verify — the scope, the sha, and the reporting debt
run_wait {runId: <effective run>, after: <its cursor>, settle: true}
```

**The loop is no longer the boundary of what an agent can do**, and that is what
the vocabulary grew for. `pipeline_read` asks what a checkout even builds before
anything runs it, so an agent can name the recipe it means rather than guessing.
`venue_probe` says which machines exist and who has them; `venue_hold` /
`venue_release` take and drop a hold that outlives the tool call, which is
possible only because the holder is the service's child rather than a shell's.
`run_read` is the state of a run without holding a call open. `catalog_import`
and `catalog_prune` maintain the catalog. `protect_apply` sets a branch's
required checks — `dryRun` first, and read `contexts`. Every one of those was a
terminal-only command until this.

**`run_wait` returning a failure is a success.** `reason: "failure"` is CI going
red, and it is a normal tool result — exit 0 at the CLI face. Only a request odu
*declines* is an error, and a refusal says why in a `code` an agent branches on
(`unknown_run`, `bad_cursor`, `checkout_busy`, `checkout_refused`,
`not_replayable`, `request_conflict`, `pipeline_refused` — a checkout with no
readable `justfile`, which is a different problem from a bad repository — and
`no_credential`, a forge write with no `gh` credential behind it, carrying the
`gh auth login` that fixes it as ARGV).

**Verify the scope and the SHA before reporting green.** A run answers about the
commit it was started on and the recipes it actually covered; `run_wait`'s
payload carries both, and a settled run that still owes GitHub status posts says
so as `posting_debt`. "Everything passed" is a claim about a scope, and the
scope is in the answer.

### Terminals, and a reply that never arrived

The bridge is a subprocess of the agent's host, and the run is not. A
coordinator is started by the service into its own process group (or its own
transient user service), so:

- **Killing the MCP server kills no run.** It holds no run authority; there is
  nothing of the run in it to kill.
- **Interrupting an observation is not cancelling a run.** `odu run` and
  `odu surface run_wait` exit `130` on Ctrl-C and the run carries on. Cancelling
  is `run_cancel`, explicitly, at a named scope.
- **A restart of the host machine does kill the run** — a service stop takes the
  whole cgroup — and the ownership fence then reports `owner_lost` rather than
  leaving a row that says `running` for ever.

**Every mutation carries a `requestId`, and that is how a lost reply is
reconciled.** The id is claimed on disk *before* anything is started, with the
new run's id pre-minted, so a repeat of the same id with the same input replays
the recorded answer instead of performing the mutation twice — even if the crash
happened between the claim and the coordinator's registration. So when a call
times out, the network drops, or the harness restarts mid-tool:

1. **Repeat the same call with the same `requestId`.** Do not mint a new one.
   A fresh id is a licence to start a second run.
2. The answer comes back with `replayed: true` if it was recorded rather than
   performed, and `accepted: false` (with `existing`) if the checkout already
   had a live run — which is an answer, not a refusal: it is pointing you at the
   run you almost certainly wanted.
3. Only `request_conflict` means you reused an id for a *different* input. That
   is a bug in the caller, not a reason to retry.

Mint one `requestId` per **intent**. "Run CI on this fix" is one intent across
every retry of the call that expresses it.

## Operational notes

- **Remote lanes require pushed SHAs.** Hosts fetch from the origin remote. Localhost lanes can test unpushed work.
- **Live-tree mode is localhost-only.** A dirty tree with remote lanes is rejected rather than silently testing stale source. Select local platforms or commit and push.
- **A broken link is retried on a fresh box.** A few seconds of silence on a lane's ssh link is fatal to it — the RPC transport detects that itself and the runner dies with the pipe — so odu does not try to ride blips out. It recovers instead: when a remote lane's connection dies (or the venue lease under it is lost), odu claims another venue from that platform's pool and starts a new lane over only the nodes that had not finished, up to two retries per platform. Nodes that already went `ok` keep their status and their logs; a node cut off mid-recipe is named in that lane's `_ci-setup` log and runs again from the start with a fresh log, since live node state never survives a runner restart. Sharded lanes, localhost lanes, and a platform that has spent its retries still mark unfinished nodes `errored`. `ODU_MAX_LANE_RESURRECTIONS` moves the budget (default 2); `0` turns the recovery off entirely, so a broken link marks the platform `errored` on the spot.
- **One run per checkout.** `.ci/odu.sock` is the lock. Use `cancel` or `--supersede` before starting another run.
- **A node's durable log is complete.** A node's terminal status is not published until its log has ended, so by the time anything tells you a node is done — a status, the settled verdict, the posted commit status — that node's output is already on disk. A recipe's summary is the last thing to arrive and used to be the first thing lost. A lane that goes silent still owing output, or a run stopped before a node finished (cancelled or interrupted), says so in the log itself (`[odu] log truncated: …`) rather than ending mid-line — and its last line still says the log ended, so a reader is told `complete` rather than left waiting. Logs are addressed by commit, not by run, so re-running the same SHA REPLACES `.ci/<sha>/<platform>/<recipe>.log` instead of appending to it; the catalog's per-attempt evidence is immutable and does not.
- **History is durable; live attachment is not.** `odu history list`, `odu history show`, `odu logs` and `odu wait --run` read recorded runs, but `status` and `attach` always target the currently live run in this checkout and take no historical selector.

Every run writes a `(repo, sha, seq)` record to `.ci/<sha>/runs/<seq>.json`, including interrupted runs, and registers in the per-user catalog. A run that ends still owing GitHub status posts records them as `unposted`, and they surface as a `posting_debt` item in the attention payload `odu wait --run`, `odu history show` and `run_wait` all answer with. A coordinator the service launched also tees stdout/stderr to `.ci/<sha>/runs/<seq>.log`. Use `odu history list -o json` and `odu history show --run R -o json` to inspect old outcomes and per-node results.

## Development

```sh
just install
just typecheck
just test
just e2e
just run -- run --no-strict fmt
```

`just run` is `nix run . --`: there is no `bun run start`, because there is no
source entry point to start. `just test`, `just typecheck` and `just e2e`
still drive `bun` inside the dev shell — bun there is a **test** runtime, not a
second way to run the application. A dirty local `nix build` is a real build
with a real identity: `ODU_BUILD_ID` is the resulting store path, baked
unconditionally, so the singleton's compatible-reuse check works on a
developer machine. `ODU_COMMIT_HASH` is separate, optional provenance for a
reader who wants to navigate to a forge — a build without one is not "off-nix",
and a package missing `ODU_SELF`, `ODU_WEB_DIST`, `ODU_BUILD_ID` or
`ODU_OSFACTS_BIN` is misbuilt rather than degraded, and refuses to serve.

odu consumes the `@kolu/surface` libraries upstream, not vendored. `npins` pins `juspay/kolu`, `nix/overlay.nix` extracts package store paths, and `scripts/hydrate-kolu-packages.sh` hydrates them into `node_modules/@kolu/`. Run `just update-pins` to advance the pin.

The repository runs its own CI with itself: `nix run .#odu -- run` executes the `[metadata("ci")]` DAG in `ci/mod.just`.

## Lineage and roadmap

odu grew from kolu's `mini-ci` example and graduated into its own repository. It runs Kolu's CI today — Linux and macOS, terminal attach and agent MCP — on the same `@kolu/surface` stack as the rest of the family.

Read [Introducing odu](https://kolu.dev/blog/odu/) for the design story and live demos, or explore the framework at [kolu.dev/surface](https://kolu.dev/surface/).
