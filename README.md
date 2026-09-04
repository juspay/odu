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

Long terminal checks can opt into bounded fleet sharding without changing the
command:

```just
[metadata("odu:shard=4")]
e2e: install
    CUCUMBER_SHARD="$((ODU_SHARD_INDEX + 1))/$ODU_SHARD_TOTAL" just test-e2e
```

A bare `odu run` opportunistically uses up to four free execution slots, runs
the complete suite with the total it obtained, and posts one aggregate
`e2e@<platform>` GitHub status. Cold slots may bootstrap through Nix normally;
a slot whose connection fails is skipped instead of entering the retry cycle.
The primary lane starts its ordinary CI work while cold burst slots bootstrap;
only the sharded root waits. After provisioning, Odu re-verifies every lease,
fixes the shard total, and appends the root with its immutable index/total to
the already-running primary lane. Dead optional slots simply shrink the total.
In a multi-platform run, each platform starts as soon as its own mandatory
venue is ready; a cold Linux claim does not hold a ready Darwin lane in setup.
Odu continuously verifies that held locks still name this run. Ownership loss
fails closed, including while execution lanes are still starting.
Configure shared host capacity with
`{"host":"ci-1","slots":2}`; legacy host strings remain one slot.
The aggregate duration is the slowest slice's execution time, not staggered
checkout/install/build time. Each burst lane dispatches that private dependency
closure in parallel; the primary reuses prerequisites it ran during capacity
discovery. Both expose nodes such as `e2e[2-of-4]::install` in the UI, logs,
timing sidecar, and run record without creating extra GitHub contexts.

AGPL-3.0-or-later
