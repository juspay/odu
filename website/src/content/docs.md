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

The runner serves three typed primitives over plain ssh using an [oRPC](https://orpc.io) contract—no daemon, port, or preinstalled remote agent:

| Primitive | Call | Carries |
| --- | --- | --- |
| **Cell** | `surface.nodes.get({})` | The whole pipeline: one snapshot, then deltas. |
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
 ├─ venue lease: pick a free host per platform (pool) and hold it
 │    (or reuse an agent-held lease from `odu lease` / MCP lease)
 ├─ per-platform lane:
 │    dial odu-runner over surface-remote → configure over the surface →
 │    fetch the pushed SHA → run each node with just --no-deps
 ├─ fan-in: merge lane state and serve it on .ci/odu.sock
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

### Venue pools (one free machine per platform)

A platform can list several hosts. odu picks a free machine, locks it for the run, and releases when the run ends (or the holder dies):

```json
{
  "x86_64-linux": ["nix@ci-1", "nix@ci-2", "nix@ci-3"],
  "aarch64-darwin": ["nix-infra@rasam.example.ts.net", "srid@sincereintent"]
}
```

Rules:

- **One run per machine.** The lock is an `flock` **on the builder**, held by the **odu-runner agent** the coordinator dials over surface-remote (`lease.claim`). `flock` comes from odu-runner's Nix closure (util-linux on its PATH)—builders need ssh + Nix, not a system-installed flock.
- **Busy pool → wait in line** (and say who you're waiting for). `--no-wait` fails immediately instead.
- **`--host P=ADDR`** pins a specific machine for that run (waits if busy).
- **`localhost` is never an implicit fallback** (see [juspay/odu#46](https://github.com/juspay/odu/issues/46)). It participates only when you name it—for one run with `--host`, as the only entry, or as an **explicit** member of a mixed pool (e.g. `["ci-1", "localhost"]`) so it can be picked when remotes are busy.
- Multi-platform claim is **all-or-nothing**: partial holds are released while waiting for the full set.

`odu hosts` probes free / busy / held-by without acquiring (same agent, `lease.probe`). Lock file default: `/tmp/odu.lease` (`ODU_LEASE_LOCK` to override).

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

odu status [-o json]              snapshot the live run (json: {nodes, posting})
odu logs [-f] <node>              replay and optionally follow a node log
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

`odu cancel <node>` (e.g. `ci::fmt@aarch64-darwin`) or `odu cancel @<platform>` cancels only that node or whole platform lane — running work is stopped and marked `cancelled` (not `errored`/`failed`), pending work on the lane is cancelled, and a run-owned venue lease for that platform is released. The rest of the run settles normally. MCP twins: `node_cancel` / `lane_cancel` (CLI `@plat` sugar maps to `lane.cancel`).

`odu run --supersede` combines full-run cancel and start for the common “stop this run and test the fix” move. Runs normally exit as soon as they settle; `--linger` keeps the coordinator available so a node can be retried later, then reaps it after an idle period or explicit cancellation.

## Coding agents (MCP)

`odu mcp` exposes the live run over [Model Context Protocol](https://modelcontextprotocol.io). It dials the same `.ci/odu.sock` as `status`, `logs`, and `attach`; lane selection remains the coordinator's job.

The interface projects odu's [@kolu/surface](https://kolu.dev/surface/) through `@kolu/surface-mcp`. It is default-deny: only declared state and procedures reach the agent.

| Tool | Purpose |
| --- | --- |
| `run` | Start a background coordinator. Supports `supersede`, `linger`, and `no_wait`. Reuses agent-held venues without re-claiming. |
| `node_rerun` | Reset one node and its transitive dependents. |
| `node_cancel` | Cancel one node (`ci::fmt@plat`); leaves the rest of the run settling. Marks `cancelled` (not red). |
| `lane_cancel` | Drop one platform lane (`platform: aarch64-darwin`); frees a run-owned venue lease. |
| `wait_for_settle` | Return on settlement or immediately when a node goes red. Carries `sha7`, the reserved `seq`, and `unposted[]` full owed rows (`{context, lastError, attempts}` — reporting debt does not block settle). If the coordinator's socket closes before the terminal frame, the verdict comes from the run's finalized record on disk. Fails loud with no live run or an `expected_sha` mismatch. |
| `cancel` | Stop and fully tear down the live run. |
| `runs` | Read durable run history after the coordinator exits. |
| `lease` | Agent-held venue: spawn a detached holder and return immediately with `held {host}` or `waiting {behind…}`. Re-call to observe the queue. |
| `release` | Drop agent-held venue lease(s). |

Pipeline state and logs are subscribable resources rather than tools:

- `surface://streams/nodes` — `{ run, pipeline, sha7, seq, nodes[], unposted[] }`: run identity, every node's status/exit/duration/red verdict, and full owed GitHub status rows not yet confirmed.
- `surface://collections/logs/{id}` — buffered live output, or the durable log after exit.

Both support `resources/subscribe` and `notifications/resources/updated`. `wait_for_settle` is the blocking fallback for hosts that do not wake a model on notifications.

Typical agent loops:

```text
# Cross-run venue (no re-queue between iterations)
lease → run → wait_for_settle → fix → run → … → release

# Fail-fast on a live run
run → wait_for_settle → read red node log → fix → node_rerun
```

An early `wait_for_settle` response with `fail_fast_tripped: true` is not a final tally. Only `passed: true` on a fully settled run proves green.

Every observed verdict identifies its run with `sha7` and, when the coordinator reserved one, `seq`—the durable `sha7#seq` identity. Pass `expected_sha` as a full SHA or `sha7` prefix to make identity a hard check. `seq` is null only when no ordinal could be reserved. With no live run, `wait_for_settle` raises the same “no run in progress” error as `odu status`; it never returns an ambiguous empty verdict. When a run *was* observed and the coordinator's socket then closed before the terminal frame, the verdict is read from that run's finalized record — never green for a run torn down mid-flight.

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
- **Lanes are one-shot.** A broken ssh connection marks unfinished nodes `errored`. Durable logs and run records survive; live node state does not survive runner restart.
- **One run per checkout.** `.ci/odu.sock` is the lock. Use `cancel` or `--supersede` before starting another run.
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
