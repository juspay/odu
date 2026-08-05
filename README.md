# odu

<img src="./logo.svg" width="112" align="right" alt="odu — a CI runner you attach to" />

**A CI runner you attach to.** odu (Tamil ஓடு — *run*) runs your
[`just`](https://just.systems) recipe DAG across machines, posts GitHub commit
statuses, and holds the run as **live typed state** — for a terminal dashboard
and for coding agents over MCP.

[Website](https://juspay.github.io/odu/) · [Docs](https://juspay.github.io/odu/docs/) · [Announcement](https://kolu.dev/blog/odu/)

```sh
nix run github:juspay/odu -- run --host x86_64-linux=localhost
```

```sh
odu attach          # live matrix + logs from another terminal
odu wait            # fail-fast JSON verdict (or `wait --settle`)
odu rerun unit      # restart a recipe on the still-live run
odu mcp             # same run, agent face (MCP over stdio)
```

Batch CI leaves log files. odu keeps the pipeline alive: attach late and replay
from the top, fail-fast when a node goes red, rerun only that node and its
dependants. Tag one recipe with `[metadata("ci")]` — that dependency closure
*is* the pipeline. Hosts are always explicit (localhost or ssh); nothing is
guessed.

AGPL-3.0-or-later
