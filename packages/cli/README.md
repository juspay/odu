# @odu/cli

The two ways of **watching** a run, and asking things of one.

The native command line with its live matrix, and the MCP agent surface. Both
are faces; neither is how a run happens. `@odu/execution` is that.

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
| `src/main.ts`'s commands | `status` · `logs` · `attach` · `wait` · `rerun` · `cancel` · `runs` · `history` · `hosts` · `lease` · `release` · `protect` — argument grammar, output, and exits |
| `src/liveView.ts`, `src/display.ts`, `src/render.ts` | the live matrix, the three renderings a run picks between (NDJSON, live, plain), and what a status LOOKS like. What a status MEANS is `@odu/execution`'s `common/verdict.ts` |
| `src/runFace.ts` | this package's implementation of the engine's presentation port, and the one place the three-way choice between them is made |
| `src/history.ts` | the durable faces — `logs --run`, `wait --run`, `rerun --run`, `history …` — over `@odu/run-history` |
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
