# @odu/execution

Everything that **does** a run.

The coordinator that owns one, the lane worker that carries it out, the `just`
DAG it comes from, the venue leases it holds, the shards it fans into, the
verdict gate that decides when a node's result may be published, and the GitHub
statuses it owes. What is *not* here is anybody watching.

Part of the odu repo — `"@odu/execution": "workspace:*"`.

## The wall this package is

```
@odu/cli  ─→  @odu/execution  ─→  @odu/run-history  ─→  @odu/run-client
```

One way, all the way down, and
[`src/closure.test.ts`](src/closure.test.ts) walks the import graph so it stays
that way. The assertion that only this package can make is the one PR 2 is
built on: **the engine never imports a face.**

That is not tidiness. `@odu/cli` declares `@opentui/core` and `@xterm/headless`
— a renderer and a terminal emulator — because it paints a live matrix. An
engine that reached for one would carry both in the closure of everything that
consumes it, and "serve this engine from a web service" would be a refactor
rather than a wiring change. It very nearly was: `src/coordinator/run.ts`
imported `../cli/render` for the words it printed and `../cli/liveView` for the
frame it drew.

## How a run is watched, if anybody is

Through a port, in [`src/common/presentation.ts`](src/common/presentation.ts).
The engine hands over the seam an interactive face needs — the focused node's
log, the rerun verb, what quitting costs — and learns nothing about what the
face does with it.

```ts
const face = (deps.face ?? SILENT_FACE)({ openLog, rerun, onQuit });
```

`RunDeps.face` defaults to **silence**, not to the terminal one. A coordinator
that has to reach for a renderer in order to run is a coordinator no service
can host, and a test that wants an exit code should not have to wire a
renderer to get one. `src/main.ts` is the only place the terminal face is
bound.

The engine still owns the **exit code**. The face prints the verdict;
`exitCode` derives the number from the same state, so no face can make a red
run exit zero by rendering it wrongly.

## What lives here

| directory | what it owns |
| --- | --- |
| `src/coordinator/` | the run: scheduling, the fan-in surface on `.ci/odu.sock`, venue leases and their loss, shards, the log-finalization barrier, the verdict, GitHub posting, the durable-catalog adapter, the retry policy, and how a coordinator is launched so it outlives its launcher |
| `src/runner/` | the lane agent — `odu-runner --stdio`, the process group it reaps, and the lease it holds |
| `src/just/` | the `just` DAG: ingest, selection, the Mermaid graph |
| `src/common/` | the vocabulary both halves share — what a run's state MEANS (`verdict.ts`), how it is watched (`presentation.ts`), the agent-facing row projection (`agentNodes.ts`), the lane wire (`laneSurface.ts`), the log tail, node-id folds, durations, and odu's single sanctioned `Effect.run*` boundary (`effectEdge.ts`) |

## Two things it deliberately does not own

- **A face.** See above.
- **The durable record.** That is `@odu/run-history` — the per-user catalog,
  the journal, per-attempt evidence, the ownership fence. The coordinator's
  adapter onto it is `src/coordinator/history.ts`, and its whole disposition is
  in that file's header: history is never a gate, except being fenced, which
  is.
