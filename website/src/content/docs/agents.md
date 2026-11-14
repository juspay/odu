---
title: Coding agents
description: Let a coding agent start, watch and retry odu runs through the CLI or MCP, with the same API verbs the board uses.
section: Use odu
order: 5
---

A coding agent drives odu with the same API verbs the board and the CLI use, either through `odu surface` in a shell or over MCP. Both start the local service if it is not running and act on the runs you see at **http://127.0.0.1:18440**.

Disconnecting an agent stops it watching, not CI. The [odu skill](https://github.com/juspay/odu/tree/master/skills/odu) teaches an agent the loop below, for either interface.

## The loop

| Step | API verb | Keep or check |
| --- | --- | --- |
| Start | `run_start` | An absolute checkout, the expected commit, a unique request ID. Keep the run ID and cursor. |
| Observe | `run_wait` | Send `after` from the previous cursor, with a bounded deadline. |
| Diagnose | `log_read` | Echo the failure's log key and page with `nextOffset`. `stream: "push"` reads a push that failed. |
| Retry unchanged inputs | `run_retry` | Track the effective run and cursor it returns. |
| Test a source fix | `run_start` | A new commit and a new request ID. |
| Finish | `run_read` or `run_wait` | The commit, the scope, the verdict, and any statuses odu still owes GitHub. |

After a lost reply, send the same request again with the same request ID and input. A conflict means the input changed. A request still unresolved needs a look before any new change.

## Use the CLI

An agent with a shell can call `odu surface` directly, with no MCP configuration. Run it through Nix:

```sh
nix run --accept-flake-config github:juspay/odu -- surface --help
nix run --accept-flake-config github:juspay/odu -- surface run_start --input '{"checkout":"/absolute/repo","expectedSha":"COMMIT_SHA","requestId":"ci-1"}' --json
```

Substitute the checkout and commit, and keep the run ID and cursor it returns. Then, with the [`odu` shorthand](/docs/#quick-start):

```sh
odu surface run_wait --input '{"runId":"RUN_ID","after":"CURSOR","deadlineMs":30000}' --json
odu surface log_read --input '{"key":"LOG_KEY","offset":0}' --json
odu surface run_retry --input '{"runId":"RUN_ID","selector":"test","requestId":"retry-1"}' --json
```

Replace each placeholder with a value from the previous reply.

- `odu ci run`, `ci wait`, `ci logs` and `ci rerun` are shortcuts over the same service. `odu surface` is the structured interface.
- The cache's, sign-in's and the tunnel's verbs are typed after their part's name: `odu surface cache …`, `odu surface auth …`, `odu surface cloudflare …`.
- Every verb is listed in the [CLI reference](/docs/cli/), and `odu surface --help` prints their input schemas.

## Use MCP

odu ships its skill and its MCP server together as an [Agent Plugin](https://agent-plugins.org/) at the [repository root](https://github.com/juspay/odu). Add it in one of three ways:

- In a repository, list it in `plugin.json`, as [Use odu from your repository](/docs/your-repository/#6-agents) shows.
- With [agent-distro](https://agent-distro.nixos.asia/#profiles), add `"github:juspay/odu"` to your profile's `plugins`.
- Configure the stdio server yourself:

```json
{
  "mcpServers": {
    "odu": {
      "command": "nix",
      "args": ["run", "--accept-flake-config", "github:juspay/odu", "--", "mcp"]
    }
  }
}
```

The stdio server starts the service if needed and offers the same verbs as MCP tools (`run_start`, `run_wait`, `log_read` and the rest). An HTTP MCP client can connect to **http://127.0.0.1:18440/mcp** once the service is running, but an HTTP connection cannot start it.

On a service with [sign-in](/docs/server-mode/), give the agent a personal token: see [A token for a machine or an agent](/docs/server-mode/#a-token-for-a-machine-or-an-agent).
