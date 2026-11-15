---
title: Push from GitHub Actions
description: Push a workflow's builds to an odu bucket with odu's push action, which verifies every path it pushed and pins your default branch.
section: Binary cache
order: 2
---

odu ships a GitHub Action that pushes a workflow's builds to a bucket in one step. It pushes with its own odu, built from the revision you pin the action to, then checks that every path it pushed is served.

## Add the step

Install Nix in an earlier step, then:

```yaml
# .github/workflows — Nix installed in an earlier step
- uses: juspay/odu/.github/actions/push@<odu-revision>
  with:
    cache: https://odu.example.com/cache/main
    token: ${{ secrets.ODU_CACHE_TOKEN }}
    pin: ${{ github.ref_name == github.event.repository.default_branch }}
```

A bucket's **Set up** → **GitHub Actions** tab prints this block with its own substituter URL. It fills in the revision with the commit its service was built from, so the pusher matches the cache. A service that cannot say which commit it is from leaves the placeholder.

Nix must already be on the runner: the action never installs it. The `extra_nix_config` lines from [Use it](/docs/cache/#use-it) go in your install step's `nix_conf`.

## The inputs

| Input | What it does |
| --- | --- |
| `cache` | The bucket's substituter URL, the line your `nix.conf` already has. Leave it out to use the cache your `flake.nix` names. |
| `token` | A write cache token for that bucket, from a secret. |
| `paths` | What to push. Leave it out to push the whole flake. |
| `pin` | Whether to pin what this push landed. Leave it out to pin on your default branch only. |

### `cache`

The push origin and the bucket are read from `<cache>/nix-cache-info`, which states them: see [The cache describes itself](/docs/cache/protocol/#the-cache-describes-itself). A cache that does not state them refuses the step, naming the URL it asked.

Left out, the step asks `odu cache target` for the one odu substituter in your `flake.nix`'s `nixConfig`, and pushes to it by name, with your cache token. No odu cache there, or two, fails the step, naming what it found. Name `cache:` when:

- the workflow builds for a cache your flake does not list, or
- the bucket is private. The step looks up the flake's cache without a cache token, and a private bucket's `nix-cache-info` answers nobody without one.

### `token`

Mint a write cache token on the bucket's page under **Tokens** → **Mint token**, with scope `write`, and store it as a secret. The action never prints it and never tests it in an `if`. Left empty, what happens depends on the event:

| Event | With no cache token |
| --- | --- |
| `pull_request` | builds the paths, pushes nothing, says so, and succeeds. A pull request from a fork has no secret. |
| `push` | fails, naming the missing secret, because a push is where the job must publish |

### `paths`

With no `paths`, the whole flake goes: every `packages.<system>`, `devShells.<system>` and `checks.<system>` output for the runner's system. Nix lists them, so an output you add is pushed next time.

Name `paths` to push exactly what you name: store paths, `result` links or flake installables, separated by spaces or newlines. Installables are built first, with `--accept-flake-config` and nothing else, so your flake's `nixConfig` and the runner's configuration decide the build. The action adds no substituter and no key to your build.

### `pin`

`pin` is a boolean. Left empty, the step pins what this push landed when `github.ref` is the repository's default branch. An explicit `true` or `false` is obeyed exactly.

The pin's name is `<owner>/<repo>@<ref>/<system>`, such as `juspay/kolu@master/x86_64-linux`. Several repositories share one bucket, and a matrix pushes a Linux and a macOS closure on the same commit. Under one name, the second job would take the first job's pin. Free-text pin names stay for the board and an administrator.

An odu run pins under the same name from `[metadata("odu:pin")]`: see [Keep your default branch's build](/docs/your-repository/#keep-your-default-branchs-build). A repository that moves a workflow onto `odu ci run` keeps re-pointing the same pin.

## How it checks the push

For every path the bucket serves, the step asks `<substituter>/<hash>.narinfo`, the address a Nix client asks. That is the store's public URL, or the bucket's own domain when it has one.

1. It reads the narinfo's `URL:` and `FileSize:`.
2. It requires the NAR to return `200` with a matching `Content-Length`, following a redirect to the store as a client would.
3. A path the cache does not serve turns the step red, and is named.

It uses plain HTTP throughout, so no local narinfo cache answers for the bucket, and an object a proxy truncated is caught. The step summary is a table read from the push's own JSON: pushed, already present, skipped as upstream, and failed.

Each path records the commit that built it, and no run, because a workflow is not an odu run. The commit is `$GITHUB_SHA`, except on a `pull_request` event, where it is the pull request's head commit.

## From `attic push`

Chutney's workflow before: a binary to install, a login that reads a JWT, and a push:

```yaml
      - name: attic login
        run: attic login chutney https://cache.nixos.asia ${{ secrets.ATTIC_LOGIN_TOKEN }}
      - name: om ci
        run: om ci run --systems "${{ matrix.system }}"
      - name: attic push
        run: attic push chutney:oss result
```

After, the first and last steps are replaced by one that carries no credential of its own:

```yaml
      - name: om ci
        run: om ci run --systems "${{ matrix.system }}"
      - uses: juspay/odu/.github/actions/push@<odu-revision>
        with:
          cache: https://cache.kolu.dev/chutney
          token: ${{ secrets.ODU_CACHE_TOKEN }}
          paths: result
```

What changes besides the spelling:

| | `attic push` | the odu action |
| --- | --- | --- |
| Client to install | the `attic` binary | none: the action builds the pusher from its own pin |
| Credential | `attic login`, which writes a token to a profile | an input, from a secret |
| Upstream-signed paths | filtered on the client by config | dropped by the bucket in its `missing` query |
| Did it land? | trust it, or `nix path-info` against the cache | every served path's narinfo is asked over HTTP. A miss is red and named. |
| What you read after a run | attic's log | a table in the step summary, from the push's JSON |

Chutney's attic cache is `chutney:oss`, a cache and a sub-cache. An odu bucket is one cache, so the migration is one bucket named for the project (`chutney`), and its upstream filter does what `oss` did.
