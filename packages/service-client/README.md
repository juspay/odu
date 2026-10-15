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

> **No `node:` anything outside the declared node-only modules.** Every module
> the browser reaches is bundled into a tab. A filesystem read resolves happily
> at build time and is a blank page at runtime, and no compiler will say so — so
> it is said in a test.

`./socket` is the one declared exception, and it is the service's LOCAL half
rather than a second contract: the unix socket a face on the same machine dials,
the home its path is derived from (`webAppNamespace`), and the pure
`serviceSocketPath`. It has to live beside `./endpoint` because the address and
the way in are one fact about one daemon — a client that re-derived the home from
the origin would be one rename away from dialling a socket nobody bound. The
wall is what keeps it honest: a browser-safe module that imported it would be
caught, and `dialServiceSocket` answers `{ kind: "absent" }` for a path nobody is
serving rather than turning a missing daemon into an error — and
`{ kind: "refused" }` for a daemon whose contract this build cannot read, so a
face draws the one as nothing and the other as a sentence. The comparison
itself is `admitService`, which lives on the surface beside the version it is
about: no consumer compares contract versions, because the direction of that
comparison is easy to get backwards and a second judge is how it gets got
backwards.

That refusal is exactly why the service's platform half — the serving, the
catalog, the coordinator — lives one wall up, in `@odu/service`.

## The board readings — `./board`

`web-ui` was the board, and the readings a board performs on a row lived inside
it: which runs are moving, which are failing, and what a run is called. A board
is not one face's idea — a terminal dashboard or a downstream panel is the same
board — so they live here now, next to the row shape they read, and `web-ui`
imports them back. The COLLAPSE has since moved further still: "which run
stands for a checkout, and how many are behind it" is `streams.checkout`'s
answer, folded once by the service, because a face holding it had to re-fold on
every row delta and then reopen a second subscription for that run's work every
time the latest run swapped.

The one worth naming is `runStatus`: a run's board STATE and its OUTCOME each
had a column in the browser, and each was empty exactly where the other was
full, so the cell holds whichever IS the answer — the verdict once there is one,
and where the run has got to until then. That precedence is load-bearing: a run
torn down early settles with `passed: false` and `outcome: "incomplete"`, and a
reader that skipped the outcome would call it `failed` and send somebody looking
for a test that broke.

**What a run covered**, and what a row calls it. `scopeSuffix` is the qualifier a
caller appends after a run it has already named — `ci::unit`, `under ci::install`,
`no deps` — or `null` when the run covered the whole pipeline, where a qualifier
says nothing and an empty string would render a stray separator. `scopeLabel` is
the same scope as a board CELL, where an empty selector IS the whole pipeline and
has to say so: `""` there would read as a run that tested nothing. Two renderings
of one scope, deliberately different, composed from one spelling of its parts.

A selection is not a pipeline — the reason a scope rides the row at all. Three
lanes under `selectors: ["ci::unit"]` say nothing about the rest of the DAG, and a
`--root NAMEPATH` run is the same kind of subset, which is why the reading names
both.

**How long a run took** is `runElapsedMs`, and the row carries `finishedAt` so it
can answer. The subtraction stops at the run's own verdict: a settled row that
counted against `now` would report how long ago somebody last looked at the
board, and a run reopened tomorrow would say yesterday's green took a day. Only
a run still going reads the caller's clock, which is what makes exactly one row
tick. `duration` is its spelling — `400ms`, `1.5s`, `1m07s` — here rather than in
a view, because the browser board, `odu history list` and a downstream panel
printing two different durations for one run is the same drift `runStatus`
exists to prevent. The service used to own this subtraction privately, which is
why a settled run's duration was unreachable from anywhere but the live view.

**WHERE a lane ran inside its run** is `laneSpan`, which answers a `left` and a
`width` as fractions of the run's own timeline, and `timelineTicks` MARKS the
axis they are read against — `{ at, ms }`, a position and a number, never a
string: where a mark sits is geometry and is shared, while how a face spells a
duration is that face's own vocabulary (`duration` here, `compactPhrase` in
kolu). A Gantt rather than a row of lengths, because
lengths say how long each lane took and nothing about what ran beside what —
and "what was the critical path" is the question a reader opens a run to ask.
The scale is `runElapsedMs`, so a live run's track stays exactly full as it
grows; a lane that has not started answers `null` rather than a sliver at the
origin, because an empty track is itself the signal. Clock skew clamps into the
track for the reason `runElapsedMs` floors at zero: a lane host behind the
registrar reports a start before the run began, and that is skew rather than a
negative offset. Two faces draw this today — odu's own run detail and kolu's
Inspector — and a face with its own subtraction would place the same lane at
two different x.

## The run address — `./routes`

A run, and one attempt's output within it, are LINKABLE: a person pastes
`#/run/<runId>` or `#/run/<logKey>` into a message and whoever opens it is looking
at the same failure rather than at a board they then have to navigate. That makes
the address a fact about the RUN rather than about one page — the web face is
where it is opened, but it is minted by whoever holds the run (an editor, a
terminal, another app's panel), and a second spelling of `#/run/` at each of those
callers is how one of them comes to mint an address the page does not answer.

So both halves live here, beside `./logKey`, whose token is the second half of the
address: `runHash` · `logHash` mint, `parseRunHash` reads back. The log form takes
the key verbatim, so the address in a URL bar and the address an agent echoes into
`log_read` are one string.

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
             checkout     one checkout, whole: the run it stands for, that
                          run's work, and what ran before
procedures   run.start    start a run, addressed by an explicit checkout
             run.wait     bounded, resumable attention on one run
             run.read     the same answer, without waiting
             run.retry    live attempt or linked replay — odu decides which
             run.cancel   explicit run / node / lane scope
             log.read     one attempt's bytes, by offset — and, with `waitMs`,
                          the follow
             catalog.*    import a checkout's legacy records; prune expired ones
             pipeline.*   the resolved DAG a checkout declares
             venue.*      the machines, and the holds on them
             protect.*    required status checks on a branch
```

The procedures project to `run_start`, `run_wait`, `run_read`, `run_list`, `run_retry`,
`run_cancel`, `log_read`, `catalog_import`, `catalog_prune`, `pipeline_read`,
`venue_probe`, `venue_hold`, `venue_release` and `protect_apply` — the
framework's own `<ns>_<verb>` derivation, so an MCP tool and an argv verb are
one name and cannot drift.

Thirteen, and the growth is the point: five was not a design, it was the subset
of odu's public capabilities that had been moved at the time. `odu status`,
`odu hosts`, `odu lease`, `odu history import` and `odu protect` each did their
own work in the caller's process, so an agent and a browser could not do those
things at all.

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
