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

`board.tsx`, `detail.tsx`, `create.tsx`, `dom.tsx`, `format.ts`, `ansi.ts` and
`types.ts` are this row's views, and they hold the runs' client and nothing
else. `@odu/web-ui` is the SHELL: the router, the wire indicator, the Runs /
Cache switch and the tab. It opens this face and the cache's, hands each its own
client, and owns the page's single `Effect.runPromise`.

Two properties the fence checks rather than this file promising:

- every `.tsx` here compiles with the app's pinned Solid presets
  (`src/face/compile.test.ts`);
- no file of this package outside a root of the daemon's walk imports another
  row outside a declared door.

## Docs

- The shell it is drawn in: [`packages/web-ui/README.md`](../web-ui/README.md)
- The vocabulary it shares with the daemon: [`@odu/cordis`](../cordis/src/services.ts)
- The other row: [`packages/cache/README.md`](../cache/README.md)
