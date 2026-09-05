# Docs

odu runs a [`just`](https://just.systems) recipe DAG locally or across machines, holds the run as live typed state, and exposes that state to humans and coding agents.

## Quick start

Nothing to install. Run odu straight from its flake against the current repository:

```sh
nix run github:juspay/odu -- run --host x86_64-linux=localhost
```

odu never guesses where to run. Use `--host SYSTEM=localhost` to opt into this machine, or configure ssh lanes in a hosts file. Add `--no-strict` for dirty-tree development with GitHub writes disabled.

Attach from another terminal while the run is live:

```sh
odu attach
odu logs -f e2e@x86_64-linux
```

Strict mode refuses a dirty tree, tests a pinned `HEAD`, and posts GitHub commit statuses. `--no-strict` runs the live working tree locally and disables GitHub writes.

## Why odu

Batch CI turns a task graph into a process and leaves logs behind. odu keeps the pipeline alive as a service you can query and mutate while it runs.

The runner serves three typed primitives over plain ssh using an [Effect RPC](https://effect.website) surface—no daemon, port, or preinstalled remote agent:

| Primitive | Call | Carries |
| --- | --- | --- |
| **Cell** | `surface.nodes.get()` | The whole pipeline: one snapshot, then deltas. |
| **Stream** | `surface.nodeLog.get({ id })` | Buffered node output, then live appends. |
| **Procedure** | `surface.node.rerun({ id })` | Reset a node and its dependents, then reschedule. |
| **Procedure** | `surface.node.cancel({ id })` | Cancel one pending/running node (also on the fan-in). |

Fan-in only (coordinator on `.ci/odu.sock`, not the lane runner): `run.cancel` tears down the whole run; `lane.cancel({ platform })` drops one platform mid-run.

Every interface is a thin adapter over that contract: the terminal dashboard, the MCP server, and future frontends all read the same state.

This is built with [**@kolu/surface**](https://kolu.dev/surface/), a framework for defining typed reactive state once and serving it locally, remotely, or through purpose-built projections such as MCP.

## How a run works

```text
odu run  (coordinator, your machine)
 ├─ strict gate: refuse a dirty tree, pin HEAD via git worktree
 ├─ ingest: just --dump → [metadata("ci")] dependency DAG
 ├─ serve: .ci/odu.sock is live from here on — before any machine is claimed
 ├─ venue lease: pick a free host per platform (pool) and hold it
 │    (or reuse an agent-held lease from `odu lease` / MCP lease)
 ├─ per-platform lane:
 │    dial odu-runner over surface-remote → configure over the surface →
 │    fetch the pushed SHA → run each node with just --no-deps
 ├─ fan-in: merge lane state into the surface already being served
 ├─ logs: .ci/<sha>/<platform>/<recipe>.log
 ├─ record: .ci/<sha>/runs/<seq>.json
 └─ GitHub: one commit status per recipe@platform transition
```

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

A sharded recipe must be a leaf, and `--linger` remains unavailable for a
sharded run. The leaf constraint avoids allowing downstream work after only one
shard has passed; lifting it requires a downstream aggregate barrier.

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
- **Busy pool → wait in line** (and say who you're waiting for). `--no-wait` fails immediately instead.
- **`--host P=ADDR`** pins a specific machine for that run (waits if busy).
- **`localhost` is never an implicit fallback** (see [juspay/odu#46](https://github.com/juspay/odu/issues/46)). It participates only when you name it as the sole, pure-local pool; mixing it with remotes is refused.
- Multi-platform claims are independent: each ready platform starts immediately while the others keep claiming. The complete pool set is still validated up front, so one remote host cannot be assigned to two platform lanes.

`odu hosts` probes every declared slot as free / busy / held-by without acquiring (same agent, `lease.probe`). Lock base default: `/tmp/odu.lease` (`ODU_LEASE_LOCK` to override).

#### Watching a run provision

Claiming a machine is not instant: a host that has never seen odu-runner
receives its whole Nix closure over ssh first, which on a cold store is minutes.
The coordinator serves `.ci/odu.sock` **before** it claims, so that window is a
phase you can watch rather than a silence
([juspay/odu#84](https://github.com/juspay/odu/issues/84)):

- `odu status` prints `provisioning <elapsed>` and the pool each lane is claiming from — `-o json` carries it as `run: {phase, elapsed_ms, lanes}`, one roster entry per platform tagged `state: "claiming" | "leased"`.
- `odu attach` draws the matrix, with the lane line showing `x86_64-linux ▸ claiming ci-1, ci-2` until a host is picked.
- `_ci-setup@<platform>` is `running` from the claim, and the copy narrates itself into that node's log: `odu logs -f _ci-setup@x86_64-linux`.
- A ready platform leaves setup and begins its ordinary DAG without waiting for a sibling platform's cold claim or optional shard bootstrap.
- `odu wait` blocks on the run instead of reporting there is nothing to wait for.

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
reason in its log, so it lands in `odu runs` and in an agent's `wait_for_settle`
verdict like any other failure.

On the agent, half-open links self-release after ~45s without inbound activity including framework `system.live` probes (`ODU_LEASE_DEAD_MAN_MS`). Forgotten holds self-release after 1h (`ODU_LEASE_MAX_HOLD_MS`; `0` = unlimited).

### Agent-held leases (cross-run)

A coding agent without a long-lived orchestrator can hold a venue across discrete tool calls:

```sh
odu lease                     # all platforms; prints wait/held lines
odu lease x86_64-linux --no-wait
odu run                       # reuses held hosts — no re-queue; lock untouched on exit
odu release                   # drop agent-held lease(s)
```

`odu lease` spawns a detached holder (`odu lease-hold`) that dials odu-runner and records state in `.ci/odu-lease.json` (`held` / `waiting`, host, holder pid). MCP tools `lease` / `release` match: `lease` returns **immediately** with `held {host}` or `waiting {behind…}`; re-call `lease` or inventory to observe the queue. `odu run` consumes agent-held hosts and skips its own claim/release for those platforms. `--host` still overrides.

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

Classic branch protection is not written. A branch governed by a ruleset reports `protected: true` while the classic API answers `Branch not protected (HTTP 404)`, which is what an older `odu protect` ran into.

## CLI reference

```text
odu run [recipe[@platform]…]      run selectors; bare recipes fan out
    --platform P (repeatable)     select platforms
    --host P=ADDR (repeatable)    pin or add a host for one run
    --root NAMEPATH               use another DAG root
    --no-deps                     skip the dependency closure
    --no-post                     strict, but no GitHub writes
    --no-snapshot                 live tree; implies --no-post
    --no-strict                   --no-snapshot + --no-post
    --progress json               emit NDJSON node transitions
    --supersede                   cancel the current run, then start
    --linger                      keep serving after settlement
    --no-wait                     fail if every host in a pool is busy

odu status [-o json]              snapshot the live run
                                  (json: {nodes, posting, run})
odu logs [-f] <node>              replay and optionally follow a node log
                                  (-f returns when that node's log is complete)
odu attach [-o json]              attach the live dashboard or event stream
odu wait [--settle] [--timeout-ms N] [--expected-sha SHA]
                                  fail-fast JSON verdict; --settle = full settle
odu rerun <node|@platform|recipe> restart node(s) on the still-live run
odu cancel [node|@platform]       stop the live run, or one node / lane
odu runs [-o json]                read durable run history
odu hosts                         venue inventory (free / busy / held by)
odu lease [PLAT…] [--no-wait]     agent-held venue across runs
odu release [PLAT…]               drop agent-held lease(s)
odu dump | graph                  emit the resolved DAG as JSON or Mermaid
odu protect [--dry-run]           sync required GitHub status contexts
    --platform P (repeatable)     explicit repo platform set; no hosts needed
    --branch B                    branch to protect (default: repo default)
    --create                      make the branch's ruleset if absent
                                  writes the branch's ruleset; see below
odu mcp                           serve the agent interface over stdio
```

### The live dashboard

`odu run` on a terminal, and `odu attach` from anywhere else, paint the same
view: a recipes × platforms matrix, the focused node's log, and an events lane
above the status bar. It runs on the alternate screen, so your scrollback is
untouched while the run is live and gets a verdict when it exits — `attach`
leaves a one-line recap, `run` its full per-node summary.

On a terminal wide enough for both, the matrix sits **beside** the log rather
than above it, and the log gets the frame's full height. A pipeline's recipe
count then costs the log nothing: 25 recipes on a 33-row terminal leaves 27
rows of log side by side, against one row stacked. Narrower than that, the view
stacks and the matrix yields instead — the log keeps a floor of 8 rows, and the
matrix becomes a window that follows the focused cell and says how many recipes
it is holding back.

| key | |
|---|---|
| `h` `j` `k` `l`, arrows | move the focus between matrix cells |
| `1`–`9` | jump straight to a node |
| `r` | rerun the focused node (and its dependants) |
| `f` | follow the log tail, or pin it where it is |
| `PgUp` `PgDn` | scroll the log a page at a time |
| `Home` `End`, `g` `G` | jump to the top of the log, or back to the tail |
| mouse | click a matrix cell or an events entry to focus it, wheel over the log to scroll, drag the scrollbar, click a status hint to run it |
| `/` then `Enter`, `n` | search the focused log, next match; `Esc` cancels |
| `q`, `Ctrl-C`, `Ctrl-D` | in `odu attach`: leave; the run keeps going. In `odu run`: cancel the run (exit 130) |

The log pane is a terminal, not a text buffer: a node that redraws with carriage
returns (`nix build`, `bun test`) shows one progress line rather than hundreds,
wide characters are measured rather than counted, and a node's own colours come
through — a failing test stays red. Escape sequences never reach the pane as
text; the emulator consumes them and hands back characters with attributes. The
pane takes whatever height the layout gives it, and a resize relayouts — and
re-orients between the stacked and side-by-side frames — rather than smearing.

The frame itself is coloured by state: each node's glyph carries its status
hue, a running node's elapsed clock stays lit while settled durations recede,
and the counts row is tinted per bucket so a run's shape reads at a glance.

### Cancel, supersede, and linger

`.ci/odu.sock` identifies the live run in a checkout. Bare `odu cancel` asks the coordinator to finalize statuses, close lanes, remove the socket, and then waits for teardown.

`odu cancel <node>` (e.g. `ci::fmt@aarch64-darwin`) or `odu cancel @<platform>` cancels only that node or the whole platform execution — all primary and shard lanes are stopped and marked `cancelled` (not `errored`/`failed`), and every run-owned venue lease for that platform is released. The rest of the run settles normally. MCP twins: `node_cancel` / `lane_cancel` (CLI `@plat` sugar maps to `lane.cancel`).

`odu run --supersede` combines full-run cancel and start for the common “stop this run and test the fix” move. Runs normally exit as soon as they settle; `--linger` keeps the coordinator available so a node can be retried later, then reaps it after an idle period or explicit cancellation.

## Coding agents (MCP)

`odu mcp` exposes the live run over [Model Context Protocol](https://modelcontextprotocol.io). It dials the same `.ci/odu.sock` as `status`, `logs`, and `attach`; lane selection remains the coordinator's job.

The interface projects odu's [@kolu/surface](https://kolu.dev/surface/) through `@kolu/surface-mcp`. It is default-deny: only declared state and procedures reach the agent.

| Tool | Purpose |
| --- | --- |
| `run` | Start a background coordinator. Supports `supersede`, `linger`, and `no_wait`. Reuses agent-held venues without re-claiming. `supersede` cancels the **whole** live run — every lane of it — so it is for replacing a run with a different commit, never for retrying a lane. When the checkout's last run was *killed* (its lock/socket residue is still in `.ci`), starting over it needs no `supersede`, and the answer says so: `coordinator_lifetime` plus `cleared` names the corpse it stepped over. |
| `node_rerun` | Re-run **one** node (and its transitive dependents) on the run that is still live — the way to retry a single failed or flaky lane. It works mid-run, alongside the sibling lanes, and **cancels nothing**: the other platforms keep going and the run keeps its coordinator, its venue leases and its GitHub statuses. Ids are `<recipe>@<platform>`. With nobody serving and kill residue on disk it refuses by *naming the death*, not with a bare failure. |
| `node_cancel` | Cancel one node (`ci::fmt@plat`); leaves the rest of the run settling. Marks `cancelled` (not red). |
| `lane_cancel` | Drop one platform lane (`platform: aarch64-darwin`); frees a run-owned venue lease. |
| `wait_for_settle` | Return on settlement or immediately when a node goes red. Carries `sha7`, the reserved `seq`, and `unposted[]` full owed rows (`{context, lastError, attempts}` — reporting debt does not block settle). If the coordinator's socket closes before the terminal frame, the verdict comes from the run's finalized record on disk. Fails loud with no live run — and *which* loud: kill residue on the checkout makes the error name the dead run ("died with the process that started it"), never an instantly returned empty verdict or an `expected_sha` mismatch. |
| `cancel` | Stop and fully tear down the live run. |
| `runs` | Read durable run history after the coordinator exits — and name a run the coordinator died in the middle of (`dead_run`) instead of answering an empty ledger. |
| `lease` | Agent-held venue: spawn a detached holder and return immediately with `held {host}` or `waiting {behind…}`. Re-call to observe the queue. |
| `release` | Drop agent-held venue lease(s). |

Every tool takes an optional `checkout` argument — the absolute path of the checkout root the call targets. Default is the server's own working directory, so a single-checkout agent never sends it; a server serving many conversations addresses another tree by naming it (`run({checkout: "/path/to/wt"})` spawns its coordinator there, waits on `<checkout>/.ci/odu.sock`, and the read/drive verbs dial that checkout per call). The `nodes`/`logs` resources stay bound to the server's home checkout — they are subscribable streams, not calls, so per-checkout reads arrive on the verbs; a node's log file is addressed off disk via `@odu/run-client`'s `logPathFor`, the exported spelling of `.ci/<sha7>/<platform>/<namepath>.log`.

A `run`-spawned coordinator is detached and is never reaped when the MCP server *exits* — an agent harness restarting `odu mcp` alone kills no run. But the coordinator lives and dies with the process that started it — a restart of that host kills the run: a service stop kills the host's whole cgroup, `detached` or not, and there is deliberately no supervisor escaping that. The corpse is then named, never hidden: the stale lock, socket and unfinalized reservation left in `.ci` are what `runs`, `wait_for_settle`, `node_rerun` (and any `dialRun`→`null` consumer, via `@odu/run-client`'s `deadRun`) answer from — "this run died at `<sha#seq>`" — and starting a new run over the residue works without `supersede`. Cancel via the `cancel` tool while the server lives, or `odu cancel` from any shell.

Pipeline state and logs are subscribable resources rather than tools:

- `surface://streams/nodes` — `{ run, pipeline, sha7, seq, nodes[], unposted[] }`: run identity, every node's status/exit/duration/red verdict, and full owed GitHub status rows not yet confirmed.
- `surface://collections/logs/{id}` — buffered live output, or the durable log after exit. The entry is the last 64KB, and it now reliably ENDS at the recipe's final line — the run waits for the lane to finish streaming before tearing it down. Read `.ci/<sha>/<platform>/<recipe>.log` for the whole thing.

Both support `resources/subscribe` and `notifications/resources/updated`. `wait_for_settle` is the blocking fallback for hosts that do not wake a model on notifications.

Typical agent loops:

```text
# Cross-run venue (no re-queue between iterations)
lease → run → wait_for_settle → fix → run → … → release

# Fail-fast on a live run
run → wait_for_settle → read red node log → fix → node_rerun
```

`node_rerun` is the retry, and it is the cheap one: the run stays up, the other
lanes keep running, and nothing is cancelled. Reaching for `run({supersede})`
instead throws away every lane that was still going — a green darwin lane
discarded to have another go at a flaky linux one. Supersede is for a *different
commit*. If the run has already settled and you want a node back, that is what
`run({linger: true})` was for: the coordinator outlives settle, so `node_rerun`
still has a run to act on.

An early `wait_for_settle` response with `fail_fast_tripped: true` is not a final tally. Only `passed: true` on a fully settled run proves green.

A wait rides out a dropped *link*. If the connection to the coordinator dies while the run is still going — a coordinator busy claiming a venue or copying a runner closure can go quiet long enough for the transport's keep-alive to give up — the wait re-dials and carries on rather than reporting a live run as unsettled. The plain-CLI `odu wait` runs the same settle core over a reader built the same way — both dial through the same re-dialing client — so the two faces answer a run alike.

Every observed verdict identifies its run with `sha7` and, when the coordinator reserved one, `seq`—the durable `sha7#seq` identity. Pass `expected_sha` as a full SHA or `sha7` prefix to make identity a hard check. `seq` is null only when no ordinal could be reserved. With no live run, `wait_for_settle` raises the same “no run in progress” error as `odu status` — or, when the residue says a run *died* here (stale lock/socket, unfinalized reservation, nobody serving), the error names that death instead ("this run died at `<sha#seq>`"). It never returns an ambiguous empty verdict. When a run *was* observed and the coordinator's socket then closed before the terminal frame, the verdict is read from that run's finalized record — never green for a run torn down mid-flight.

Configure the stdio server directly:

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

Repositories using [APM](https://github.com/juspay/apm) can depend on `juspay/odu`; its package deploys the launcher and MCP entry automatically. Set `ODU_FLAKE=.#odu` to use a repository's pinned build instead of `github:juspay/odu`.

## Operational notes

- **Remote lanes require pushed SHAs.** Hosts fetch from the origin remote. Localhost lanes can test unpushed work.
- **Live-tree mode is localhost-only.** A dirty tree with remote lanes is rejected rather than silently testing stale source. Select local platforms or commit and push.
- **A broken link is retried on a fresh box.** When a remote lane's ssh connection dies (or the venue lease under it is lost), odu claims another venue from that platform's pool and starts a new lane over only the nodes that had not finished — up to two retries per platform. Nodes that already went `ok` keep their status and their logs; a node cut off mid-recipe says so in its log and runs again from the start. Sharded lanes, localhost lanes, and a platform that has spent its retries still mark unfinished nodes `errored`. Live node state never survives a runner restart, so a retry re-runs an unfinished node rather than resuming it.
- **One run per checkout.** `.ci/odu.sock` is the lock. Use `cancel` or `--supersede` before starting another run.
- **A node's durable log is complete.** A node's terminal status is not published until its log has ended, so by the time anything tells you a node is done — a status, the settled verdict, the posted commit status — that node's output is already on disk. A recipe's summary is the last thing to arrive and used to be the first thing lost. This holds on every path, `--linger` included, where the coordinator never tears down at all. A lane that goes silent still owing output, or a run stopped before a node finished (cancelled, interrupted, or self-reaped after `--linger` goes idle), says so in the log itself (`[odu] log truncated: …`) rather than ending mid-line — and its last line still says the log ended, so `logs -f` returns. Logs are addressed by commit, not by run, so re-running the same SHA REPLACES `.ci/<sha>/<platform>/<recipe>.log` instead of appending to it.
- **History is durable; live attachment is not.** `odu runs` reads completed records, but `status`, `logs`, and `attach` always target the currently live run and take no historical selector.

Each terminal run writes a `(repo, sha, seq)` record to `.ci/<sha>/runs/<seq>.json`, including interrupted runs. A run that ends still owing GitHub status posts records them as `unposted` (visible in `odu runs` as e.g. `passed, 1 status never reached GitHub`). MCP-spawned coordinators also tee stdout/stderr to `.ci/<sha>/runs/<seq>.log`. Use `odu runs -o json` to inspect old outcomes and per-node results.

## Development

```sh
just install
just typecheck
just test
just e2e
just run -- run --no-strict fmt
```

odu consumes the `@kolu/surface` libraries upstream, not vendored. `npins` pins `juspay/kolu`, `nix/overlay.nix` extracts package store paths, and `scripts/hydrate-kolu-packages.sh` hydrates them into `node_modules/@kolu/`. Run `just update-pins` to advance the pin.

The repository runs its own CI with itself: `nix run .#odu -- run` executes the `[metadata("ci")]` DAG in `ci/mod.just`.

## Lineage and roadmap

odu grew from kolu's `mini-ci` example and graduated into its own repository. It runs Kolu's CI today — Linux and macOS, terminal attach and agent MCP — on the same `@kolu/surface` stack as the rest of the family.

Read [Introducing odu](https://kolu.dev/blog/odu/) for the design story and live demos, or explore the framework at [kolu.dev/surface](https://kolu.dev/surface/).
