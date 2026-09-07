# @odu/service-client

**What a client of the odu web service holds.** The typed contract the
singleton serves, the shared verb table every face projects it through, and the
dial that reaches it — and nothing else.

It is the browser's half, the generated CLI's half and the MCP bridge's half,
which is the whole reason it is a package rather than three agreements. Three
faces that shared a *convention* would be three faces that drift; three faces
built from one `defineSurface` spec cannot.

## The wall

```text
service-client → run-history (portable half) → run-client
```

`@odu/run-history` is reached for its **portable** modules only — `./schema`,
the durable record shapes this surface re-publishes, and `./ids`, the
cursor/attempt/node-key spellings a caller echoes back. Never its platform I/O.
`src/closure.test.ts` walks the import graph and enforces it, along with the
claim that is this package's own:

> **No `node:` anything.** Every module here is bundled into a browser tab. A
> filesystem read resolves happily at build time and is a blank page at runtime,
> and no compiler will say so — so it is said in a test.

That refusal is exactly why the service's platform half lives one wall up, in
`@odu/service`.

## What the surface is about

The coordinator's own surface (`@odu/run-client/surface`) is about ONE run: it
is served on a checkout's `.ci/odu.sock`, it exists only while that run does,
and everything it says is about the pipeline in front of it.

This one is about EVERY run — the ones still going, the ones that finished last
week, the ones started from a checkout that has since been deleted — because
"what is my CI doing, across all my repositories" is not a question any one
coordinator can be asked.

```text
cells        service      who is serving, which build, and is it ready
collections  runs         the board: every registered run, one row each
             logTails     one attempt's live tail, addressed by log key
streams      nodes        one run's work, as whole self-contained pictures
procedures   run.start    start a run, addressed by an explicit checkout
             run.wait     bounded, resumable attention on one run
             run.retry    live attempt or linked replay — odu decides which
             run.cancel   explicit run / node / lane scope
             log.read     one attempt's bytes, by offset
```

The five procedures project to `run_start`, `run_wait`, `run_retry`,
`run_cancel` and `log_read` — the framework's own `<ns>_<verb>` derivation, so
an MCP tool and an argv verb are one name and cannot drift.

## Three decisions worth knowing

**Run keys are host-global.** Every address is a run id, or a key built from
one — never a path relative to whoever is calling. An MCP host whose cwd is
somebody's home directory must be able to name the same run the browser is
looking at. The one place a filesystem path appears is `run.start`'s
`checkout`, where it is the *subject* of the call rather than an implicit frame
around it.

**A refusal is not a failure of CI.** `ServiceRefused` travels on the
procedures' declared error channel, so the three outcomes stay apart all the way
out to a process exit code: answered (including an answer that reports red CI),
refused, nothing serving. A caller that had to read prose to tell them apart
would eventually get it wrong.

**One log key, not three fields.** A node's output lives at the intersection of
run, node and attempt, and every face has to hand that address to a caller and
take it back verbatim — an attention failure names it, an agent echoes it, a
browser puts it in a URL, an MCP resource makes it a URI segment. A URI segment
is one string, so the three facts travel as one token (`./logKey`), minted and
parsed in one place.

## Docs

- The service itself: [`packages/service/README.md`](../service/README.md)
- The runner: the [repo README](../../README.md)
