---
title: Server mode
description: Put GitHub sign-in in front of odu's board and API, give people roles, and hand personal tokens to machines and agents.
section: Run the service
order: 3
---

Give odu a GitHub App's credentials and it runs in server mode. A browser that is not signed in meets a sign-in page, `/mcp` returns `401` without a personal token, and every API verb runs as a signed-in person with a role.

Without the credentials, none of this applies, and a loopback `odu web` lets every caller do everything.

Commands are written with the [`odu` shorthand](/docs/#quick-start).

## The settings

| Variable | What it sets |
| --- | --- |
| `ODU_GITHUB_CLIENT_ID` | the App's Client ID |
| `ODU_GITHUB_CLIENT_SECRET_FILE` | a file holding the App's client secret |
| `ODU_GITHUB_ALLOW` | who may sign in: `org:<name>`, `team:<org>/<slug>`, or a comma-separated list of GitHub logins |
| `ODU_GITHUB_ORIGIN`, `ODU_GITHUB_API` | `https://github.com` and `https://api.github.com` by default, or a GitHub Enterprise host |

Set the first three together. The service refuses to start with only some of them, so it never runs without sign-in when you meant it to have it.

## Create the GitHub App

Create a GitHub App, not an OAuth App: the App's permissions are the scope. Create one per odu server: see [Two servers](#two-servers).

On GitHub's **New GitHub App** form, set:

| Field | Value |
| --- | --- |
| **GitHub App name** | anything unique on GitHub, such as `odu-yourorg` |
| **Homepage URL** | `https://<host>/`, or your repository's URL |
| **Identifying and authorizing users → Callback URL** | `https://<host>/auth/github/callback`, exactly, with no trailing slash |
| **Identifying and authorizing users → Expire user authorization tokens** | **OFF**. odu does not store refresh tokens. If this is on, sign-in is refused with a page naming this setting. |
| **Identifying and authorizing users → Request user authorization (OAuth) during installation** | **ON** |
| **Webhook → Active** | **OFF** |
| **Permissions → Organization → Members** | **Read-only**. odu reads membership for `org:` and `team:` rules with the person's own token, which needs this. |
| **Permissions → Account → Email addresses** | **Read-only** |
| **Where can this GitHub App be installed?** | **Any account** |

Then, under the App's **Credentials** tab, section **Client secrets**, click **Generate a new client secret**. Copy the **Client ID** from the top of the page, and the secret, which is shown once.

GitHub's banner also asks for a private key before the App can be installed. odu does not read it, so generate it only when your allow-list has an `org:` or `team:` rule, which needs the App installed.

## Install the App

An App is owned by one account and installed on organizations or accounts, separately. Your personal account may own it.

- For an `org:<name>` or `team:<org>/<slug>` rule, an owner of that organization installs the App on it. Selected repositories are enough, because odu reads membership, not code.
- For a list of logins, such as `ODU_GITHUB_ALLOW=srid,octocat`, no installation is needed.

## Configure odu

On NixOS, the module serves the board and the cache on one hostname:

```nix
services.odu = {
  enable = true;
  cache.domain = "odu.example.com";
  rootTokenFile = config.age.secrets.odu-root-token.path;
  openFirewall = true;
  github = {
    clientId = "Iv1.0123456789abcdef";
    clientSecretFile = config.age.secrets.odu-github-client-secret.path;
    allow = [ "org:example" ];
  };
};
```

With `github` set, the module's nginx serves everything the service serves: the board, `/rpc/ws` with the websocket upgrade, `/mcp`, and the cache's paths. `publicOrigin` follows `cache.domain` (`https://odu.example.com`), so the App's callback is the one above.

In a container, set the same settings in the environment, with the client secret in a file like the root token:

```sh
ODU_PUBLIC_ORIGIN=https://odu.example.com
ODU_GITHUB_CLIENT_ID=...            # from the Secret
ODU_GITHUB_CLIENT_SECRET_FILE=/path/to/client-secret
ODU_GITHUB_ALLOW=org:example
```

For a bare `odu web`, name an address it is reachable at, and open it in a browser:

```sh
ODU_PUBLIC_ORIGIN=http://localhost:18440 \
ODU_GITHUB_CLIENT_ID=... \
ODU_GITHUB_CLIENT_SECRET_FILE=./client-secret \
ODU_GITHUB_ALLOW=org:example \
  nix run github:juspay/odu -- web
```

Its callback is `http://localhost:18440/auth/github/callback`. GitHub allows a `localhost` callback, and the session cookie is not `Secure` there.

`ODU_GITHUB_ALLOW` takes a comma-separated list. One example of each form:

```sh
ODU_GITHUB_ALLOW='org:juspay'                  # anyone in the organisation
ODU_GITHUB_ALLOW='team:juspay/platform'        # anyone on that team
ODU_GITHUB_ALLOW='srid,octocat'                # these logins, by name
ODU_GITHUB_ALLOW='org:juspay,srid'             # any rule may let you in
```

## Sign in and make the first owner

Open the board: it is the sign-in page. **Sign in with GitHub** authorizes the App and opens the runs. A person the allow-list refuses sees a page saying so, which quotes the list.

Roles are odu's, not GitHub's. Everyone starts as a member.

| Role | May |
| --- | --- |
| member | see every run and every bucket, start, retry and cancel runs, read the cache |
| admin | also create buckets, mint and revoke cache tokens, pin and collect, and write branch protection |
| owner | also grant roles |

The root token creates the first owner, and only that. On a new server, once:

```sh
# On the server, with $ODU_ROOT_TOKEN set in its environment.
odu surface auth user_grant --origin https://odu.example.com \
  --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","login":"srid","role":"owner"}' --json
```

After that, a grant made with the root token is refused, whatever the role. Every further grant is an owner's, made with that owner's personal token:

```sh
odu auth login https://odu.example.com        # paste the owner's personal token
odu surface auth user_grant --origin https://odu.example.com \
  --input '{"login":"alice","role":"admin","rootToken":""}' --json   # or People on the board
```

On the board, an owner has **People**. It lists every grant and every login that has signed in, with its role, and grants or changes a role. Signing out does not remove you. `odu surface auth grant_list` prints the same list.

- A grant that would leave the server with no owner is refused. Grant a second owner before you step down.
- In server mode the root token grants the first owner and nothing else. It is not a person, and cannot start a run or read a bucket.

## A token for a machine or an agent

Click your login in the rail to open your profile page: your sessions and your personal tokens. Click **Create token**, copy it (it is shown once), then store it on a machine or hand it to an agent:

```sh
odu auth login https://odu.example.com      # paste the token; it is kept at ~/.config/odu/auth/credentials, mode 0600
odu surface auth user_whoami --origin https://odu.example.com --json
odu surface cache bucket_list --origin https://odu.example.com --json

# or, for an agent or CI, no login step:
ODU_TOKEN=odu_... odu mcp --origin https://odu.example.com
```

- Every `odu` command, and the MCP server, sends the personal token as `Authorization: Bearer`.
- `ODU_TOKEN` wins over a stored credential, so one shell can act as somebody else.
- To start a run of the server's checkout with it, see [Run the server's CI from your shell](/docs/remote-runs/).

## Sessions and revoking

- A session lasts 30 days from sign-in. Using it does not extend it.
- Revoking a personal token on the profile page, signing out, or a session expiring closes every connection that credential opened. An open board tab meets the sign-in page.
- The cache protocol does not change. A public bucket is read without an account, and `odu cache use` reads a public bucket from `GET /cache/<bucket>`, so it works before anybody signs in. A push carries a cache token.

## Two servers

Create one App per odu server: the callback URL is one address, and the client secret is the App's. One personal account may own both Apps. Transferring an App to an organization later keeps its Client ID, so the secret and `ODU_GITHUB_CLIENT_ID` keep working.
