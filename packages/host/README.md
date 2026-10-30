# @odu/host

**The daemon.** One listener, one singleton gate, one process that serves every
row's surface and binds their ports to the engine. Where a row is a capability
that could be served by anything, this is the thing that serves it.

Part of the odu repo — `"@odu/host": "workspace:*"`.

## The arrow

```text
src/main.ts  ─┐
              ├─→  @odu/host  ─→  ci     (@odu/service · @odu/service-client ·
packages/      │                          @odu/execution · @odu/run-history ·
web-ui/        │                          @odu/run-client)
              │        └──────→  cache  (@odu/cache)
              └─→  the rows' FACES
```

Host is **not a row**: it names the rows and is never named by one.
`src/closure.test.ts` states that half — importing `@odu/cli` or `@odu/web-ui`
from here is a failure, because a daemon that carried a renderer, an argv
projection or a page's routing would ship a face to every browser tab's server.
The other half is the arrow itself: a row's manifest names rows, and this
package is not among them, so the dependency cannot come back.

## What the host owns

| | |
| --- | --- |
| `src/web.ts` | **the tenure.** `odu web` in the foreground, `odu web --background`, and the quiet `web-daemon` the second one spawns. It claims the gate BEFORE anything is bound, asserts the package is complete before it serves, and owns the teardown — every row's resources released in reverse order, so a daemon restart cannot leave a database handle or a timer behind |
| `src/serving.ts` | **the listener's parts, assembled.** kolu's `serveSurfaceApp` options — the live generation, the built bundle, the `/mcp` routes, the Origin allowlist — as one object built from named parts, so adding a route or a middleware is adding a part rather than editing the gate-claim ordering that must not move |
| `src/mcpRoute.ts` | the `/mcp` door: a conformant Streamable HTTP endpoint whose adapter is **in-process** with the surface it serves, gated on the same Origin decision as the websocket upgrade plus the JSON content type an HTTP method needs |
| `src/webPorts.ts` | **the composition.** The service's ports bound to their implementations: launch, retry, cancel, the checkout probe, the pipeline reader, the venues, the forge — and, since PR 1.5, no cache: that row publishes itself. The ONE file that may name the engine's launcher and retry policy, because a second one would be a second scheduler |
| `src/pipelinePort.ts`, `src/venuePort.ts`, `src/protectPort.ts` | the adapters behind those three ports, each next door to what it binds because each moves when a different piece of the engine does |
| `src/venueInventory.ts`, `src/leaseVenues.ts` | the inventory `odu hosts` reads and the hold/release `odu lease` and `odu release` ask for — engine-side now, because the callers are clients of this daemon and the machines are its to reach |
| `src/webLauncher.ts` | **how a client converges on the singleton**, and how a person replaces one. Adopt a live holder, spawn a daemon and verify it answers, or refuse — three outcomes, one of which must never be "quietly do the work locally" |
| `src/webDaemonLaunch.ts` | the launch *facts*: where the home is, which application this is, whether the package is complete at all, the environment a daemon runs with, and how to start one that outlives its caller |

## What it never does

- **No run logic.** The host starts, retries and cancels runs *through ports*;
  what a retry MEANS is `@odu/execution`'s, and a second opinion here would be a
  second scheduler. The one place the engine's launcher is named is
  `webPorts.ts`, and the closure test holds it to one place.
- **No cache logic.** The cache is a row: its protocol routes, its surface, its
  own administration. The host mounts them and knows nothing about narinfos.
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

- The contract it serves: [`packages/service-client/README.md`](../service-client/README.md)
- The authority behind it: [`packages/service/README.md`](../service/README.md)
- The browser on top of it: [`packages/web-ui/README.md`](../web-ui/README.md)
