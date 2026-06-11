# odu

<img src="./logo.svg" width="128" align="right" alt="odu — $ odu with a live pipeline: two nodes green, one running" />

**A CI runner you attach to.** odu (Tamil ஓடு — *run*) runs your
[`just`](https://just.systems) recipe DAG across machines, posts GitHub
commit statuses, and — unlike every batch CI tool — holds the run as **live,
typed state you can attach to** from a terminal dashboard while it runs.

```
$ odu run                      # the whole DAG — local by default, or every configured platform
$ odu attach                   # attach a live dashboard to the run (other terminal)
$ odu logs -f e2e@x86_64-linux # follow one node's output
```

> [!TIP]
> New here? Read the announcement — [**Introducing odu**](https://kolu.dev/blog/odu/) — for the story behind it and **video demos** of a live run and the agent face.

## Why

Local CI tools translate your task graph into a batch process, run it, and
leave you log files. Want to know what's happening mid-run? You scrape logs
or poll a process supervisor's socket with a separately-versioned client.

odu inverts that. The runner *owns* the pipeline as state and serves it as
three typed primitives over plain ssh (an [oRPC](https://orpc.io) contract,
base64-framed over stdio — no daemons, no ports, no agents to install):

| Primitive | Call | What it carries |
| --- | --- | --- |
| **Cell** | `surface.nodes.get({})` | The whole pipeline's state — one snapshot, then deltas as nodes change. |
| **Stream** | `surface.nodeLog.get({ id })` | One node's output — a buffered snapshot first (late subscribers replay from the top), then appends. |
| **Procedure** | `surface.node.rerun({ id })` | The *only* mutation: reset a node + its transitive dependents and reschedule. |

Every face is a thin adapter over the same contract: the bundled terminal
dashboard and an **MCP server for coding agents** (`odu mcp`) today; a web
dashboard is designed on the same surface (see the roadmap below).

## How a run works

```
odu run  (coordinator, your machine)
 ├─ strict gate: refuse a dirty tree, pin HEAD via `git worktree`
 ├─ ingest: `just --dump` → the [metadata("ci")] recipe's dependency DAG
 ├─ per platform lane (hosts.json):
 │    nix copy the runner derivation → realise on the host →
 │    ssh host odu-runner --stdio → configure over the surface →
 │    the host fetches your pushed SHA into a writable per-SHA workspace
 │    and runs each node as `just --no-deps <recipe>`
 ├─ fan-in: lane states merge into one surface, served on .ci/odu.sock
 │    (odu status / logs / attach dial it, live)
 ├─ logs: .ci/<sha>/<platform>/<recipe>.log — durable even if the runner dies
 └─ GitHub: commit status per <recipe>@<platform> context, posted on
    transitions read from the state cell (credentials never leave your machine)
```

A lane host needs **ssh + Nix + outbound https**. Nothing else: the runner
binary travels as a Nix closure, the toolchain comes from your repo's dev
shell, and the source arrives by `git fetch` of the pushed SHA.

## Install / run

Nothing to install — run odu straight from the flake against the current repo:

```sh
nix run github:juspay/odu -- run               # a strict CI run
nix run github:juspay/odu -- run --no-strict   # dev iteration: dirty tree OK, no GitHub writes
```

## Configure your repo

### Tag the pipeline DAG

Exactly one recipe carries `[metadata("ci")]`; its dependency closure *is* the
pipeline odu runs:

```just
[metadata("ci")]
default: build test lint
```

### Where the lanes run

**Local (the default).** With no hosts configured, `odu run` runs the whole
pipeline on *this* machine — it detects your Nix system and uses a `localhost`
lane, which runs directly against your toolchain (skipping the Nix closure
copy). Nothing to set up:

```sh
odu run            # → "no hosts configured — running locally on aarch64-darwin"
```

This single-machine case is what most users want, and most never need more.

**Multi-platform (fan out across machines).** To run each platform's lane on a
real builder for that platform, list them in `~/.config/odu/hosts.json` (or set
`$ODU_HOSTS` to a hosts file elsewhere — its value is a filesystem path to a
JSON file in this same format, taking precedence over the default location):

```json
{
  "x86_64-linux": "my-linux-builder",
  "aarch64-darwin": "me@mac-mini.local"
}
```

Keys are Nix system tuples; values are anything ssh can dial, or `localhost`.
A bare `odu run` then fans out to **every** configured platform at once;
missing platforms simply drop from the fanout, and `--platform P` slices to a
subset. The real-world example is **kolu**, which builds on both Linux and
macOS: its CI keys an `x86_64-linux` and an `aarch64-darwin` lane, and its
warm-pool lease (`ci/pu/run.sh`) injects the leased box per run with
`--host PLAT=ADDR` (which pins or adds a platform for one run, on top of the
file).

**Scope a recipe to specific platforms.** By default every recipe runs on
every configured platform. To restrict one to an OS family, tag it with
`just`'s built-in [OS attributes](https://just.systems/man/en/attributes.html)
— `[linux]`, `[macos]`, or `[unix]` (Linux + macOS):

```just
[macos]
codesign:
    ./sign.sh         # only ever scheduled on a *-darwin lane

[linux]
nix-bundle:
    nix bundle .#app  # only ever scheduled on a *-linux lane
```

A tagged recipe is pruned from the lanes whose OS it doesn't name, and
**so is anything that depends on it** — a step needing a `[linux]`-only recipe
drops from the macOS lane too, so no lane is ever left a node whose dependency
was pruned. Multiple OS attributes are OR-ed (`[linux]` + `[macos]` ⇒ both),
and an untagged recipe still fans out everywhere.

## CLI

```
odu run [recipe[@platform]…]      run (selectors compose; bare names fan out
                                  to every platform)
    --platform P (repeatable)     slice the fanout
    --host P=ADDR (repeatable)    one-shot host pin
    --root NAMEPATH               alternative DAG root
    --no-deps                     skip the dependency closure
    --no-post                     strict, but no GitHub writes
    --no-snapshot                 live tree, implies --no-post
    --no-strict                   ≡ --no-snapshot --no-post (dev iteration)
    --progress json               one NDJSON line per node transition
odu status [-o json]              snapshot a live run
odu logs [-f] <node>              replay (+ follow) one node's log
odu attach [-o json]              live dashboard (tty); piped, -o json
                                  matches run --progress json, else run's
                                  plain transition stream
odu dump | graph                  resolved pipeline as JSON / Mermaid
odu protect [--dry-run]           sync branch protection's required contexts
odu mcp                           serve the agent face (MCP server, stdio)
```

**Strict by default**: a real CI run refuses a dirty tree, tests the pinned
HEAD commit, posts statuses. The opt-outs exist for dev iteration, not CI.

## Drive CI from an agent (MCP)

`odu mcp` serves odu's surface as an [MCP](https://modelcontextprotocol.io)
server over stdio, so a coding agent (Claude Code, Codex, opencode, Gemini CLI)
drives CI with structured calls instead of scraping your terminal. It is
*in-band*, like `status` / `logs` / `attach`: it dials the `.ci/odu.sock` of a
run in the current repo and predetermines no host — which boxes run the lanes
stays the coordinator's job (pool lease / `hosts.json`).

The face is a projection of odu's own [`@kolu/surface`](https://github.com/juspay/kolu)
through [`@kolu/surface-mcp`](https://github.com/juspay/kolu): the coordinator
surface is re-exposed as a default-deny MCP face — only what's declared reaches
the agent.

| Tool | What it does |
| --- | --- |
| `run` | Start a run (background coordinator) and return once it's live. |
| `node_rerun` | Reset a node + its dependents and reschedule (the only mutation). |
| `wait_for_settle` | Block until the run settles, or — fail-fast — the instant a node goes red. |

The pipeline snapshot and per-node logs are **subscribable resources** rather
than tools: `surface://streams/nodes` (the pipeline as `{ run, pipeline, nodes[] }`
— every node's status / exit / duration + the `red` verdict bit) and
`surface://collections/logs/{id}` (one node's output — the live buffered
snapshot while a run is up, else the durable per-SHA log). Both support
`resources/subscribe` + `notifications/resources/updated` on every transition.
`wait_for_settle` is the blocking-pull floor for hosts that don't wake the model
on a notification.

The agent loop is `run` → `wait_for_settle` (fail-fast) → read the red node's
`surface://collections/logs/{id}` → fix → `node_rerun`. Declare it over stdio:

```jsonc
// .mcp.json (Claude Code; Codex / opencode / Gemini CLI take the same shape)
{ "mcpServers": { "odu": {
  "type": "stdio",
  "command": "nix",
  "args": ["run", "github:juspay/odu", "--", "mcp"] } } }
```

Repos that manage agent config with [APM](https://github.com/juspay/apm) get
this wired automatically by depending on `juspay/odu`: odu's `apm.yml` declares
the MCP server, deploying the `odu-mcp` launcher and the `.mcp.json` entry into
the consumer's tree (set `ODU_FLAKE=.#odu` to use a repo's own pinned odu
instead of `github:juspay/odu`).

## Honest notes

- **Pushed SHAs only on remote lanes.** Hosts fetch your commit from the
  origin remote (anonymous https). odu does not ship git bundles, so a
  remote lane can't test an unpushed commit. Localhost lanes can.
- **Live-tree mode is localhost-only.** `--no-snapshot`/`--no-strict` run the
  live working tree, but only a localhost lane sees it — a remote lane still
  fetches the committed HEAD. So on a *dirty* tree odu refuses remote lanes in
  live mode rather than hand back a verdict that silently tested stale code;
  slice to local platforms with `--platform`, or commit+push for a remote run.
- **One-shot lanes.** If the ssh link to a lane dies mid-run, that lane's
  unfinished nodes are marked `errored` (GitHub state `error`) and the run
  fails — live state does not survive a runner restart in Phase 1; the
  per-SHA log files do.
- **One run per checkout.** `.ci/odu.sock` is the lock; a second `odu run`
  in the same checkout refuses to start.
- **Idle attach is not here yet.** `odu status` with no live run exits 1;
  a long-lived idle runner you can attach to is Phase-2 territory.

## Developing

```sh
just install     # pnpm install + hydrate @kolu/* from the npins kolu pin
just typecheck
just test        # the loopback falsifiability suite
just run -- run --no-strict fmt   # one recipe, locally, against the live tree
```

odu consumes the [`@kolu/surface`](https://github.com/juspay/kolu/tree/master/packages/surface)
libraries **upstream, not vendored** — the
[drishti](https://github.com/srid/drishti) pattern: `npins` pins
`juspay/kolu`, `nix/overlay.nix` extracts each package as a store path, and
`scripts/hydrate-kolu-packages.sh` copies the raw TypeScript into
`node_modules/@kolu/` (`just update-pins` to advance the pin). The repo runs
its own CI with itself: `nix run .#odu -- run` against the
`[metadata("ci")]` DAG in `ci/mod.just`.

## Lineage and roadmap

odu grew out of kolu's `mini-ci` example, replaced
[justci](https://github.com/juspay/justci) as the kolu repo's own CI
([juspay/kolu#1252](https://github.com/juspay/kolu/pull/1252) — same status
contexts, same per-SHA log layout, same strict-mode flag table, so the
migration was invisible to branch protection), and then graduated here, the
way kolu's remote-process-monitor example became
[drishti](https://github.com/srid/drishti). The design history, the justci
comparison, and the phased roadmap (the web face) live in the kolu Atlas:
[*A CI runner you attach to*](https://htmlpreview.github.io/?https://raw.githubusercontent.com/juspay/kolu/master/docs/atlas/dist/mini-ci-vs-justci.html).

License: AGPL-3.0-or-later.
