# @odu/web-ui

**The browser.** Everything a person sees, and nothing a person could not.

This package holds views over `@odu/service-client`'s surface and no domain
logic at all — no second retry rule, no second idea of what "red" means, no
execution path of its own. A control here is one procedure call on the same wire
the CLI and the MCP face use, which is what makes the acceptance gate's *same
addressed state through every face* a property rather than a promise.

`src/closure.test.ts` enforces it: importing `@odu/service`, `@odu/execution` or
`@odu/run-history` is a test failure, not a review comment.

## No JSX, and that is a build decision

Solid's fine-grained JSX needs a compiler plugin, which needs a bundler plugin,
which needs a bundler config, which needs two more dependencies in a tree whose
whole build is `Bun.build` over raw TypeScript. `solid-js/h` is Solid's own
supported no-build mode: the same reactive runtime, the same fine-grained
updates, one import.

The cost is one rule, and it is a rule a reviewer can check by eye:

> **A dynamic value is a FUNCTION.** `el("span", {}, count())` reads the signal
> once, at construction, and never again. `el("span", {}, () => count())` is
> reactive.

That is not a quirk of this package — it is how hyperscript distinguishes a
value from a computation, and it is the same distinction JSX's compiler makes
invisibly.

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
`ODU_WEB_DIST` — with `--set-default`, so a developer iterating on the browser
points the daemon at their own dist without rebuilding the wrapper.

## Two properties that are acceptance gates, not polish

**Keyboard access is not a mode.** Every control is a real `<button>` (see
`./src/dom.ts`, where that decision is made once): reachable by Tab, firing on
Enter and Space, announced as a control, with a disabled state the browser
enforces. The focus ring is styled up, never off. A filter's *pressed* state
rides `aria-pressed` rather than only a colour.

**Narrow viewports work.** The board row is a grid that collapses to two lines
on a phone rather than a table that scrolls sideways. The one place sideways
scrolling is right is inside a log box — a log line is a log line, and wrapping
one changes what it says — so it is scoped there and the page itself never
scrolls sideways.

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
