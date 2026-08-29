# @odu/run-client

Everything you need to **talk to** a live odu run, and nothing odu needs to
**do** one.

odu's coordinator fans every lane in and serves one typed surface on
`<checkout>/.ci/odu.sock`. This package is the half of odu a *client* of that
socket holds — the `oduSurface` contract, the state vocabulary it speaks, the
node-id format, and the dial that reaches it — carved out so a consumer can
subscribe a run's cells **without installing the coordinator**.

```ts
import { dialRun, runSocketPath } from "@odu/run-client/dial";
import { runPhase, STATUS_META } from "@odu/run-client/surface";
import { Effect, Stream } from "effect";

const run = await dialRun(runSocketPath(worktree));
if (run === null) return; // no run in progress — the ordinary case, see below
const state = await Effect.runPromise(
  Stream.runHead(run.client.surface.nodes.get(undefined)),
);
await run.close();
```

Part of the odu repo — `"@odu/run-client": "workspace:*"`.

## Why it is its own package

Hydration is **per-package**. A repo that consumes odu from a content-addressed
pin copies a package *directory* and satisfies that directory's declared
dependencies from its own manifest — so what a consumer pays is the transitive
closure of the **manifests**, not the set of modules its own code happens to
reach. That is the arrangement [`@kolu/padi-client`][padi-client] was extracted
for, and this package is its counterpart on odu's side.

`odu` itself is unusable as that dependency, and not by a small margin. Its
manifest names `@modelcontextprotocol/sdk`, `@opentui/core`, `@xterm/headless`,
`solid-js`, `@preact/signals-core` — an MCP server, a TUI renderer, a terminal
emulator and two reactive runtimes — because odu is a CI *tool*: it renders a
live matrix, serves an agent face, and drives lanes over ssh. None of that is
needed to read a `nodes` cell.

|  | `odu` | `@odu/run-client` |
| --- | --- | --- |
| npm dependencies | 13 | 1 |
| hydrated `@kolu/*` sources | 6 | 1 |
| native / renderer modules | `@opentui/core`, `@xterm/headless` | — |

The line is enforced, not asserted: [`src/closure.test.ts`](src/closure.test.ts)
walks every import in this directory and fails if one climbs out of the package
(it would compile in this repo and be a `TS2307` downstream) or names a package
neither the manifest nor the pinned hydrated set contains.

**odu depends on this package; the arrow never points back.** There is one spec,
in one place, and the coordinator serves the same object its clients dial.

## What a consumer supplies

Copy this directory, then satisfy it with three things:

| | why |
| --- | --- |
| `effect`, at odu's pinned version | this package's only declared dependency, and it must be the **same instance** the rest of your tree resolves — two copies give Effect's `_tag`-based narrowing two class realms to disagree about, and the symptom is a decode error on a frame that is perfectly well-formed |
| `@kolu/surface`, hydrated | a source package, not an install: odu takes it from a Nix pin, and so must you. It is why this package's manifest names no `@kolu/*` at all — bun would go to the registry for something that is not there |
| `@effect/platform-node` | not this package's dependency: it is what hydrating `@kolu/surface` **costs**, because that library's wire link imports it. Declare it at your own root, the way odu's root manifest does for the same reason |

Copy the *store* form of this directory. A live checkout's
`packages/run-client` carries a `node_modules/` the isolated linker put there,
and copying that would hand the package a second `effect` — the first failure
mode in the table, reached by accident.
`tests/evidence/thin-client-demo.sh` builds exactly this consumer in a scratch
directory and reads a live run through it.

## Absence is a state, not an error

This is the one place the design deliberately departs from its model. padi's
socket belongs to a per-host **daemon** that is meant to be up, so `connectPadi`
rejects when it cannot reach one — being down is news. odu's socket belongs to a
**run**: it appears when `odu run` starts and is gone the moment the run settles.
For any given checkout, sock-absent is the ordinary steady state and the great
majority of the time.

So `dialRun` returns `null` rather than rejecting, and a face is expected to have
an answer for it: odu's CLI turns it into justci's one-line refusal, odu's MCP
face into a structured `{ run: false }`, and a dashboard into the last durable
verdict — or into nothing at all, quietly. A client polling on a timer will get
`null` on nearly every tick. That is the design, not a degraded mode.

The consequence for the wire is stated on `NodeLogMessageSchema`: because a
client is routinely a *different build* from the coordinator it dials, the
encoded bytes are frozen and adding a union arm is a one-way compatibility step.
There is deliberately **no version handshake** — odu's surface carries no `hello`
sibling, and a gate this package cannot enforce on the serving side would be a
promise it does not keep.

## The export map

| entry | what it is | browser-safe |
| --- | --- | --- |
| `./surface` | `oduSurface` — the Effect Schema contract for the fan-in socket, its typed face (`OduClient`, `oduClientOver`), and the whole state vocabulary it speaks: `PipelineState` / `NodeState` / `NodeStatus` and the `STATUS_META` table that says what a status MEANS (glyph, hue, GitHub state, verdict redness), `RunHeader` and its lane roster with the `runPhase` / `leasedLanes` / `claimingLanes` folds over it, `NodeLogMessage` and the `clampLog` bound its snapshots obey, and posting health. Also the two shared blocks (`nodePrimitives`, `nodeProcedures`) odu's lane surface is built from | ✅ |
| `./nodeId` | how a node is NAMED — `NodeIdSchema`, and the `<namepath>@<platform>` format with the folds a reader performs on it (`splitFanId`, `onPlatform`, `isSetupNode`, `SETUP_NAMEPATH`). Separate from `./surface` because a face that groups the matrix by platform needs the split and nothing else | ✅ |
| `./dial` | `dialRun` — dial the socket, hand back the typed face and its teardown, or `null` when no run is live — plus the path algebra to find it (`runSocketPath`, `SOCKET_PATH`) | ❌ `node:net` |
| `./asyncConnectError` | the Bun compat shim that restores Node's async-connect-error contract. `./dial` imports it, so a dialer never has to know it exists; it is published for the other caller — a program that SERVES an odu socket and so reaches `probeSocket` without going through a dial. It is the reason `sideEffects` in the manifest is a list and not `false`: a bundler that dropped the shim would turn the ENOENT dial `dialRun` answers `null` for into a throw | ❌ `node:net` |

## What stayed in odu

**The line is what a client of the socket READS, not client-vs-server.** Plenty
of code on the reading side stayed behind. A module stays with odu when it is
odu's own decision rather than the wire's, or when it is a face's business rather
than a reader's:

- **`laneSurface`** (`src/common/laneSurface.ts`) — the coordinator's protocol
  with `odu-runner --stdio`, and the biggest thing that could have come and
  didn't. It shares this package's `nodePrimitives`, so no shape is defined
  twice; what it adds (`run.configure`, `lease.*`) has exactly one reader, and
  the runner is pinned to the build that shipped its coordinator, so both ends
  always ship together. Publishing it would promise a stability nobody needs.
- **`logTail`** — the *server* side of `nodeLog`: the buffer, the channel, the
  `end`-after-`end` refusal. `clampLog` and `MAX_LOG_CHARS` came across because
  they are the bound the wire promises; the pub/sub under them is not a contract.
- **The durable run record** (`src/common/runRecord.ts`) — a run's on-disk
  manifest, and how the live `owed` rows project into it. A different wire: a
  file read by path, not a socket contract, and the layout under it is the
  ledger's. It moves the day a consumer wants a settled run's verdict without
  odu's ledger — on the same terms as everything below.
- **`dialRunOrExit`** (`src/coordinator/socket.ts`) — dial, or print justci's
  refusal and exit. The exiting variant is a CLI's decision, and a library that
  made it for a dashboard would be wrong. The serving half is there too, for the
  reason the whole package exists: a client may be a different build from the
  coordinator it dials; a server *is* the build it is.
- **`transitiveDependents` / `parseAtPlatform`** (`src/common/nodeId.ts`) — the
  DAG walk a rerun does and the `@platform` argv sugar a CLI parses. One is what
  a WRITER computes before it mutates; the other is a command line.
- **`formatGoDuration`** (`src/common/duration.ts`) — justci-byte-compatible
  duration strings. Free to move (it imports nothing) and it has simply never
  been asked for: rendering a duration is a face's own business, and an entry
  nobody asked for is an entry to un-publish later. It moves the day someone
  asks, as `@kolu/padi-client`'s `terminalId` and `screenTail` did.
- **`effectEdge`** (`src/common/effectEdge.ts`) — odu's single sanctioned
  `Effect.run*` boundary, enumerated by `src/common/effectEdges.test.ts`. Moving
  it would move that law out of the repo that enforces it. A consumer already in
  Effect composes the `Stream` this package hands it; one that is not runs it at
  its own edge, in one line.

The behaviour of the vocabulary here is tested from odu's suite (`runPhase` in
`src/common/runPhase.test.ts`, the frozen bytes in
`src/common/schemaBytes.test.ts`), because those tests want odu's shared
fixtures. What is tested *here* is the thing only this directory can state: its
own closure.

[padi-client]: https://github.com/juspay/kolu/tree/master/packages/padi-client
