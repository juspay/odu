#!/usr/bin/env bash
# Reproducible evidence for "odu exports its thin client": an OUT-OF-REPO
# consumer subscribes a live run's cells through `@odu/run-client` alone —
# no odu source, no odu install, no @kolu/* beyond the one this package's
# closure test pins.
#
# The consumer is built the way a downstream really consumes odu: a scratch
# directory outside the checkout, whose node_modules holds a COPY of
# packages/run-client (not the workspace symlink — a symlink would resolve
# odu's own tree and prove nothing) plus exactly what that package's manifest,
# its hydration note, and the one library it hydrates ask for — the four names
# listed at the consumer's setup below. If the package reached back into
# `src/`, or named a dependency the manifest does not, this script is where it
# fails — the same wall packages/run-client/src/closure.test.ts asserts
# statically.
#
# Run from odu's dev shell (it needs `bun` and $ODU_KOLU_SURFACE):
#
#   odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   nix develop -c bash tests/evidence/thin-client-demo.sh "$odu" "$PWD"
#
# The lane is localhost and the fixture is tests/e2e/fixtures/fast-slow, whose
# DAG finishes eight nodes and then blocks on a long sleep — so the transcript
# shows a run mid-flight: terminal nodes beside a running one.
set -eu

ODU="$1"   # path to the nix-built odu binary
WT="$2"    # the odu checkout (source of packages/run-client and the fixture)

: "${ODU_KOLU_SURFACE:?run this inside the odu dev shell (nix develop)}"
command -v bun >/dev/null || { echo "bun not on PATH — run inside nix develop" >&2; exit 1; }

# Poll a predicate to a deadline. Returns non-zero on timeout rather than
# deciding what that means: "the socket never came up" and "the run is still
# alive" want different words, and `set -e` would take the choice away.
wait_until() {   # $1 = attempts, 250ms apart; the rest is the predicate
  attempts="$1"; shift
  while [ "$attempts" -gt 0 ]; do
    if "$@"; then return 0; fi
    attempts=$((attempts - 1))
    sleep 0.25
  done
  return 1
}

SCRATCH="$(mktemp -d)"
CONSUMER="$SCRATCH/consumer"
FIXTURE="$SCRATCH/fixture"
RUN_PID=""

socket_live() { [ -S "$FIXTURE/.ci/odu.sock" ]; }
socket_gone() { [ ! -S "$FIXTURE/.ci/odu.sock" ]; }
run_gone()    { ! kill -0 "$RUN_PID" 2>/dev/null; }
# The wait that ends either way: the socket came up, or the run died trying.
serving_or_dead() { socket_live || run_gone; }

cleanup() {
  # EXPLICIT pid only — never a pkill. The coordinator is asked to stop
  # through its own surface first; the signal is the fallback for a run that
  # is already gone or never came up.
  if [ -n "$RUN_PID" ] && ! run_gone; then
    (cd "$FIXTURE" && "$ODU" cancel >/dev/null 2>&1) || true
    wait_until 40 run_gone || kill "$RUN_PID" 2>/dev/null || true
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

# ── The consumer: a package that has never heard of odu's src ────────────────
# Its node_modules holds exactly four names, and each is there for a reason it
# can state:
#
#   @odu/run-client   a COPY of packages/run-client (never the workspace
#                     symlink, which would resolve odu's own tree and prove
#                     nothing)
#   @kolu/surface     the one hydrated source that package's manifest note and
#                     closure test admit
#   effect            the one npm dependency that manifest declares
#   @effect/platform-node
#                     what hydrating @kolu/surface COSTS — its wire link imports
#                     it — declared by a consumer at its own root exactly as odu
#                     does (see the root package.json note)
#
# The two npm names are taken from odu's own isolated store WITH their
# transitive closure, rather than installed: this harness has no network, and a
# store copy is the same tree "bun install effect @effect/platform-node" would
# lay down, at the versions odu pins. Only the four top-level links resolve;
# the rest of odu's npm tier is not copied at all.
STORE="$WT/node_modules/.bun"
mkdir -p "$CONSUMER/node_modules/.bun" "$CONSUMER/node_modules/@effect" \
         "$CONSUMER/node_modules/@odu" "$CONSUMER/node_modules/@kolu"

copy_closure() {   # $1 = a .bun store entry, e.g. effect@4.0.0-rc.112
  [ -e "$CONSUMER/node_modules/.bun/$1" ] && return 0
  cp -a "$STORE/$1" "$CONSUMER/node_modules/.bun/$1"
  local link target dep
  while IFS= read -r link; do
    target="$(readlink -f "$link" 2>/dev/null)" || continue
    case "$target" in
      "$STORE"/*) dep="${target#"$STORE"/}"; copy_closure "${dep%%/node_modules/*}" ;;
    esac
  done < <(find "$STORE/$1" -type l)
}

EFFECT_ENTRY="$(cd "$STORE" && echo effect@*)"
PLATFORM_ENTRY="$(cd "$STORE" && echo @effect+platform-node@*)"
copy_closure "$EFFECT_ENTRY"
copy_closure "$PLATFORM_ENTRY"
ln -s ".bun/$EFFECT_ENTRY/node_modules/effect" "$CONSUMER/node_modules/effect"
ln -s "../.bun/$PLATFORM_ENTRY/node_modules/@effect/platform-node" \
      "$CONSUMER/node_modules/@effect/platform-node"

cat > "$CONSUMER/package.json" <<'JSON'
{
  "name": "odu-thin-client-demo",
  "private": true,
  "type": "module",
  "dependencies": {
    "effect": "4.0.0-rc.112",
    "@effect/platform-node": "4.0.0-rc.112"
  }
}
JSON
cp -rL "$WT/packages/run-client" "$CONSUMER/node_modules/@odu/run-client"
cp -rL "$ODU_KOLU_SURFACE"       "$CONSUMER/node_modules/@kolu/surface"
chmod -R u+w "$CONSUMER/node_modules/@odu" "$CONSUMER/node_modules/@kolu"
# The workspace member has a node_modules of its OWN in a live checkout (the
# isolated linker put its declared deps there). A real consumer copies from a
# content-addressed store path, which has none — and it matters: a nested
# effect/ would give the package a SECOND Effect instance while @kolu/surface
# resolved the top-level one, and two Schema realms decode each other frames as
# garbage. Dropping it is what makes this copy the store copy.
rm -rf "$CONSUMER/node_modules/@odu/run-client/node_modules"

cat > "$CONSUMER/watch.ts" <<'TS'
// Everything this consumer knows about odu is these three imports.
import { dialRun, runSocketPath } from "@odu/run-client/dial";
import { splitFanId } from "@odu/run-client/nodeId";
import {
  runPhase,
  STATUS_META,
  type PipelineState,
  type RunHeader,
} from "@odu/run-client/surface";
import { Effect, Stream } from "effect";

const checkout = process.argv[2]!;
const socket = runSocketPath(checkout);

const run = await dialRun(socket);
if (run === null) {
  console.log(`no run in progress at ${socket} — an ordinary state, not an error`);
  process.exit(0);
}

const head = <T,>(s: Stream.Stream<T, unknown>): Promise<T> =>
  Effect.runPromise(Stream.runHead(s)).then((o) => {
    if (o._tag === "None") throw new Error("coordinator closed before sending");
    return o.value;
  });

const header: RunHeader = await head(run.client.surface.header.get(undefined));
const state: PipelineState = await head(run.client.surface.nodes.get(undefined));

console.log(`socket   ${socket}`);
console.log(`phase    ${runPhase(header)}`);
for (const lane of header.lanes) {
  console.log(
    `lane     ${lane.platform} → ${lane.state === "leased" ? lane.host : `claiming from [${lane.pool.join(", ")}]`}`,
  );
}
console.log(`run      ${state.name} @ ${state.sha7}${state.dirty ? "+dirty" : ""}#${state.seq ?? "-"}`);
console.log("");
for (const id of state.order) {
  const node = state.nodes[id];
  if (node === undefined) continue;
  const { glyph, hue, isRed } = STATUS_META[node.status];
  const { namepath, platform } = splitFanId(id);
  const took = node.durationMs === null ? "" : ` ${(node.durationMs / 1000).toFixed(1)}s`;
  console.log(
    `  ${glyph} ${namepath.padEnd(10)} ${platform.padEnd(14)} ${node.status.padEnd(9)} ${hue}${isRed ? " RED" : ""}${took}`,
  );
}

// The log stream: a snapshot frame, then live appends, then a terminal `end`.
const finished = state.order.find((id) => state.nodes[id]?.status === "ok");
if (finished !== undefined) {
  console.log(`\n  nodeLog ${finished}:`);
  await Effect.runPromise(
    run.client.surface.nodeLog
      .get({ id: finished })
      .pipe(
        Stream.takeUntil((f) => f.kind === "end"),
        Stream.runForEach((f) =>
          Effect.sync(() =>
            console.log(
              `    ${f.kind}${"text" in f ? ` ${JSON.stringify(f.text)}` : ""}`,
            ),
          ),
        ),
      ),
  );
}

await run.close();
TS

# ── A live run to dial ──────────────────────────────────────────────────────
mkdir -p "$FIXTURE"
cp -r "$WT/tests/e2e/fixtures/fast-slow/." "$FIXTURE/"
(cd "$FIXTURE" && git init -q && git add -A && git -c user.email=demo@odu -c user.name=demo commit -qm fixture)

SYS="$(nix eval --impure --raw --expr builtins.currentSystem)"
export ODU_HOSTS="$SCRATCH/hosts.json"
printf '{"%s":"localhost"}' "$SYS" > "$ODU_HOSTS"

(cd "$FIXTURE" && "$ODU" run --no-strict >"$SCRATCH/run.log" 2>&1) &
RUN_PID=$!

echo "# waiting for the run's socket …"
wait_until 480 serving_or_dead || true
if ! socket_live; then
  run_gone && echo "the run exited before serving a socket:" >&2 \
           || echo "no socket after two minutes:" >&2
  cat "$SCRATCH/run.log" >&2
  exit 1
fi
# Give the fast nodes a moment to finish so the matrix shows both states.
sleep 3

echo
echo "# the consumer's node_modules, in full:"
(cd "$CONSUMER" && ls node_modules node_modules/@odu node_modules/@kolu node_modules/@effect | sed "s/^/  /")
echo
echo "\$ bun watch.ts $FIXTURE          # from $CONSUMER"
echo
(cd "$CONSUMER" && bun watch.ts "$FIXTURE") || echo "  [watch.ts exited $?]"

echo
echo "# the run is cancelled; the socket goes away with it"
(cd "$FIXTURE" && "$ODU" cancel >/dev/null 2>&1) || true
wait_until 40 socket_gone || true
echo
echo "\$ bun watch.ts $FIXTURE          # same script, no run"
(cd "$CONSUMER" && bun watch.ts "$FIXTURE") || echo "  [watch.ts exited $?]"
