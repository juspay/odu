# @odu/ci

**The runs' row.** The board's data, the coordinators, the catalog, the venues,
the forge — and the face that paints them.

Part of the odu repo — `"@odu/ci": "workspace:*"`.

## Two doors

| door | what it is | browser-safe |
| --- | --- | --- |
| `./row` | the plugin the daemon mounts (`ciRow`), and the ports behind it bound to the engine | ❌ |
| `./face` | the run views — board, create form, run detail, the console — and the control primitives the shell shares | ✅ (draws) |

A package of its own for the reason `@odu/cache` is one: **a row owns everything
about itself.** The daemon-side composition that binds `@odu/execution`'s
launcher and retry policy had been sitting inside the CLI face, where only the
import topology kept it out of a public client's closure; the run views had been
in `@odu/web-ui`, where only a test kept the shell honest about not holding a
run's contract. Both are walls now rather than conventions.

## The row offers its own bundle

The runs are the wire's ROOT: their members keep the bare `surface/runs/get`
tags every face was published against, so `implementRootedSurfaces` takes their
surface as a constructor argument and every other row mounts BESIDE it. That is
kolu's construction detail, not Cordis's — `ciRow` is an ordinary
`definePlugin` that builds the runtime in its own `apply`, `offer`s it as
`Bundle`, and closes it in its own finalizer. The cache row is held `PENDING`
until that offer arrives.

The host that mounts it neither constructs a row nor closes one.

## The face is the row's

`board.tsx`, `detail.tsx`, `create.tsx`, `ops.tsx`, `commit.tsx`, `format.ts`,
`ansi.ts`, `types.ts` and `face.css` are this row's views, and they hold the
runs' client and nothing else. `face.css` is what only the runs' screens look
like — the board's seven columns, the node list's Gantt, the lane head, the
console, and the app frame a run turns the page into; the build appends it to
`@odu/face`'s stylesheet, which carries the tokens and the primitives.

What a CONTROL is — a button, a field, a pill, a panel, the
lane strip — is not this row's to decide: those live in `@odu/face/ui`, the
package of no row, so the shell and every face draw the same ones. `commit.tsx`
is what was left of this package's own primitives when they went: the
`<sha7>#<seq>` ref and its `+dirty` marker, which are facts about a RUN.

`@odu/web-ui` is the SHELL: the router, the wire indicator, the tab, and a RAIL
of rows down the left — Runs, Cache, Machines, Tunnel, People. Every face is a
column inside that frame and draws no page frame of its own. **Machines is
reached from the rail**, not from the board's head; `#/machines` is unchanged
and the shell owns the address. Maintenance stays on the board's toolbar,
because it is not a row — it is the runs' own administrative verbs. The shell
opens this face and the others, hands each its own client, and owns the page's
single `Effect.runPromise`.

The board's widest column is the PIPELINE: one lane strip per platform, one
cell per node, drawn from the nodes `streams.checkout` already carries beside
the run its checkout stands for. It is what lets a person answer "how far has
it got and what broke" without opening anything, and it costs no subscription
the board did not already hold.

Two properties the fence checks rather than this file promising:

- every `.tsx` here compiles with the app's pinned Solid presets
  (`src/face/compile.test.ts`);
- no file of this package outside a root of the daemon's walk imports another
  row outside a declared door.

## Docs

- The shell it is drawn in: [`packages/web-ui/README.md`](../web-ui/README.md)
- The vocabulary it shares with the daemon: [`@odu/cordis`](../cordis/src/services.ts)
- The other row: [`packages/cache/README.md`](../cache/README.md)
