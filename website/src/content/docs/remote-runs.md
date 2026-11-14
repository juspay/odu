---
title: Run the server's CI from your shell
description: Start a run of the server's own checkout from any shell with a personal token, at the commit you name.
section: Use odu
order: 4
---

Every `odu ci` command talks to the odu service on the machine you are on, unless you name another. To run the server's clone of your repository from any shell, you name the server, the path on it, and the commit you believe is there.

Commands are written with the [`odu` shorthand](/docs/#quick-start).

## Start the run

1. Create a personal token on your profile page on the server. See [A token for a machine or an agent](/docs/server-mode/#a-token-for-a-machine-or-an-agent).
2. Name the server and hand it the token:

   ```sh
   export ODU_TOKEN=odu_… ODU_WEB_ORIGIN=https://odu.example.com
   ```

3. Name the checkout on the server and the commit:

   ```sh
   odu ci run --checkout /data/checkouts/<repo> --sha "$(git rev-parse HEAD)" --no-post
   ```

`--origin https://odu.example.com` on the command does the same as `ODU_WEB_ORIGIN`:

```sh
export ODU_TOKEN=odu_…
nix run github:juspay/odu/<rev> -- ci run --origin https://odu.example.com \
  --checkout /data/checkouts/<repo> --sha <sha>
```

The other `ci` commands (`status`, `wait`, `attach`, `rerun`, `cancel`, `hosts`, `lease`, `release`, `protect`) take `--origin` the same way. Each is also a control on the board and an API verb.

## What the service checks

- `--sha` is required with `--checkout`. A checkout that has moved to another commit is refused rather than run at a different commit.
- `--checkout` is refused unless you name a service, with `--origin` or `ODU_WEB_ORIGIN`. Naming is the test, not distance: an explicit `http://127.0.0.1:18440` is accepted. The default service for the directory you stand in is refused.
- Without `--checkout`, `odu ci run` runs the checkout you are in.

## Hand the server a new commit

`--branch NAME` hands the server a commit its clone has not got yet, such as one a workflow has just pushed.

1. The service fetches `origin/NAME`.
2. It refuses a dirty tree, or a commit the branch does not contain, and says both commits.
3. It puts the clone on `NAME` at that commit and runs it. The run's `_ci-setup` log says it moved.

Without `--branch`, nothing moves: a clone not already on the commit is refused. The clone is left on the branch, never on a detached HEAD, because a run's pins are read from the branch its checkout is on.

## Which machines it uses

| Your shell | What the server uses |
| --- | --- |
| `$ODU_HOSTS` names a path | That path, sent with the run. A path the server has not got is skipped, and the server falls through to its own `~/.config/odu/hosts.json`. |
| no `$ODU_HOSTS` | Nothing is sent, so the server's own configuration stands. |

## Who started it

Every run records who started it: the personal token's login, or `@local` on a service without sign-in. A login cannot contain `@`, so `@local` is never a person.

| Where | What it shows |
| --- | --- |
| the run's page | `started by <login>` |
| `odu ci history list --all` | the run, among every checkout's runs. Pass `--all`, because the checkout is on the server, not yours. |
| `run_read` | `actor` |

It records who started the run, not who may control it. Revoking a personal token stops the next call, not a run already started.
