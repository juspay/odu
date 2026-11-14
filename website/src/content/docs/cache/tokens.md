---
title: Tokens
description: Mint, list and revoke a bucket's cache tokens, and who may administer a bucket with and without server mode.
section: Binary cache
order: 3
---

A cache token lets a pusher write to a bucket, or a reader read a private one. A bucket's administrator mints them on the board or with an API verb. This page also says who may administer a bucket.

Commands are written with the [`odu` shorthand](/docs/#quick-start).

## Mint a cache token

```sh
odu surface cache token_mint --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"main","scope":"write"}' --json
odu surface cache token_mint --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"main","bucketGlob":"team-*","scope":"write"}' --json
```

On the board, a bucket's **Tokens** panel mints one with **Mint token**, with write or read scope. The cache token is shown once. odu keeps only its hash.

| A cache token carries | What it is |
| --- | --- |
| a bucket glob | the buckets it works on, such as `main` or `team-*` |
| a scope | `read`, `write` or `admin` |
| an expiry | 90 days by default on the board, where "never" is a choice. With `token_mint`, `expiresDays` sets it, and absent means never, the shape a CI secret wants. |
| a last use | when it was last presented |

A refusal for an expired cache token names the date it expired.

## List and revoke

```sh
odu surface cache token_list --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"main"}' --json
odu surface cache token_revoke --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","id":"<id>"}' --json
```

The board's **Tokens** panel lists them, and **revoke** ends one without touching the rest.

## Who may administer a bucket

Creating buckets, minting and revoking cache tokens, pinning and collecting is done on the board or with these API verbs, never with a CLI command.

Without server mode, administration needs the root token. The service reads it from `$ODU_ROOT_TOKEN`, and each API verb takes it as a field of its input:

```sh
export ODU_ROOT_TOKEN=...
odu surface cache bucket_create --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","name":"main","public":true,"retentionDays":30}' --json
```

The board's **Cache** view asks for the root token once per visit, keeps it in the page and never stores it.

In [server mode](/docs/server-mode/), your role decides. The root token only grants the first owner, and administration needs an admin or an owner, through your personal token:

```sh
odu surface auth user_whoami --json   # who this machine's token belongs to, and its role
odu surface cache bucket_create --input '{"rootToken":"","name":"main","public":true,"retentionDays":30}' --json   # as an admin, through the token odu auth login stored
```

A member sees every bucket, and may read a bucket's URL, key and paths. `bucket_create`, `token_mint` and `gc_run` are refused for a member with `not_permitted`, and the board shows a member none of those controls.

Pushing is the same in both: a pusher carries a write cache token from `token_mint`, whoever minted it.
