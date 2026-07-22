# Documentation

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
 ├─ per-platform lane:
 │    copy the runner closure → realise on the host →
 │    ssh host odu-runner --stdio → configure over the surface →
 │    fetch the pushed SHA → run each node with just --no-deps
 ├─ fan-in: merge lane state and serve it on .ci/odu.sock
 ├─ logs: .ci/<sha>/<platform>/<recipe>.log
 ├─ record: .ci/<sha>/runs/<seq>.json
 └─ GitHub: one commit status per recipe@platform transition
```

A remote lane needs **ssh, Nix, and outbound HTTPS**. The runner travels as a Nix closure, the toolchain comes from the repository's dev shell, and the source arrives by `git fetch` of the pushed SHA.

The runner derivation belongs to odu, not the target repository. `ODU_RUNNER_FLAKE` is baked into the `odu` binary at build time, so coordinator and runner always ship together and share the exact RPC contract.

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
$ODU_HOSTS → ~/.config/odu/hosts.json → ~/.config/justci/hosts.json
```

If none configures a platform, `odu run` refuses and prints both the resolution chain and the ways to opt in. It never silently runs the pipeline on your workstation.

Run locally on purpose by naming the platform's lane `localhost` for one run or in a hosts file:

```sh
odu run --host x86_64-linux=localhost
```

```json
{ "x86_64-linux": "localhost" }
```

A localhost lane runs directly against your toolchain and skips the Nix closure copy.

### Fan out across machines

Define platform lanes in `~/.config/odu/hosts.json`, or point `$ODU_HOSTS` at another file:

```json
{
  "x86_64-linux": "my-linux-builder",
  "aarch64-darwin": "me@mac-mini.local"
}
```

Keys are Nix system tuples. Values are anything ssh can dial, or `localhost`. A bare `odu run` fans out to every configured platform. Platforms absent from an existing hosts file are intentionally omitted: a partial configuration is still a decision. Use `--platform P` to select a subset or `--host P=ADDR` to pin or add a lane for one run.

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

odu status [-o json]              snapshot the live run
odu logs [-f] <node>              replay and optionally follow a node log
odu attach [-o json]              attach the live dashboard or event stream
odu cancel                        cleanly stop the live run
odu runs [-o json]                read durable run history
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
| `run` | Start a background coordinator. Supports `supersede` and `linger`. |
| `node_rerun` | Reset one node and its transitive dependents. |
| `wait_for_settle` | Return on settlement or immediately when a node goes red. Carries `sha7` and the reserved `seq`, and fails loud with no live run or an `expected_sha` mismatch. |
| `cancel` | Stop and fully tear down the live run. |
| `runs` | Read durable run history after the coordinator exits. |

Pipeline state and logs are subscribable resources rather than tools:

- `surface://streams/nodes` — `{ run, pipeline, sha7, seq, nodes[] }`: run identity and every node's status, exit, duration, and red verdict.
- `surface://collections/logs/{id}` — buffered live output, or the durable log after exit.

Both support `resources/subscribe` and `notifications/resources/updated`. `wait_for_settle` is the blocking fallback for hosts that do not wake a model on notifications.

The fail-fast loop is:

```text
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

Each terminal run writes a `(repo, sha, seq)` record to `.ci/<sha>/runs/<seq>.json`, including interrupted runs. Use `odu runs -o json` to inspect old outcomes and per-node results.

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

odu grew from kolu's `mini-ci` example and replaced [justci](https://github.com/juspay/justci) as Kolu's CI without changing its branch-protection status contexts or log layout.

Read [Introducing odu](https://kolu.dev/blog/odu/) for the design story and live demos, explore the framework at [kolu.dev/surface](https://kolu.dev/surface/), or see the original Atlas comparison: [A CI runner you attach to](https://htmlpreview.github.io/?https://raw.githubusercontent.com/juspay/kolu/master/docs/atlas/dist/mini-ci-vs-justci.html).
