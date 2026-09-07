---
name: odu-mcp
description: odu MCP server launcher — drive CI from a coding agent. `bin/serve` resolves odu via Nix and runs `odu mcp` in the cwd. `odu mcp --service` is the other face: EVERY registered run, through the singleton web service, with the same five verbs the browser and `odu surface` use. See the repo README for the tools/resources and override knobs.
user-invocable: false
---

# odu-mcp

The agent face of [odu](https://github.com/juspay/odu) — an MCP stdio server
that re-exposes a live CI run as agent tools (`run`, `node_rerun`,
`node_cancel`, `lane_cancel`, `wait_for_settle`, `cancel`, `runs`, `lease`, `release`) and subscribable resources
(`surface://streams/nodes`, `surface://collections/logs/{id}`), so Claude Code /
Codex / opencode / Gemini CLI drive CI with structured calls instead of
scraping terminal output.

Every tool takes an optional `checkout` — the absolute path of another
checkout's root; default is the server's own cwd — so one `odu mcp` serves
many trees at once. A `run`-spawned coordinator is DETACHED and the server
never reaps on exit — an agent-harness restart of `odu mcp` alone kills no
run. But the coordinator lives and dies with the process that started it — a
restart of that host kills the run: a service stop kills the whole cgroup,
`detached` or not, and there is deliberately no supervisor escaping that. The
corpse (stale lock, socket, unfinalized reservation in `.ci`) is reported by
name: `runs` / `wait_for_settle` / `node_rerun` answer "this run died at
<sha#seq>" via `@odu/run-client`'s `deadRun`, and starting a new run over the
residue works without `supersede`. (Stop a live one with `cancel` while the
server lives, or `odu cancel` from anywhere.) Resources stay bound
to the home checkout; another checkout's run-state arrives on the verbs, and a
node's log file is addressed off disk via `@odu/run-client`'s `logPathFor`
(`.ci/<sha7>/<platform>/<namepath>.log` — the one spelling; never re-splice it
by hand).

`lease` / `release` are the agent-held venue layer: hold a free box across
discrete tool calls without re-queuing between `run`s. `lease` returns
immediately (`held` or `waiting`); re-call or inventory to observe the line.
`run` reuses held hosts and does not release them on exit.

**`node_rerun` is how you retry ONE lane, and it costs nothing.** It re-runs a
single node (`<recipe>@<platform>`, e.g. `ci::e2e@x86_64-linux`) and its
transitive dependents on the run that is still LIVE — alongside the sibling
lanes, cancelling nothing: the other platforms keep running and the run keeps
its coordinator, its venue leases and its GitHub statuses. That is the move
after a fail-fast: read the red node's log, fix the source, `node_rerun` that
node, `wait_for_settle` again. `run`'s `supersede` is **not** that — it cancels
the whole live run, every lane of it, and exists for replacing a run with a
different commit; using it to retry a flaky lane throws away every other lane's
work. If the run has already settled, `run({linger: true})` is what keeps the
coordinator alive so `node_rerun` still has a run to act on.

`wait_for_settle` defaults to fail-fast: it returns the instant the first node
goes red (`fail_fast_tripped: true`, `settled: false`), so the agent drills into
the failure without blocking on the slow lanes — its `failed[]` is only what's
red so far, and only `passed: true` (a fully settled run) is a trustworthy green.
A verdict about an observed run is stamped with that run's identity — `sha7`
always, `seq` whenever the coordinator reserved an ordinal — so it's clear
*which* run it describes (`seq` is `null` only when none was reserved: a wait
that saw no frame, or the rare case the coordinator couldn't reserve one);
and `unposted[]` carries full owed GitHub status rows
(`{context, lastError, attempts}`) not yet confirmed (reporting debt never
blocks settle — the test verdict stays the truth).
A wait also rides out a dropped LINK: if the connection to the coordinator dies
while the run is still going (a busy coordinator can go quiet long enough for
the transport's keep-alive to give up), it re-dials and keeps waiting rather
than reporting a healthy run as unsettled. The plain-CLI `odu wait` uses the
same settle core over a reader built the same way (both dial through the same
re-dialing client), so the two faces answer a run alike.
Called with **no run live**
it fails loud (an error mirroring `odu status`, not an empty `settled: false`),
and an optional `expected_sha` (prefix-matched against the run's `sha7`) refuses
loud when the live run's commit doesn't match. A run that is still PROVISIONING
— `run` returns as soon as the coordinator serves its socket, which is now
*before* it claims a machine — is a live run: `wait_for_settle` blocks on it, the
`nodes` resource shows `_ci-setup@<platform>` running, and its log resource
carries the runner closure's `copying path …` progress. A claim that never
succeeds arrives as a red `_ci-setup@<platform>` verdict rather than as a
`run`-time error. If the coordinator's socket
closes before it publishes a terminal frame, the verdict comes from the run's
finalized record on disk — never green for a run torn down mid-flight. The
`nodes` resource carries the same `unposted`. MCP `run` tees coordinator
stdout/stderr to `.ci/<sha7>/runs/<seq>.log` — but that tee is the MCP
server's own capture and truncates if the server exits mid-run (a harness
restart); the coordinator-written per-node logs (`logPathFor`) are the
durable record.

A settled node's `surface://collections/logs/{id}` is the last 64KB of its output
and now reliably ENDS at the recipe's final line: a run that settles on its own
holds its lanes open until every node has finished streaming, because a node's
status and its output travel on different streams and the status one arrives
first — so the recipe summary the agent came for used to be the part that never
made it. Read `.ci/<sha7>/<platform>/<node>.log` for the whole thing. A lane that stops streaming with output still owed stamps
`[odu] log truncated: …` into the log, so a drill-in never reads a cut log as a
complete one.

`cancel` stops the live run and waits until it's torn down; `node_cancel` stops
one node (`ci::fmt@plat`) and `lane_cancel` drops a whole platform while the rest
of the run settles (status `cancelled`, not `errored`/`failed`). `run`'s `supersede`
cancels a run already live here before starting (the "stop this, run the fixed
commit" move — the WHOLE run, so see `node_rerun` above for retrying one lane),
`linger` keeps the coordinator serving past settle so a node can
be rerun afterwards, and `no_wait` fails immediately when every host in a venue
pool is busy (default: wait in line). Together they let the agent loop call off
or replace a run instead of stranding it or hitting "a run is already in
progress".

**Every tool above is unchanged, and the resources are bound to a LIVE run.**
When the `nodes` resource reports no live run — the coordinator exited, or died
with the process that started it — an agent with shell access has durable,
addressed equivalents on the native CLI, reading a per-user run catalog rather
than the socket: `odu logs --run R [--attempt N] <node>` for one recorded
attempt, `odu wait --run R [--after CURSOR] [--deadline-ms N]` for a bounded,
resumable verdict whose exits separate "still going, nothing red" (2) and "owner
lost" (3) from "there is a failure to act on" (1), and `odu rerun --run R
<selector>` to retry a recorded run.
`R` is a run id, a unique prefix, `<sha7>#<seq>`, or `latest`; `odu history list`
enumerates them. No MCP tool exposes these — reach for the CLI, or `runs` /
`dead_run` for the checkout-scoped answer this server already gives.

## The other face: `odu mcp --service`

Everything above is about the run live in **this checkout**. `odu mcp --service`
is about **every registered run**: it dials the singleton web service
(`odu web`, `http://127.0.0.1:18440`) and projects the same five verbs the
browser and `odu surface` use, under the same names.

```text
run_start   { checkout, expectedSha, requestId, selectors?, platforms?, hostPins?,
              root?, noDeps?, noStrict?, noSnapshot?, noPost?, supersede? }
run_wait    { runId, after?, deadlineMs?, settle?, limit? }
run_retry   { runId, selector, requestId, expectAttempt? }
run_cancel  { runId, scope: {kind:"run"} | {kind:"node",node} | {kind:"lane",platform}, requestId }
log_read    { key, offset?, limit? }
```

Resources: `surface://cells/service` (who is serving, which build, is it ready),
`surface://collections/runs` (the board), `surface://collections/logTails/{key}`.

Four differences from the face above, and each is the point of it:

- **It is GLOBAL.** A run is addressed by run id, never by your working
  directory, so an agent whose cwd is somebody's home directory reaches the same
  run the browser is looking at. `run_start` takes the checkout as an explicit
  absolute path — the subject of the call rather than an implicit frame around it.
- **It holds no run authority.** Every call goes over the wire to the singleton,
  so a harness restarting this process kills nothing and two agents are two
  clients of one truth.
- **`requestId` is mandatory on every mutation.** That is what makes a lost reply
  reconcilable: the same id repeated returns the recorded answer instead of
  starting a second run. Mint a fresh one per intent, never per attempt.
- **A red answer is a NORMAL result.** `run_wait` returning
  `reason: "failure"` is CI going red — read `failures[].excerpt`, then
  `log_read` its `logKey`. A tool ERROR means odu refused the request itself
  (`code`: `bad_cursor`, `unknown_run`, `checkout_refused`, `request_conflict`, …).
  `reason: "still_running"` means the deadline was reached with nothing red: ask
  again with the returned `cursor` as `after`.

The loop: `run_start` → `run_wait` (bounded; feed the cursor back) → `log_read`
on a failure's `logKey` → `run_retry` for the same commit, or a fresh
`run_start` for a new one. `run_retry` decides for you whether that means a new
attempt on a live coordinator or a linked replay run, and says which in `mode`
— watch `effectiveRun`, not the run you asked about, and drop the old cursor
with it.

`bin/serve` is self-contained — it resolves odu via `nix run` and serves over
stdio in the consumer's repo (dialing `.ci/odu.sock`). Set `ODU_FLAKE` to
override the odu flake-ref (default `github:juspay/odu`); a repo that
re-exports odu can point it at its own pinned output with `ODU_FLAKE=.#odu`.

Full docs in the [repo README](https://github.com/juspay/odu/blob/master/README.md).

This skill primitive exists for APM's deployment convention — it lands
`bin/serve` at `.agents/skills/odu-mcp/bin/serve` in the consumer's working
tree (APM's skills-convergence path), which keeps the launcher available even
before `apm install` runs on a fresh clone. The package is mechanically a
"skill" in APM's primitive vocabulary; semantically it's a tool launcher.
