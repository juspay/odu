---
title: CLI reference
description: Every odu command, the API verb and board control that do the same thing, and the exit codes.
section: Reference
order: 1
---

The odu CLI keeps what belongs in a shell: the `ci` commands, four cache commands and `odu auth login`. Everything else is the board or an API verb, which `odu surface` calls from a shell and `odu mcp` serves to an agent.

Commands are written with the [`odu` shorthand](/docs/#quick-start).

```
odu ci <run|wait|rerun|cancel|logs|history|status|attach|hosts|lease|release|dump|graph|protect>
odu ci history <list|show|import|prune>
odu cache <use|login|push|target>
odu auth login <origin> [--token T]
odu web [--background] [--upgrade]
odu surface <row> <verb…>
odu mcp
```

## Commands

The board and the API do everything the `ci` commands do. The cache, auth and web commands act on the machine you type them on.

| Command | API verb | On the board | What it does |
| --- | --- | --- | --- |
| [`odu ci run`](#odu-ci-run) | `run_start` | **New run** | Starts a run and watches it. |
| `odu ci status`, `odu ci attach` | — | the run list, a run's page | Shows this checkout's newest unfinished run. `attach` follows it until it stops moving. `-o json` for machine output. |
| [`odu ci wait`](#odu-ci-wait) | `run_wait` | a run's page, live | Waits, bounded, for the first failure you can act on. |
| `odu ci rerun [--run R] SELECTOR` | `run_retry` | a node's **Retry** | Retries with unchanged inputs. `--expect-attempt N`, `--request-id ID`. |
| `odu ci cancel [--run R] [node\|@platform]` | `run_cancel` | **Cancel run**, **Cancel node**, a lane's cancel | Cancels the whole run by default. `--request-id ID`. |
| `odu ci logs KEY` | `log_read` | a node's log | `-f` follows, `--offset B`, `--limit B`. Tail with `--offset=-4096`. `--stream push` reads the node's push. `--wait-ms N` waits up to N ms for more of the log. |
| `odu ci history list\|show\|import\|prune` | `catalog_import`, `catalog_prune` | **History**, **Maintenance** | Lists the run history, and imports or expires it. |
| `odu ci hosts [PLAT…]`, `odu ci lease`, `odu ci release` | `venue_probe`, `venue_hold`, `venue_release` | **Machines** | Shows the machines and who holds them, and holds or releases one. Naming platforms probes only those. `lease --no-wait` does not queue behind a holder. |
| `odu ci dump`, `odu ci graph` | `pipeline_read` | **New run** → **Preview pipeline** | Prints the resolved pipeline, as JSON or as Mermaid. |
| `odu ci protect` | `protect_apply` | **Maintenance** → **Apply protection** | Sets GitHub's required checks. Preview with `--dry-run`. `--branch B` picks another branch than the default, `--platform P` the platforms, and `--create` makes the branch's ruleset if it has none. |
| `odu cache use`, `login`, `push`, `target` | — | — | The cache's four shell commands. See the cache's [command reference](/docs/cache/reference/#commands). |
| `odu auth login <origin>` | — | — (a machine's disk) | Saves a personal token in `~/.config/odu/auth/credentials`. |
| `odu web` | — | — | Serves the board. See [The web service and the board](/docs/web-service/). |
| `odu surface <row> <verb…>` | every verb | — | Calls any API verb from a shell. |
| `odu mcp` | every verb | — | Serves the API verbs to an agent over stdio. See [Coding agents](/docs/agents/). |

For `ci wait`, `ci rerun` and `ci cancel`, an omitted `--run` means `latest` in this checkout. A run address is also a run ID or `<sha7>#<seq>`, and `odu ci history list` lists runs.

### `odu ci run`

Starts a run and watches it. <kbd>Ctrl</kbd> + <kbd>C</kbd> stops watching; the run continues.

```
odu ci run [recipe[@platform]…] [flags]
```

| Flag | What it does |
| --- | --- |
| `--host P=ADDR` | Runs platform `P` on `ADDR`, such as `x86_64-linux=localhost`. |
| `--platform P` | Runs only platform `P`. Repeatable. |
| `--root NAMEPATH` | Sets the justfile root, the board's **Justfile root**. |
| `--checkout ABS`, `--sha SHA` | Runs a checkout on the service's machine at that commit. Needs the service named by `--origin` or `ODU_WEB_ORIGIN`. |
| `--branch NAME` | With `--checkout`, lets the service fetch and move its clone onto `NAME` at `--sha`. |
| `--no-deps` | Runs only the named recipes, not what they need. |
| `--no-post` | Posts no GitHub statuses. |
| `--no-strict` | Runs a snapshot of the working tree. Posts nothing. |
| `--no-snapshot` | Runs the working tree in place, on localhost only. |
| `--no-wait` | Starts the run and returns. |
| `--linger` | Keeps the run answerable after it settles. |
| `--supersede` | Cancels the checkout's live run and starts this one. |
| `--request-id ID` | Names the request, so a retry after a lost reply is not a second run. |
| `--progress json` | Prints the run's progress as JSON lines instead of watching. |
| `-o json` | Prints the result as JSON. |

- odu pushes every recipe's `result*` closure to the odu cache your `flake.nix` already reads from. See [What a run pushes](/docs/your-repository/#what-a-run-pushes).
- `--checkout`, `--sha` and `--branch` are explained in [Run the server's CI from your shell](/docs/remote-runs/).
- `--no-strict` and `--no-snapshot` are explained in [Run uncommitted changes](/docs/daily-workflow/#run-uncommitted-changes).

### `odu ci wait`

Waits until a run gives you something to act on, or the deadline passes. It returns on the first failure, before the other nodes settle.

```
odu ci wait [--run R] [--after CURSOR] [--deadline-ms N] [--settle] [--expected-sha SHA] [-o json]
```

`--timeout-ms` is another name for `--deadline-ms`. Its exit codes are in [Exit codes](#exit-codes).

## API verbs without a command

Cache, people and tunnel administration has no CLI command. Use the board, or call the verb with `odu surface <row> <verb> --input '{…}' --json`. A **row** is one part of the service (`ci`, `cache`, `auth`, `cloudflare`, `metrics`), and its verbs are typed after its name.

| You want | API verb | On the board |
| --- | --- | --- |
| administer the cache | `odu surface cache …`, listed in the [cache command reference](/docs/cache/reference/) | **Cache**, and a bucket's page (admin) |
| personal tokens and sessions | `odu surface auth token_create\|token_list\|token_revoke` | the profile page |
| roles, and who you are | `odu surface auth user_grant`, `odu surface auth grant_list`, `odu surface auth user_whoami` | **People** (owner) |
| the tunnel and its names | `odu surface cloudflare status_read` | **Tunnel** |
| metrics tokens | `odu surface metrics token_mint\|token_list\|token_revoke` | — (see [Metrics](/docs/metrics/)) |
| the runs, filtered by checkout, commit and seq | `run_list` | the run list |

The run verbs are typed bare: `odu surface run_start …`. `odu surface --help` prints every verb's input schema.

## Exit codes

`odu ci wait` spends its exit codes on what CI says:

| Exit | Meaning |
| --- | --- |
| 0 | passed |
| 1 | a failure to act on |
| 2 | still running, nothing red yet |
| 3 | the run's owner was lost before it finished |
| 4 | no such run, or its evidence expired |
| 5 | the request was refused |

`odu surface` spends its exit codes on the call:

| Exit | Meaning |
| --- | --- |
| 0 | answered, even when the answer says CI failed |
| 1 | refused, with one JSON line on stderr |
| 2 | a usage error |
| 3 | nothing is serving: run `odu web --background` |
