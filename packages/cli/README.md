# @odu/cli

The two ways of **watching** a run, and asking things of one.

The native command line and the MCP agent surface. Both are faces; neither is
how a run happens. `@odu/execution` is that — and since the consolidation, so
is `@odu/service`: every command here is a CLIENT of the shared daemon, and the
one thing this package may still add is argument grammar, rendering and exits.

Part of the odu repo — `"@odu/cli": "workspace:*"`.

## Why it is a wall and not a folder

This manifest declares `@opentui/core` and `@xterm/headless` — a renderer and a
terminal emulator — because the live view is a real terminal: a node that
redraws with carriage returns shows one progress line rather than hundreds, and
a failing test stays red. That is exactly the dependency an engine must not
carry, and the reason the two are separate packages rather than two directories
that happen to import politely.

```
@odu/cli  ─→  @odu/execution  ─→  @odu/run-history  ─→  @odu/run-client
```

[`src/closure.test.ts`](src/closure.test.ts) asserts this side of the arrow;
the engine's own closure test refuses the other. A cycle introduced from either
direction lands on one of them.

## What lives here

| | |
| --- | --- |
| `src/main.ts`'s commands | `run` · `wait` · `rerun` · `cancel` · `logs` · `status` · `attach` · `hosts` · `lease` · `release` · `dump` · `graph` · `protect` · `history` — argument grammar, output, and exits. Every one is a CLIENT; `./authority.test.ts` derives that set from this file's own imports and proves none of them can reach the engine |
| `src/liveView.ts`, `src/display.ts`, `src/render.ts` | the live matrix, the three renderings a run picks between (NDJSON, live, plain), and what a status LOOKS like. What a status MEANS is `@odu/execution`'s `common/verdict.ts`. Reached only from `run-coordinator` now: the matrix was driven by a direct dial into the coordinator, which no public command may hold, so `odu attach` prints a transition stream instead |
| `src/runFace.ts` | this package's implementation of the engine's presentation port, and the one place the three-way choice between them is made |
| `src/serviceFace.ts` | the plumbing every public command shares: the connection, the three-way outcome (answer / refusal / dead link), and the one exit table. Four command modules import it — `serviceCommands`, `serviceStatus`, `serviceVenue`, `servicePipeline` — which are four SUBJECTS, not four authorities |
| `src/internalCli.ts` | `run-coordinator` and `lease-hold`: the argv workers a launcher types and a person never does. Out of `main.ts` so the wall's derivation starts at a root that is itself clean |
| `src/serviceCli.ts`, `src/serviceMcp.ts` | the two non-browser faces of the shared service: the same contract projected as argv and as MCP, neither holding a verb of its own |
| `src/web.ts`, `src/webLauncher.ts`, `src/webPorts.ts` | the daemon that serves that contract, how a client converges on the singleton, and the one place the engine is bound to it |

## The line between the faces

There isn't one, and that is deliberate: `odu surface` and `odu mcp` are two
projections of ONE contract (`@odu/service-client`'s `oduServiceSurface`), and
both are derived from the same `expose` map rather than hand-written per face.
That is what makes "a verb means the same thing to an agent and to a person" a
property of the code instead of a claim about it. What they add is argument
grammar and rendering, which is all either of them adds.

Neither holds run authority. Every mutation crosses the wire to the singleton
daemon, so two agents driving two bridges are two clients of one truth rather
than two opinions about it — and the public CLI cannot spawn a coordinator,
dial a checkout's socket, or write the catalog. The one legitimate binding of
the engine is `src/webPorts.ts`, on the daemon's side of that wall.
