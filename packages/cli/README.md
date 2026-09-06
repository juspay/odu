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
| `src/mcp/` | the agent surface: the projection of the live run, and the bespoke tools (`run`, `wait_for_settle`, `node_rerun`, `cancel`, `runs`, `lease`) |

## The line between the two faces

There isn't one, and that is deliberate: they are in the same package because
they are the same kind of thing. `odu wait` and the MCP `wait_for_settle` share
the settle core; `odu rerun` and `node_rerun` share the retry policy; `odu
lease` and the `lease` tool share the holder. What they do not share is
argument grammar and rendering, which is all either of them adds.

Both take their answers from the engine. Neither reaches into it — the
policies they call (`retryRun`, `waitForSettle`, `runCommand`) are the engine's
exports, and the exit codes they return are derived from the engine's own
classification rather than re-decided here.
