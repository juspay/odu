# @odu/web-ui

**The browser.** Everything a person sees, and nothing a person could not.

This package holds views over `@odu/service-client`'s surface and no domain
logic at all — no second retry rule, no second idea of what "red" means, no
execution path of its own. A control here is one procedure call on the same wire
the CLI and the MCP face use, which is what makes the acceptance gate's *same
addressed state through every face* a property rather than a promise.

`src/closure.test.ts` enforces it: importing `@odu/service`, `@odu/execution` or
`@odu/run-history` is a test failure, not a review comment.

## Solid JSX, compiled by Solid's own compiler

The views are conventional Solid JSX — `<Show>`, `<For>`, `<Index>`, components
with typed props. They used to be Solid's hyperscript (`solid-js/h`), and the
argument for that was a build argument: JSX needs a compiler, which needs a
bundler plugin, which needs dependencies, in a tree whose whole build was
`Bun.build` over raw TypeScript. That is a real cost and it was the wrong trade.
A UI is read far more often than it is built.

**Solid's JSX is not React's, and the difference is the whole build.**
`babel-preset-solid` compiles each element to a cloned `<template>` plus one
effect per *dynamic* binding: a component function runs once, and only the
bindings that read a changed signal re-run. Bun's own built-in JSX transform
would consume the same files happily and emit `jsx(Component, props)` calls
instead — a React-shaped render where whole components re-run and every
`createSignal` inside them is re-created. It typechecks, it bundles, it
screenshots correctly, and it loses the caret in a field, the focus ring on a
button, and the scroll position of a log pane somebody was reading. So the
compiler is pinned exactly (root manifest), wired in `scripts/build-web-ui.ts`,
built into the Nix derivation, and *asserted* by `src/compile.test.ts` — which
compiles every view in this package and checks what came out.

The one rule the compiler cannot keep for you:

> **Never destructure props.** `props` is an object of getters, so
> `function Row({ run })` reads every one of them once and freezes the row.
> Write `props.run`.

## Built by one call

```sh
bun scripts/build-web-ui.ts [<distDir>]
```

`buildSurfaceClient` (`@kolu/surface-app/bun`) owns the whole freshness contract
the server half is built to serve: content-hashed assets under `/assets/`
pinned `immutable` for a year, the build commit published on the `no-store`
shell (never defined into a hashed file — a stamp-only rebuild would change an
immutable file's bytes without changing its URL and strand every returning
browser), `modulepreload` links for the entry's static chunks, and precompressed
`br`/`zstd`/`gzip` siblings.

Nix builds it as `.#web-ui` and bakes the path onto the `odu` wrapper as
`ODU_WEB_DIST` — with `--set`, unconditionally, so the page a daemon serves is
always the page its `ODU_BUILD_ID` names. There is no ambient override and no
dev-server: iterating on the browser is `just run -- web`, which rebuilds. A
bundle that could be swapped under a fixed build id would make that id true of
two different applications, and it is the id `ensureService` compares before
adopting a daemon somebody else started.

## Two properties that are acceptance gates, not polish

**Keyboard access is not a mode.** Every control is a real `<button>` (see
`./src/dom.tsx`, where that decision is made once): reachable by Tab, firing on
Enter and Space, announced as a control, with a disabled state the browser
enforces. The focus ring is styled up, never off. A filter's *pressed* state
rides `aria-pressed` rather than only a colour.

**Narrow viewports work.** The board row is a grid that collapses to two lines
on a phone rather than a table that scrolls sideways. The one place sideways
scrolling is right is inside a log box — a log line is a log line, and wrapping
one changes what it says — so it is scoped there and the page itself never
scrolls sideways.

## How the two pages use a screen

**The board is TWO ROWS, and this package is the SHELL.** The header offers
*Runs* and *Cache*, two STATES of one page rather than a menu — `aria-pressed`
says which. The views themselves are not written here: the runs are
`@odu/ci/face` and the buckets are `@odu/cache/face`, each in the package that
owns the row it draws. The shell owns the hash router, the wire indicator, the
switch, the tab, the clock, and the page's single `Effect.runPromise` — handed
to both faces as `call`. `src/closure.test.ts` holds the split: only `app.tsx`
opens either face, and `main.tsx` is the only file that names a row's SURFACE,
because the root dials both through `connectSurfaces`.

**The board is scanned.** One row per checkout by default — the latest run of
each, with `N earlier` under the age and a *History* toggle for the rest —
because "what is my CI doing" is a question about checkouts, and a superseded
run's red is history. One status cell per row: the outcome once there is one,
the board state until then. Two clocks beside it, because they answer different
questions: *Took* is the run's own duration, which stops at its verdict, and
*Age* is how long ago it started, which never stops. Three coarse filters plus a
text search over
project, branch and path. The tab title and favicon count the same rows the
board shows by default — how many are failing, how many are still moving — so a
tab in the background is still a monitor.

**A run is read.** On a wide screen the run view is a viewport-height frame
whose log pane scrolls inside itself; on a phone it is an ordinary page. Nodes
are grouped into lanes by platform, each headed by its host, its counts and its
own cancel; a node offers *Retry* only once it has stopped and *Cancel node*
only while it runs. *Cancel run* asks first — it is the one control that throws
away every lane at once. The console renders a recipe's own SGR colours through
`./src/ansi.ts` (the CLI's palette, so a red in the terminal is the same red
here) and says whether it is still following the tail.

**Each node carries a timeline bar** on a line of its own: a Gantt across the
run, so a bar's POSITION says where its latest attempt ran — a row carries only
the newest — and the picture says what overlapped what. The scale is the run's
own elapsed, so the track is always exactly full and grows while the run is
live. A node still running is hatched END TO END, because every millisecond of
that bar is provisional; a node that has not started, or one that stopped
without ever running (`skipped`), draws no bar at all, which is how a lane
waiting on a machine looks. The geometry is `laneSpan` in
[`@odu/service-client/board`](../service-client/README.md), and the TRACK is
one box — the row's, which does not vary — measured against the axis by
`packages/web-acceptance`'s own geometry step rather than asserted here.

**Raw CSS, on purpose.** One stylesheet, in four cascade layers, with a single
`light-dark()` palette lifted from the website. There is no utility framework
and no component library: the page has a few dozen class names — every rule
carries the reason it exists beside it, and the two that declare no rule
(`.board`, `.create`) are structural anchors the markup hangs on rather than
dead paint.

## The connection is drawn, not hidden

`readout()` is the framework's own five-state fact — `connecting`, `live`,
`degraded`, `reconnecting`, `retired` — and each is a state a person can be in
and needs to know about. `reconnecting` is the honest one: the page keeps
showing the last thing the service said, and says so, rather than letting stale
rows look live. `degraded` names the subscriptions that stopped.

## A run, and a failure, are linkable

Routing lives in the URL hash: `#/run/<id>` and
`#/run/<id>/<encoded node>/<attempt>` — where those last three segments are
*exactly* a log key, the same string an agent echoes into `log_read`. So the
address in the URL bar and the address in a tool call are one address, and
pasting one into a message puts the other person on the same failure.

## Docs

- The contract it renders: [`packages/service-client/README.md`](../service-client/README.md)
- The service behind it: [`packages/service/README.md`](../service/README.md)
