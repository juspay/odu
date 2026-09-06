# @odu/run-history

What survives the coordinator.

`@odu/run-client` is what you hold to **talk to a run that is live**. This is
what you hold to answer questions about a run **after nobody is serving it** —
which run happened, what failed, on which box, on which attempt, what its log
said, and whether anything is still owed.

```ts
import { resolveRun, waitForAttention } from "@odu/run-history/query";

const found = resolveRun("latest", { repoRoot });
if (!found.ok) throw new Error(found.message);

const attention = await waitForAttention(found.handle, { deadlineMs: 30_000 });
for (const failure of attention.unresolved_failures) {
  console.error(`${failure.node} exited ${failure.exit_code}`);
  console.error(failure.excerpt);           // the tail of THAT attempt's log
  console.error(`read it again: odu logs ${failure.log_key}`);
}
// Feed this back next time; you will not be shown the same events twice.
console.log(attention.cursor);
```

Part of the odu repo — `"@odu/run-history": "workspace:*"`.

## The problem it exists for

Odu's durable history used to live in the checkout: a record at
`.ci/<sha7>/runs/<seq>.json` and one log per `(commit, node)` at
`.ci/<sha7>/<platform>/<node>.log`. Four consequences followed from that one
decision, and all four are things people hit:

| the layout said | so |
| --- | --- |
| evidence lives in the worktree | `git worktree remove` deletes the logs of the run you are debugging |
| one log per *(commit, node)* | a rerun overwrites the failure you were reading |
| history is a directory in a checkout | nothing can list "my runs" without being told which checkouts to look in |
| the coordinator is the only reader | when it exits, "what happened?" has no answer but a terminal verdict line |

So the catalog moved out of the checkout, and the unit of evidence moved from
*the node* to *the attempt*.

## The layout

Per user, not per checkout. `ODU_STATE_DIR` overrides; otherwise
`$XDG_STATE_HOME/odu` (`~/.local/state/odu`) on Linux and
`~/Library/Application Support/odu` on macOS.

```
<state>/odu/runs/<RUN_ID>/
  manifest.json                     identity · snapshot · build · owner
  owner.json                        the ownership fence (see below)
  events                            the ordered journal — one JSON object per line
  verdict.json                      the terminal outcome, once there is one
  expired.json                      tombstone: this run's evidence aged out
  attempts/<ENCODED_NODE>/<N>/log         raw bytes of ONE attempt
  attempts/<ENCODED_NODE>/<N>/record.json how that attempt ended
```

`<RUN_ID>` is `<mint instant, base36>-<random>`, so the catalog listing is a
string sort by start time and discovery never has to open a manifest to order
one. `<ENCODED_NODE>` is a node id with every character outside `[A-Za-z0-9._-]`
escaped as `~<hex>` — reversible, and the reason a crafted node id cannot become
a path.

**The journal is the history.** `verdict.json` and the attempt sidecars are
projections kept for readers that want one fact without folding a file; when a
projection and the journal disagree, the journal is right.

## Four properties, and what each one is defending against

### One writer, and disappearance is not proof

A pid vanishing is what a *crash* looks like and also what a *restart* looks
like. Treating either as "the run is free" gives you two processes appending to
one journal, or a second process publishing a terminal verdict for a run that is
still going — and a fabricated `finalized` line cannot be un-said.

So ownership is an **epoch**, not a pid. A writer claims one and re-checks it
before every durable write, so a superseded coordinator stops at its next write
rather than at a moment it was supposed to notice. A successor claims `epoch+1`
with `O_CREAT|O_EXCL`, so exactly one claimant wins even if a hundred try — and
only after the incumbent is *provably* gone: a heartbeat older than 90s, plus a
dead pid when the incumbent claimed on this host. Across hosts there is only the
heartbeat, and [`owner.ts`](src/owner.ts) says so rather than implying more.

### Old attempts are immutable

A retry allocates attempt *N+1*; nothing ever addresses *N* again. Sealing an
attempt also drops its log to mode `0444` — which does not stop a determined
process, and is not meant to: the guarantee is the addressing, and the mode is
what turns "a retry overwrote it" from a plausible accident into something
somebody had to mean.

### A cursor suppresses repeats; it resolves nothing

The attention query returns `events` *since your cursor* and
`unresolved_failures` *as the run stands* — recomputed in full every time. An
agent that acknowledged a red node and asked again still sees it, because it is
still red. Conflating the two is how a failing run gets reported clean to
whoever asked second.

And the cursor advances **only through delivered events**. If the 16 KiB payload
budget trims the tail, the cursor stops where the trim did and `has_more` says
so — a cursor that ran ahead of what was sent would silently swallow exactly
what a reconnecting caller came back for.

### Running, gone, and finished are three states

`still_running` · `settled` · `owner_lost` · `expired` · `unknown_run`. A
bounded wait that reaches its deadline returns `still_running` — a fact, not a
failure and certainly not a pass. An owner that is provably dead with no
terminal line is `owner_lost`, which is a different recovery from a slow run.
Before these were separate, both looked like "no answer", and a caller either
waited forever or read absence as red.

## The export map

| entry | what it is |
| --- | --- |
| `./ids` | every identity that is both a path segment and something a person types: run ids (`mintRunId`, `isRunId`, `runIdStartedAt`), the reversible node-key encoding (`encodeNodeKey` / `decodeNodeKey`) that doubles as the traversal guard, cursors, `shortSha`, and the `--run` selector grammar (`latest` · `<sha7>#<seq>` · an id or unique prefix) |
| `./schema` | the durable shapes — manifest, journal event, attempt record, verdict, expiry. Versioned, additive-only, and read by builds newer and older than the one that wrote them |
| `./paths` | where the catalog is, and the file names inside a run directory. One module so a reader and a writer cannot disagree about a spelling |
| `./owner` | the ownership fence: `claimOwnership`, `stillOwner`, `heartbeat`, `releaseOwnership`, and `ownershipProvablyLost` — the one place the takeover evidence rule is written down |
| `./store` | every syscall: register, append, seal, read a byte range of an attempt log, list and address runs, expire one |
| `./attention` | the pure fold — journal ⇒ what needs your attention. No I/O; evidence arrives through `AttentionSources`, so it is testable against a hand-built journal |
| `./query` | the two together: resolve what somebody typed, validate their cursor against the run it names, and the bounded wait that returns on the first *actionable* red rather than on settle |
| `./retention` | 30-day default for finished runs, pruned by run and never by sweeping. Expiry is a tombstone, so a stale run id gets "expired, and it failed" rather than "no such run" |
| `./import` | the explicit `.ci` → catalog import, and the reasons it is explicit |
| `./legacy/record`, `./legacy/ledger` | the checkout-scoped format, unchanged: `RunRecord`, `buildRunRecord`, the `<sha7>#<seq>` ref, and the `.ci/<sha7>/runs/` reader and seq reservation. Still written, still read — this release adds a catalog, it does not retire the ledger |

## What it depends on, and what depends on it

`@odu/run-history → @odu/run-client → effect`, and the arrows never point back.
[`src/closure.test.ts`](src/closure.test.ts) walks every import in this directory
and fails if one climbs out of the package or names something the manifest does
not declare — the same instrument `@odu/run-client` carries, for the same reason:
an import that reaches into odu's `src/` compiles here and is a `TS2307` for
anyone who copies the directory.

Both `execution` (the engine) and `cli` (the faces) read history *through this
package*, which is what lets neither of them depend on the other.

## What is deliberately not here

- **A daemon.** Nothing in this package runs in the background. The catalog is
  files; a reader polls the journal's size, which is a `stat`. `fs.watch` was
  not used: its guarantees are per-platform, it degrades silently on network
  filesystems, and it has no answer at all for the case that matters most —
  the writer being a process that may have died.
- **A test reporter.** `AttentionFailure.excerpt_source` has exactly one value
  today (`attempt_log`) and the field exists so that stays visible. Until
  something structured feeds it, no face may imply it had one — and a log that
  cannot be read is reported as `none`, never as a node that produced nothing.
- **Flakiness inference.** Missing evidence is missing evidence.
