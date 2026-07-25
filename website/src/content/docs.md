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

Multiple OS attributes are OR-ed. Untagged recipes run on every configured lane. `odu protect` derives the same filtered status contexts for branch protection.

> **Same-OS limitation.** `just --dump` resolves OS attributes on the coordinator before odu sees the DAG. Attributes can prune a recipe from other lanes, but cannot introduce a foreign-OS recipe that was absent from the coordinator's dump. Run each OS family's exclusive recipes from a coordinator on that OS.

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
odu cancel                        cleanly stop the live run
odu runs [-o json]                read durable run history
odu hosts                         venue inventory (free / busy / held by)
odu lease [PLAT…] [--no-wait]     agent-held venue across runs
odu release [PLAT…]               drop agent-held lease(s)
odu dump | graph                  emit the resolved DAG as JSON or Mermaid
odu protect [--dry-run]           sync required GitHub status contexts
    --platform P (repeatable)     explicit repo platform set; no hosts needed
    --branch B                    branch to protect (default: repo default)
odu mcp                           serve the agent interface over stdio
```

### Cancel, supersede, and linger

`.ci/odu.sock` identifies the live run in a checkout. `odu cancel` asks the coordinator to finalize statuses, close lanes, remove the socket, and then waits for teardown.

`odu run --supersede` combines cancel and start for the common “stop this run and test the fix” move. Runs normally exit as soon as they settle; `--linger` keeps the coordinator available so a node can be retried later, then reaps it after an idle period or explicit cancellation.

## Coding agents (MCP)

`odu mcp` exposes the live run over [Model Context Protocol](https://modelcontextprotocol.io). It dials the same `.ci/odu.sock` as `status`, `logs`, and `attach`; lane selection remains the coordinator's job.

The interface projects odu's [@kolu/surface](https://kolu.dev/surface/) through `@kolu/surface-mcp`. It is default-deny: only declared state and procedures reach the agent.

| Tool | Purpose |
| --- | --- |
| `run` | Start a background coordinator. Supports `supersede`, `linger`, and `no_wait`. Reuses agent-held venues without re-claiming. |
| `node_rerun` | Reset one node and its transitive dependents. |
| `wait_for_settle` | Return on settlement or immediately when a node goes red. Carries `sha7`, the reserved `seq`, and `unposted[]` full owed rows (`{context, lastError, attempts}` — reporting debt does not block settle). Fails loud with no live run or an `expected_sha` mismatch. |
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

Every observed verdict identifies its run with `sha7` and, when the coordinator reserved one, `seq`—the durable `sha7#seq` identity. Pass `expected_sha` as a full SHA or `sha7` prefix to make identity a hard check. `seq` is null only when no ordinal could be reserved. With no live run, `wait_for_settle` raises the same “no run in progress” error as `odu status`; it never returns an ambiguous empty verdict.

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
