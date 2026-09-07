# E2E tests

Black-box end-to-end tests: build the real `odu` binary with Nix, run it
against a throwaway fixture repo on a **localhost lane**, and assert on its
`--progress json` stream and process exit code.

These cover the seams the in-process loopback suite (`src/odu.test.ts`) stubs:
just-DAG ingest → scheduling → local lane spawn (`odu-runner`) → NDJSON
projection → exit code.

## Layout

```
tests/e2e/
├── harness.ts            # nix build, fixture materialization, run + parse
├── run.e2e.test.ts       # the run assertions (bun:test)
├── cancel.e2e.test.ts    # cancel / supersede / linger, driven from a 2nd process
├── protect.e2e.test.ts   # `odu protect --dry-run` context enumeration
├── mcp.e2e.test.ts       # the `odu mcp` agent face over a real MCP client
├── logs.e2e.test.ts      # durable node logs: complete to the last line, one run per file
├── webHarness.ts         # a real web service in a private world (HOME, state, port)
├── web.e2e.test.ts       # the CROSS-FACE gate: one run through browser, CLI,
│                         # HTTP MCP and the singleton
├── fixtures/
│   ├── pass/justfile     # a DAG that goes green
│   ├── fail/justfile     # a DAG whose node fails (exit 1)
│   ├── sleep/justfile    # a DAG that stays running, to cancel out from under
│   └── noisy/justfile    # a DAG that outruns the log wire, then exits at once
└── README.md
```

Run locally:

```sh
bun run test:e2e         # bun test tests/e2e
```

In CI it's the `e2e` step in `ci/mod.just`.

## How a fixture works

A fixture is just a throwaway git repo with a `justfile` — **no flake**. The
coordinator resolves its lane runner from the `ODU_RUNNER_FLAKE` baked into the
`.#odu` binary under test (odu's own flake — `packages/execution/src/coordinator/runnerFlake.ts`),
*not* from the repo under test. So a fixture re-exports nothing: it stands in
for a real consumer that runs odu without exporting `odu-runner` — exactly the
cross-repo path [#30](https://github.com/juspay/odu/issues/30) fixed. (Even for
a localhost lane the realise is a local no-op copy, but the `drvPath` lookup
still runs — now against odu's flake, a Nix cache hit since the harness builds
`.#odu-runner` first.)

The leaf recipes are pure shell — the fixture's own "CI" is trivial on purpose,
so the test exercises *odu's* machinery, not a real toolchain.

## The cross-face gate

`web.e2e.test.ts` is the one suite that can check the property the web release
rests on: a start, a wait, a log read, a retry and a cancel produce the **same
addressed state** whichever door they came through, and the three outcomes
(answered · refused · nothing serving) stay apart at each one. It cannot be a
unit test, because every one of those doors is a separate process.

Its world is private on purpose — `HOME`, `ODU_STATE_DIR` and the port are all
per-suite — so it does not touch a developer's own running `odu web`, and two
copies of the suite on one machine do not fight over a gate.

The browser leg is **skipped**, not failed, where the machine has no Chrome. A
CI runner without a browser is a real environment, and a suite that failed there
would be reporting the environment rather than the code.

## Deliberate tradeoffs

- **The harness builds the binary itself** (`nix build .#odu .#odu-runner`)
  rather than assuming a pre-built `./result`. This makes the suite
  self-contained and order-independent, at the cost of a cold-cache build on
  the first run (hence the 10-minute `beforeAll` timeout). Subsequent runs are
  cache hits.
- **Assertions read `--progress json` (NDJSON), not the TTY dashboard.** The
  dashboard is a separate rendering path; asserting on the clean, parseable
  stream keeps tests robust. The dashboard is currently uncovered by e2e.
- **Local-only.** No remote/ssh lanes are exercised; fixtures run on a
  localhost lane against the live working tree (`--no-strict`).
- **Black-box.** `harness.ts` imports nothing from `src/` — the contract under
  test is the binary's observable behavior, so internal refactors don't ripple
  into these tests.
- **No separate runner config.** These suites need far longer deadlines than a
  unit test and must not run concurrently with each other — a fixture binds the
  one-run lock and `.ci/odu.sock` in its own repo, but two suites racing the
  same nix build and the same machine is how this suite used to flake. Both
  facts are now stated where they apply rather than in a config file: each
  `it`/`beforeAll` names its own timeout as a trailing argument, and `bun test`
  already runs test *files* one at a time. So `bun test tests/e2e` needs no
  flags beyond the path.

## Follow-ups

- Cover the **TTY dashboard** / `attach` live view (PTY-driven).
- Exercise a **real transport**: an ssh-to-localhost lane to cover the
  `nix copy` → remote realise → spawn-over-ssh path that localhost
  short-circuits.
- Drive the **MCP agent face** (`odu mcp`) end-to-end as a subprocess.
- Drive `odu mcp --service` (the stdio bridge to the singleton) as a subprocess;
  the HTTP face of the same projection is covered.
- Cover `status -o json` and `logs -f` against a live run (they need the
  `.ci/odu.sock` socket, so the harness would run `odu run` in the background
  and dial it concurrently).
- **Multi-platform fanout** once remote lanes are in scope.
