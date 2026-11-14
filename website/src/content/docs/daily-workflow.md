---
title: Daily workflow
description: Run CI, read a failure's log, retry, cancel, run uncommitted changes, and keep GitHub in step, from the shell or the board.
section: Use odu
order: 3
---

This page is the loop you repeat: start a run, wait for something to act on, read its log, then retry or fix. It also covers runs of uncommitted changes and what odu tells GitHub.

Commands are written with the [`odu` shorthand](/docs/#quick-start).

## Run and watch

```sh
odu ci run                      # configured platforms, clean commit, GitHub statuses
odu ci run --no-post            # clean commit, no GitHub writes
odu ci run --no-strict          # snapshot working tree on every lane, no GitHub writes
odu ci attach                   # interactive terminal view
odu ci status -o json
odu ci wait --run latest -o json
```

`ci wait` reports a failure you can act on before the other nodes settle. Its exit codes are in the [CLI reference](/docs/cli/#exit-codes).

## Read a failure's log

`ci wait` gives you the failure's `logKey`. Read it with `odu ci logs KEY`, and add `-f` to follow it. A page of the log carries `nextOffset`, `eof` and `open`: keep reading until `eof` is true and `open` is false.

## When a push fails

A recipe's push is a separate step on the run's page, with its own log. A failed push turns the node red even when the recipe passed, so a green node means its outputs are in the cache. The node's duration counts the recipe only.

| To read | On the board | CLI | API verb |
| --- | --- | --- | --- |
| the recipe's output | the **Recipe** tab | `odu ci logs KEY` | `log_read` |
| the push's output | the **Push** tab | `odu ci logs KEY --stream push` | `log_read` with `stream: "push"` |

The push step names the bucket, the paths it pushed, the paths the bucket already had, the bytes and the time.

## Retry, cancel, or start again

```sh
odu ci rerun --run latest test   # unchanged inputs: retry a flake
odu ci cancel --run latest      # explicit cancellation
```

- A retry is a new attempt while the run is live, or a linked replay after it finished. odu decides, and says which.
- `--linger` keeps a finished run answerable, but a replay does not need it.
- A retry may be refused for an old run without a record of where it ran, or for a run of uncommitted changes. The refusal says why.
- A source fix is a new run: commit it and run again. Without `--supersede`, odu returns the checkout's live run. With it, odu cancels that run and starts yours.

## Before you call CI green

Check three things. A passing subset does not mean the whole pipeline passed.

1. The commit is the one you meant.
2. The run covered the recipes and platforms you meant.
3. odu owes GitHub no statuses. `odu ci status` shows what a run still owes.

## Run uncommitted changes

`--no-strict` captures your working tree into a commit of its own and runs that on every lane. It never posts GitHub statuses, even on a clean tree.

- It captures tracked changes, deletions, file modes, symlinks and new files that are not ignored. It never stages your index, moves HEAD or pushes.
- Every machine and shard runs the same snapshot, named `contentSha`. The base commit stays `sha`.
- The board, `run_wait` and `run_read` show `contentSha` when it differs from the base. Compare both when you verify a result.
- The same edits again can reuse what the remote machines already hold. Changed content is a new `contentSha`. Each edit needs a new request ID.
- A finished snapshot run cannot be replayed: start a new run. A retry while it is live keeps the snapshot.

`--no-snapshot` overrides it and runs the tree in place, on localhost only, including ignored dependencies and build outputs.

### What a snapshot leaves out

- It always excludes `.ci/` and ignored files.
- A sparse checkout or a change inside a submodule is refused.
- Git clean filters apply. LFS files travel as pointers and are not smudged on remote machines.
- Any Git error fails the capture.
- For remote machines, odu packs a bundle that includes unpushed history. `ODU_SNAPSHOT_MAX_BYTES` caps it at 64 MiB, and an oversized bundle names its largest paths.
- A run on local machines only needs no origin and packs no history.
- A stale fetch may need `git fetch --prune origin`.

## History

Logs and records of each attempt outlive the checkout and the run, until retention removes them. An imported or expired run may not be replayable.

```sh
odu ci history list --all
odu ci history show --run latest
odu ci history import --dry-run
odu ci history prune --days 30 --dry-run
```

On the board, **History** on the run list shows every run. **Maintenance** imports and prunes, and each starts as a dry run until you untick it.

## GitHub statuses and required checks

A run on a clean commit posts a `<recipe>@<platform>` commit status for each node, with the `gh` credentials the service has. `odu ci protect` makes those contexts the branch's required checks.

```sh
odu ci protect --dry-run
odu ci protect
```

Read the dry run first. It works out the contexts without contacting GitHub, so its repository and branch may be null. On the board, **Maintenance** → **Apply protection** does the same.
