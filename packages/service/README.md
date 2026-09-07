# @odu/service

**The cross-run authority.** Everything the singleton web service owns: the
registry projection every face reads the board from, the durable request
receipts that make a lost reply reconcilable, and the handlers behind
`@odu/service-client`'s five verbs.

What it deliberately does **not** own is a run.

## The wall, and the one claim behind it

```text
cli → service → service-client → run-history → run-client
       ↑
       └── ports, bound by the composition root
```

`@odu/execution` is **absent from this package's closure**, and
`src/closure.test.ts` asserts it. The day the service imports the coordinator is
the day the web face can no longer be reasoned about — or tested — without one.

So the three things the service must *cause* arrive as function types the root
binds (`./ports`):

| port | what it does | bound at the root to |
| --- | --- | --- |
| `RunLauncher` | start a coordinator | `@odu/execution`'s `packagedLauncher` |
| `RunRetrier` | retry a recorded run | `@odu/execution`'s retry policy |
| `RunCanceller` | reach *this run's* coordinator | a dial of its socket, identity checked |
| `CheckoutProbe` | what git says about a path | `spawnSync("git", …)` |

`RunCanceller` carries the run's `<sha>#<seq>` and not only its endpoint,
because **an endpoint is not an identity**: `.ci/odu.sock` belongs to a
*checkout*, a crashed coordinator keeps its recorded endpoint for the length of
the ownership grace, and in that window a new run can be on the other end of it.
The adapter compares before it mutates. It also answers in three arms rather
than two — cancelled, declined, *unresolved* — because a whole-run cancel routes
into the same teardown a SIGINT takes and the coordinator can exit before its
ack flushes. An unconfirmed cancel is left unresolved and its receipt left open,
which is safe to repeat: cancelling twice cancels once.

Three consequences, and each is the reason the seam exists rather than an
import:

- **The service is testable without a machine.** A suite hands it a launcher
  that records the request and starts nothing, and every path through
  acceptance, receipts and reconciliation runs at the speed of a function call.
- **The web face cannot acquire a second scheduler.** There is exactly one
  answer to "what does retrying mean", it lives in the retry policy, and the
  service reaches it through the port rather than growing its own.
- **The closure stays free of a terminal emulator.** `@odu/cli` carries a
  renderer; a daemon that imported it would ship one to every browser tab's
  server.

## The board is a PROJECTION

The catalog is the truth. `./registry` is a projection of it, and the
distinction is load-bearing: nothing here is written, nothing here is
authoritative, and a row that disagrees with a run's own files is a bug in that
module rather than a second opinion a reader has to reconcile.

It exists for one reason — a surface `collection` is read on every subscribe and
every publish, and re-folding forty journals on each of those is a cost the
browser pays in latency and the disk pays in reads.

**Freshness is a fingerprint, not a clock.** A row changes when its files
change, so a refresh compares a cheap `stat` of the three that can move — the
journal, the verdict, the ownership record — and re-folds only what moved. A
settled run from last week is stat'd and skipped. There is nothing to
invalidate, because the fingerprint *is* the invalidation.

**Owner liveness is part of that fingerprint, because it is not a file.** A
coordinator that crashes stops writing, so it stops moving the very files a
"did anything change?" check reads — and then its heartbeat ages past the
ownership grace with nothing on disk to say so. Fingerprinting files alone left
such a row reading `running` for ever. So the fence's own answer is computed
once per run per tick and folded into the stamp beside the three `stat`s.

**Discovery is the catalog and only the catalog.** A run started by `odu run` in
a terminal, before the service existed, appears on the board the moment the
service reads the catalog — without scanning arbitrary filesystem paths for
`.ci` directories, which is the thing a per-user catalog was introduced to stop
anyone having to do.

## One execution per request ID

`run.start` claims its request id and pre-mints the run id **before it looks at
the checkout at all**, in the service's own state
(`<state>/odu/service/receipts/<ID>.json`, beside the catalog rather than inside
it — a start has no run to belong to yet, which is exactly why it needs a
receipt).

That ordering is what makes a crash survivable. A repeat that finds an
unfinished claim does not spawn again to find out what happened; it asks the
catalog whether that run id exists. One question, one answer, no second
coordinator.

And **the receipt is consulted before the world**, because everything about a
checkout is mutable. HEAD moves; a run starts in it; a run ends in it. A repeat
answered from the checkout got a different answer each time — the id of a run
it never started, or `checkout_refused` for a request that had already
succeeded — which is the same thing as performing it twice. So the digest is
built from what the caller sent (including `supersede`, which changes what the
request *does*), the claim comes first, and every outcome — an accepted run, a
busy checkout, a refused checkout, a failed launch — is written to the receipt
so that repeating the request replays it.

The primitive is `@odu/run-history/receipts` — the same one a retry uses,
generalised over a *directory* rather than a run, so the exclusive-create claim,
the digest conflict rule and the two-phase accept/dispatch/complete story are
shared rather than re-derived. A second implementation would be a second set of
rules about what an unfinished claim means, and those rules are the entire
point.

## What startup does, and what it deliberately does not

`./reconcile` settles every unfinished start claim whose run reached the
catalog, and leaves the rest in flight — an absent run means either "the launch
never happened" or "the coordinator is seconds from registering", and startup is
exactly when those two are least distinguishable.

It does **not** dial surviving coordinators and bury the unreachable ones.
**Link loss is not proof of death**: a coordinator mid-restart, a socket on a
briefly-unavailable filesystem, a machine under load — all answer nothing and
all are alive. The ownership fence already answers "is that writer alive" from a
pid, a host, a heartbeat and an epoch, which is why the board can report
`owner_lost` without anything having reconciled it.

## Docs

- The contract: [`packages/service-client/README.md`](../service-client/README.md)
- The catalog underneath it: [`packages/run-history/README.md`](../run-history/README.md)
