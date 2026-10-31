# Browser acceptance

Gherkin scenarios, driven through Playwright, against a real `odu web-daemon`
serving a real catalog of real runs. Every scenario **clicks, types or tabs** its
way through the page; nothing here calls a surface verb to do what a control
does.

```sh
just e2e-web                             # everything, browsers and binary included
just e2e                                 # this suite and e2e-cli, both

# or, once inside the e2e shell:
nix develop .#e2e --accept-flake-config
cd packages/web-acceptance
ODU_BIN="$(nix build ../..#odu --no-link --print-out-paths)/bin/odu" bun run test
bun run test features/logs.feature       # one feature
bun run test features/logs.feature:22    # one scenario, by line
```

## What is under test

**The packaged Nix odu, and there is no fallback.** `ODU_BIN` names the wrapper
`nix build .#odu` produces. `bun src/main.ts` is not odu: it has none of the
locators the wrapper bakes (`ODU_SELF`, `ODU_WEB_DIST`, `ODU_BUILD_ID`), so it
cannot even serve the page these features are about. `support/service.ts` throws
rather than substituting one.

Each worker gets its own service in a private world — its own port, its own
`ODU_STATE_DIR`, its own daemon home derived from its own `ODU_WEB_ORIGIN`. A
developer's running `odu web` is untouched. `HOME` is deliberately **not**
redirected; `support/service.ts` records the CI-only failure that taught us why.

## The browser is required

There is no `@skip` in this suite and no environment check that turns into a
pass. odu's previous browser coverage skipped itself where no Chrome was on
PATH — so on a CI runner it graded nothing, and the one environment where a
regression would be caught by somebody other than its author was the one
environment that never looked.

`support/hooks.ts` therefore has two `BeforeAll` gates, each of which throws once
with the sentence that fixes it:

1. **`PLAYWRIGHT_BROWSERS_PATH` is set.** The browsers come from
   `pkgs.playwright-driver.browsers`, supplied by the `e2e` devShell in
   `flake.nix`.
2. **The npm `playwright` version equals `PLAYWRIGHT_DRIVER_VERSION`.** This is
   the failure most likely to bite. The npm package ships only the driver's
   JavaScript; the browser binaries come from the Nix store, and the driver
   refuses a build it was not compiled against. A drift installs cleanly,
   typechecks cleanly, and then dies at `chromium.launch()` with `Executable
   doesn't exist` naming a store path that IS there — minutes into a lane, with
   nothing in the message pointing at a version. Comparing two strings first
   turns that into one sentence naming both numbers.

`pins.test.ts` covers the other half at unit speed: the npm pin must be an exact
version (never a caret), and it must equal what the pinned nixpkgs carries. Move
the two together or not at all.

## Arranging a run, versus acting on one

Starting a run through `run_start` is **arrangement**: a scenario about the retry
button needs a failed node to press it on, and driving the create form for one in
every feature would be testing the form nine times. Nothing in this suite *acts*
through the wire — every retry, cancel, page and selection goes through a
control, because that is the acceptance criterion.

Two step phrasings keep shared and private runs apart:

| Step | Run | May be mutated |
| --- | --- | --- |
| `a settled red run of the failing fixture` | the worker's cached one | **no** |
| `a settled run of the fixture whose node prints five thousand lines` | the worker's cached one | **no** |
| `a fresh settled red run of the failing fixture` | this scenario's own | yes |
| `a run of the fixture where one lane fails at once and its sibling sleeps` | this scenario's own, live | yes |

Caching matters: about a third of these scenarios only *look* at a run, and a
coordinator per scenario would put the leg outside the CI workflow's budget on
two platforms. `support/corpus.ts` re-checks a cached run on every reuse and
fails naming every scenario that has touched it — read its header for what that
guard can and cannot tell you.

## Layout, and where a row's promises live

A feature is a promise, and a promise has an OWNER: each row keeps the features
that grade it and the steps that drive its surface under `packages/<row>/e2e/`,
so a change to a row is a diff inside that row. What is here is the HARNESS and
the shell.

```
cucumber.js               the one profile (`ui`), and its five knobs
support/parallelism.js    how many workers, and why the cap is 2 here
support/browser.ts        the one Chromium argv, and why each flag is in it
support/service.ts        the packaged odu, its private world, and the fixtures
support/authWorld.ts      the worlds a tag can declare, and the sign-in flow
support/githubStub.ts     a GitHub small enough to be one file, for the door
support/corpus.ts         the per-worker cache of runs scenarios only read
support/world.ts          the typed World: page, service, ledgers, locators
support/hooks.ts          lifecycle, the two gates, screenshots, teardown
features/*.feature        the SHELL: the wire, the keyboard, a narrow viewport
step_definitions/*.ts     the shared vocabulary every feature speaks
runner.test.ts            the suite is handed to bun, not to a node shebang
pins.test.ts              the playwright pin is exact and matches nixpkgs

../cache/e2e/             the cache's five scenarios, and its CLI test
../ci/e2e/                the run views' six features
../auth/e2e/              the door's scenarios, and its CLI/MCP test
```

**`@seam` is not a skip.** It marks a scenario whose promise needs
`SurfaceAppConnection.close` to be live — kolu PR #2330 has it, and odu's lease
release already calls it, so the tag comes off with the re-pin. The scenario is
complete and stays in the tree; the default tag expression excludes it until
then.

**Scenarios declare their world by tag.** No tag is today's loopback daemon;
`@anonymous` and `@signed-in:owner|admin|member` run against a SECOND daemon per
worker, configured against the GitHub stub, with the role granted and the sign-in
completed through the stub as a person would. Two services per worker because a
daemon with a door cannot also be the daemon without one.

Failure screenshots land in `reports/screenshots/` (git-ignored). Set
`ODU_WA_SHOTS=1` to capture the passing scenarios too, and `HEADLESS=false` to
watch one happen.
