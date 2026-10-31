# @odu/auth

**The door.** Who is on a connection: GitHub sign-in, sessions a browser carries,
personal tokens a CLI or an agent carries, and the roles that decide what each
may do. It is a row of the board, like `cache`, and it is the only package that
knows a person from a name.

Part of the odu repo — `"@odu/auth": "workspace:*"`.

## Four doors

| door | what it is | browser-safe |
| --- | --- | --- |
| `./surface` | the CONTRACT: `whoami`, sessions, personal tokens, `grant`, the tagged refusal, the three HTTP paths, and the tags an anonymous connection may still ask | ✅ |
| `./server` | implements it and exports `authRow` — the plugin the daemon mounts, which registers its resolver on the host's broker and closes its own database | ❌ |
| `./cli` | `odu auth …`: `login`, `whoami`, `token create · list · revoke`, `grant`, and the credential file under `~/.config/odu/auth/` | ❌ |
| `./face` | the sign-in page, the signed-in header, the profile | ✅ (draws) |

## The principal is the host's; sign-in is this row's

```text
host   ── PrincipalBroker (always present; no resolver ⇒ local owner)
            ▲ register(resolver) in apply, withdraw in the finalizer
auth   ── resolves a session COOKIE or a personal TOKEN per connection,
            answers `authorize(Bearer)` per HTTP request, and ends leases
```

The host owns the listener, so it owns "who is on it"; this row is what answers.
`@odu/cordis/principal` is the vocabulary both sides read — `Principal`,
`Admission`, `CurrentPrincipal`, `Role` — and every verb of every row reads the
principal through the `Caller`, never from input.

**Names are `row_noun_verb`.** The framework derives an MCP tool name as
`<sibling>_<namespace>_<verb>`, so the row's verbs are `auth_user_whoami`,
`auth_user_grant`, `auth_token_create`, `auth_token_list`, `auth_token_revoke`,
`auth_session_list` and `auth_session_end`. The argv face keeps the short
spelling — `odu auth whoami`, `odu auth grant <login> <role>` — because it is
hand-written grammar rather than a derivation.

## A GitHub App, and the PR 2 shape

Sign-in is a **GitHub App**'s authorisation-code flow. Same endpoints as an OAuth
App; what differs is that the App's permissions are the scope, so the
authorisation URL carries **no `scope` parameter**.

| setting | what odu needs |
| --- | --- |
| `ODU_GITHUB_CLIENT_ID` | the App's Client ID |
| `ODU_GITHUB_CLIENT_SECRET_FILE` | a file holding the App's client secret |
| `ODU_GITHUB_ALLOW` | `org:<name>`, `team:<org>/<slug>`, or a comma list of logins |
| `ODU_GITHUB_ORIGIN` | default `https://github.com`; an enterprise host otherwise |
| `ODU_GITHUB_API` | default `https://api.github.com` |

Unset means the row is NOT mounted and every caller is the local owner — loopback
mode. Half set is a refusal at boot naming the missing variables.

**Membership, in this PR, is read with the PERSON's token**:
`/user/memberships/orgs/<org>` for `org:` and
`/orgs/<org>/teams/<slug>/memberships/<login>` for `team:`. That works because
the App is installed on the organisation and holds Organization → Members:
read. PR 4 moves it server-side off the installation token, so a removal in
GitHub is a removal in odu without waiting for a sign-in, and turns user-token
expiry on with refresh tokens stored. Until then an EXPIRING user token is
refused at the callback with a sentence naming the App's "Expire user
authorization tokens" switch — this release has nowhere to keep a refresh token,
and a session that dies in eight hours is worse than a clear refusal.

## Sessions are leases

The host acquires a lease at the websocket upgrade and arranges its release in
the same step; this row ends leases. Logging out, revoking a token, an expiry
sweep and a role change all end them, and an ended lease stops that connection
receiving anything — every later call is refused and every open subscription is
interrupted. No revocation list is polled.

The lease's release also calls the host's `ConnectionCloser`, which is **TODO
seam**: kolu's `serveSurfaceApp` hands an app no handle that closes a live
connection (the `SurfaceSocketServing` it holds is listener-local), so the host
passes a no-op today and the socket is cut as soon as the seam exists. See the
module header of `packages/host/src/principal.ts` for the three shapes that
would be enough.

What the row stores is **not** a set of credentials: a session is keyed by the
SHA-256 of its cookie value and a token by the SHA-256 of its secret, in
`auth.sqlite` under the state directory. The cookie's value exists only in the
browser; a token's plaintext exists only in the answer that minted it.

## The root token, and nothing else

`$ODU_ROOT_TOKEN` is the operator's bootstrap, and it does exactly one thing:
`odu auth grant <login> owner` on a daemon that has **no owner yet**, and only
for `owner`. Once the first owner exists it is refused, an owner's session
grants everything after that, and it is never a principal — it cannot start a
run or read a bucket.

## Docs

- The door from the operator's side: [`website/src/content/docs.md`](../../website/src/content/docs.md) ("Server mode")
- The vocabulary it shares: [`@odu/cordis`](../cordis/src/principal.ts)
- The other rows: [`packages/cache/README.md`](../cache/README.md), [`packages/ci/README.md`](../ci/README.md)
