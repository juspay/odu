---
title: Use odu from your repository
description: What a repository declares to run its CI on odu, push its builds to an odu cache, and require odu's checks on GitHub.
section: Use odu
order: 1
---

Your repository declares the Nix cache it reads from and tags one `just` recipe as its pipeline. odu runs that pipeline, posts a GitHub status per recipe and platform, and pushes what each recipe built to that cache.

| File | What it declares |
| --- | --- |
| `flake.nix` | the cache, in `nixConfig` |
| `justfile` | the pipeline, as a recipe tagged `[metadata("ci")]` |
| a GitHub workflow, only if you need one | a cache token, for a system odu has no lane for |
| `plugin.json` | odu for your coding agents |

Nothing else in your repository mentions odu. [`examples/consumer/`](https://github.com/juspay/odu/tree/master/examples/consumer) shows these files whole, and the snippets below are excerpts of them. Every developer and every CI machine then substitutes from the cache.

## 1. Declare the cache once

```nix
# flake.nix
nixConfig = {
  extra-substituters = "https://cache.example.com/main";
  extra-trusted-public-keys = "main-1:7KmFrK05rVrnxkyZi9hJGnJJmRCpg87u6MUQIk7nokQ=";
};
```

Both lines come from the bucket's **Set up** block on the board, or from `odu cache use main`. A reader of your flake needs this `nixConfig` anyway. odu reads it; it is not an odu setting.

odu applies these rules to it:

- The substituter must be a bucket your odu service serves: the bucket's URL under the service's public origin, or a domain bound to the bucket. odu decides from the URL alone and believes nothing another server says about itself.
- A URL the service does not serve is left alone. The run still runs without pushing, its `_ci-setup` node says so once, and its page says `not pushing`.
- Name one odu cache. A run whose flake names two is refused at start, because a repository builds for one cache. A replay of such a run runs without pushing instead.
- The key you list must be the bucket's current key, or the run warns.
- A private bucket works the same way. Each reader needs a cache token in their netrc, and `odu cache use` prints the lines. A run's push needs nothing from you.

## 2. Tag the pipeline

```just
[metadata("ci")]
default: build test lint docs e2e
```

The tagged recipe's dependency graph is the pipeline. odu runs each leaf with `just --no-deps`, in dependency order, on lanes. A **lane** is one platform's share of a run, on one machine. Everything else about `just` keeps working:

| You write | odu does |
| --- | --- |
| `[linux]` / `[macos]` on a recipe | Schedules it on that platform only, and drops the edges it cannot honour. `odu ci protect` requires the same filtered set. |
| `[metadata("odu:shard=4")]` on a leaf | Runs up to four copies with `ODU_SHARD_INDEX` (0-based) and `ODU_SHARD_TOTAL` (actual), under one GitHub context. |
| `[metadata("odu:pin")]` on a recipe | Pins that recipe's closure in the cache, so it outlives retention. See [Keep your default branch's build](#keep-your-default-branchs-build). |
| `nix build … --out-link result-foo` inside a recipe | Pushes that closure. See [What a run pushes](#what-a-run-pushes). |

> `just` hides a recipe whose OS attribute does not match the machine reading the file. A `[linux]` recipe the root depends on makes `just --dump` refuse your justfile on a Mac. Use an OS attribute only where the service's platform admits it; otherwise check the OS inside the recipe.

`examples/consumer/` uses no OS attribute for this reason.

### Shard a leaf

Only a leaf may shard, and the recipe divides its own work:

```just
[metadata("odu:shard=2")]
e2e: build
    just test-slice "$((ODU_SHARD_INDEX + 1))/$ODU_SHARD_TOTAL"
```

`ODU_SHARD_TOTAL` may be below the number in the attribute when capacity is short, so the recipe reads the variable.

### What a run pushes

When a recipe exits 0, odu pushes every `result*` in the directory it ran in, closure and all, to the cache your `flake.nix` names. A recipe that leaves no `result*` pushes nothing. A push that fails turns the node red, so a green node means its outputs are in the cache.

- Nothing goes in any recipe and no token goes in your repository. Each run gets its own cache token, scoped to that one bucket.
- The run's cache token is revoked as soon as nothing serves the run, and expires after 24 hours in any case. A run kept answerable after it settles (`--linger`) keeps it, because a retry still pushes.
- Each path a run pushes records the run and the commit it was built from, and the bucket's page shows both.
- `run_read` returns `push`: the bucket and how much landed, or `target: null` and the reason.
- Any checkout the service runs may push to any bucket it serves. The operator decides which checkouts the service runs.

To read a failed push, see [When a push fails](/docs/daily-workflow/#when-a-push-fails).

### Keep your default branch's build

`[metadata("odu:pin")]` on a recipe pins its closure under `<owner>/<repo>@<ref>/<system>`. A [pin](/docs/cache/retention/) is never collected.

- Bare, the attribute means your repository's default branch, read from the checkout's own git.
- `[metadata("odu:pin=release-1.x")]` names a ref instead. Repeat the attribute to name more refs, one each, the way `just`'s own `[group(…)]` repeats: `[metadata("odu:pin")] [metadata("odu:pin=release-1.x")]`.
- A run on another ref pushes and pins nothing. A run on no ref at all says why on its `_ci-setup` node.
- A recipe that had a path refused is not pinned.
- The [push action](/docs/cache/github-actions/) derives the same name, so a run and a workflow re-point one pin per system.

## 3. Run it

From a clean checkout:

```sh
nix run github:juspay/odu/<rev> -- ci run                   # all platforms the lanes offer
nix run github:juspay/odu/<rev> -- ci run --platform x86_64-linux
nix run github:juspay/odu/<rev> -- ci run test@aarch64-darwin
```

`ci run` starts a run, posts statuses as nodes settle, pushes as recipes finish, and watches. <kbd>Ctrl</kbd> + <kbd>C</kbd> stops watching, and the run continues. The board at the service's origin shows it live.

`<rev>` is a 40-character commit, the same one your push action (step 4) and your `plugin.json` (step 6) name. Bump them together. A floating `github:juspay/odu` follows master, and master renames things on a major.

A run needs machines: see [The machines a run uses](/docs/machines/). To run the server's clone of your repository from any shell, see [Run the server's CI from your shell](/docs/remote-runs/).

## 4. When you still need a GitHub workflow

You need one only when odu has no lane for a system you ship, or you want GitHub Actions' builders for some other reason. The push is one step:

```yaml
- uses: juspay/odu/.github/actions/push@<rev>
  with:
    token: ${{ secrets.ODU_CACHE_TOKEN }}
```

It pushes to the cache your `flake.nix` names, with the cache token from your secret, and pins on your default branch. [Push from GitHub Actions](/docs/cache/github-actions/) has every input.

## 5. Require it

```sh
nix run github:juspay/odu/<rev> -- ci protect            # the default branch
nix run github:juspay/odu/<rev> -- ci protect --dry-run  # print the contexts
```

`ci protect` sets the branch's required status checks to exactly the contexts odu posts: `<recipe>@<system>` for every node the pipeline schedules. Run it again after renaming a recipe. A workflow's own contexts are yours to add. On the board, **Maintenance** → **Apply protection** does the same.

## 6. Agents

Put odu in your repository's `plugin.json`, the Agent Plugin file at the repository root. agent-distro reads it when an agent (Claude Code, Codex, omp, Pi, OpenCode) starts in the checkout. Each agent then gets odu's MCP server and skill with no setup:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "<your repo>",
  "extensions": { "asia.nixos.agent-distro": { "plugins": ["github:juspay/odu/<rev>"] } }
}
```

The API verbs are the same as the CLI's and the board's: `run_start`, `run_wait`, `run_read`, `log_read`, `run_retry`, `pipeline_read`, `venue_probe`, and the cache's. [Coding agents](/docs/agents/) has the loop the skill teaches.

## 7. What you see afterwards

- **A run's page**: the pipeline, each node's log, and a push step per recipe naming the bucket and the paths it pushed.
- **A bucket's page**: paths grouped by package, pins by name, what the next collection would take, storage and reads.
- **A path**: the commit it was built from and a link to the run that pushed it, where the push stated them. See [Say what built a path](/docs/cache/push/#say-what-built-a-path).
- **GitHub**: one status per `<recipe>@<system>`, linking to the node's log.

## 8. What odu promises you

- The files above are the whole contract. `flake.nix` names the cache, `justfile` names the work, and a workflow, if you have one, names a cache token.
- Majors rename and minors add. Within a major, every verb, flag, input and metadata key on this page keeps working. A client is told, by name, when the service it reaches is a major ahead. See [Contract versions](/docs/contract-versions/).
- A push is verified or red. Nothing counts as pushed that the cache does not then serve.
- Your default branch stays substitutable. A pinned closure is never collected. Everything else stays 90 days, by default, after a push last asked for it.
- Lanes hold no credentials of yours. The run's cache token is odu's, scoped to that bucket, and dies with the run.

## 9. What to ask your operator for

The person running odu does these once per repository. Nothing here is in your tree.

- A bucket, a write cache token for your workflow if you have one, and the two `nixConfig` lines.
- A checkout of your repository on the server, for the service to run.
- The lanes trusting the bucket's key: the same two lines, in their own Nix configuration.
