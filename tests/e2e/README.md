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
├── run.e2e.test.ts       # the assertions (Vitest)
├── fixtures/
│   ├── _flake.nix.in     # shared flake template (re-exports odu-runner)
│   ├── pass/justfile     # a DAG that goes green
│   └── fail/justfile     # a DAG whose node fails (exit 1)
└── README.md
```

Run locally:

```sh
pnpm test:e2e            # vitest run --config vitest.e2e.config.ts
```

In CI it's the `e2e` step in `ci/mod.just`.

## How a fixture works

A local `odu run` resolves its lane runner by evaluating
`<repo>#packages.<system>.odu-runner.drvPath` (`src/coordinator/run.ts`) — this
happens even for a localhost lane (the realise is a local no-op copy, but the
drvPath lookup still runs). So **any repo that runs odu locally must expose
`odu-runner` in its flake.** Each fixture is therefore a flake: the harness
rewrites `__ODU_FLAKE__` in `_flake.nix.in` to a `path:` input pointing at the
checkout under test and re-exports its packages, so the fixture runs the exact
`odu-runner` the harness just built (a Nix cache hit).

The leaf recipes are pure shell — the fixture's own "CI" is trivial on purpose,
so the test exercises *odu's* machinery, not a real toolchain.

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

## Follow-ups

- Cover the **TTY dashboard** / `attach` live view (PTY-driven).
- Exercise a **real transport**: an ssh-to-localhost lane to cover the
  `nix copy` → remote realise → spawn-over-ssh path that localhost
  short-circuits.
- Drive the **MCP agent face** (`odu mcp`) end-to-end as a subprocess.
- Cover `status -o json` and `logs -f` against a live run (they need the
  `.ci/odu.sock` socket, so the harness would run `odu run` in the background
  and dial it concurrently).
- **Multi-platform fanout** once remote lanes are in scope.
