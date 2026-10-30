# @odu/host

**The daemon.** One listener, one Cordis host, one process that serves every
row's surface — and the one file that names which rows there are.

Part of the odu repo — `"@odu/host": "workspace:*"`.

## The arrow

```text
src/main.ts         CLI  ─┐
packages/host/     daemon ─┼──▶  ci     @odu/ci (the row: row.ts · face/) and the
packages/web-ui/   board ──┘            engine it binds — service, execution,
                                        run-history, run-client, launch, cli
                                └──▶  cache  @odu/cache
```

**Host names every row and belongs to none.** Its roster is `src/web.ts`, which
is a ROOT file, and the fence treats "a consumer that mounts rows from a root
file alone" as a state rather than a defect. What that buys is the reason a row
may not import this package: a face that reached the host to bootstrap would
carry every row's server to reach the code that starts one. The vocabulary the
two sides SHARE — the service tags, the row record, the composed-wire helpers —
lives in `@odu/cordis`, which belongs to neither.

## What the host owns

| | |
| --- | --- |
| `src/web.ts` | **the tenure, and the roster.** `odu web` in the foreground, `odu web --background`, and the quiet `web-daemon` the second one spawns. It claims the gate BEFORE anything is bound, provides the facts every row needs, builds the runs' root bundle, mounts the sibling rows, and serves the one flat group. Teardown is Cordis's: the listener first, then every row in reverse |
| `src/serving.ts` | **the listener's parts, assembled.** kolu's `serveSurfaceApp` options — the live generation, the built bundle, the `/mcp` routes, the Origin allowlist — as one object built from named parts, so adding a route or a middleware is adding a part rather than editing the gate-claim ordering that must not move |
| `src/mcpRoute.ts` | the `/mcp` door: a conformant Streamable HTTP endpoint over the COMPOSED bundle — the runs as the unprefixed core, every sibling under its key — whose adapter is in-process with the surface it serves, gated on the same Origin decision as the websocket upgrade plus the JSON content type an HTTP method needs |

That is the whole package. Everything else that used to live here was a row's
volatility rather than the tenure's:

| moved | to | why |
| --- | --- | --- |
| `webPorts.ts`, `protect*`, `pipelinePort`, `venue*`, `leaseVenues` | `@odu/ci` | the port bindings change when the ENGINE changes, not when the tenure does |
| the runs' row (`ciRow`) | `@odu/ci` | a row's wiring belongs to its row |
| the run views (board, create, detail, dom, format, ansi, types) | `@odu/ci/face` | a view that renders a row's contract lives in that row's package |
| the cache's row | `@odu/cache/server` (`cacheRow`) | likewise — and it mounts itself |
| `webLauncher.ts`, `webDaemonLaunch.ts`, `processIdentity.ts` | `@odu/launch` | how a CLIENT converges on the singleton, which a row needs and the registry cannot supply |
| the service tags, the row record, `composedWire` | `@odu/cordis` | the vocabulary both sides speak |

## How a row joins

The runs are the wire's ROOT: their tags are the bare `surface/runs/get` every
face was published against, and a root is a constructor argument rather than a
sibling. The host builds it (`createCiBundle`) and provides it as `Bundle`.

Every other row is a `definePlugin` mounted by the host, and it declares what it
needs: the facts above, `Bundle` to mount itself on, `Routes` for its own HTTP
layer. It mounts in its own `apply` and drops the mount in its finalizer — no
table, no callback after the plugins settle, no live state across a package
boundary outside a declared service.

## What it never does

- **No run logic.** The host composes ports; what a run MEANS is
  `@odu/execution`'s.
- **No cache logic.** The cache is a row: its surface, its protocol routes, its
  database. The host mounts them and knows nothing about narinfos.
- **No rendering.** The board is `@odu/web-ui`, the terminal and argv faces are
  `@odu/cli`, and both are clients of this process.
- **No environment of its own beyond the boot.** `ODU_WEB_ORIGIN`,
  `ODU_ROOT_TOKEN`, `ODU_PUBLIC_ORIGIN`, `ODU_CACHE_STORE` and the build
  locators are read here because this is the one place that reads an
  environment; every row is handed its facts as services.

## The singleton, exactly

One per-user home (`~/.local/state/odu-web/`, or `$ODU_STATE_DIR` — the home is
derived FROM the origin, so moving the service moves its gate too), one gate
file in it, one fixed origin, and one claim per boot. Concurrent launchers
converge through kolu's pid gate: every one writes a per-pid temp file and races
a single atomic `link(2)`, exactly one wins, and every loser reads the gate,
proves the holder is alive, and yields. Not a lock — a claim a dead holder
cannot keep.

**A fixed port occupied by something else is a REFUSAL, never a fallback.** A
service that relocated on `EADDRINUSE` would answer the concurrency question by
making itself unfindable: the tab, the CLI and the MCP host all derive one
address.

## Docs

- The vocabulary it shares with the rows: `@odu/cordis` (`src/services.ts`)
- The contract it serves: [`packages/service-client/README.md`](../service-client/README.md)
- The browser on top of it: [`packages/web-ui/README.md`](../web-ui/README.md)
