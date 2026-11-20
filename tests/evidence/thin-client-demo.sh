#!/usr/bin/env bash
# Reproducible evidence for "odu exports its thin client".
#
# Run from odu's dev shell (it needs `bun` and $ODU_KOLU_SURFACE):
#
#   odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   nix develop -c bash tests/evidence/thin-client-demo.sh "$odu" "$PWD"
set -eu

ODU="$1"   # path to the nix-built odu binary
WT="$2"    # the odu checkout (source of packages/run-client and the fixture)

: "${ODU_KOLU_SURFACE:?run this inside the odu dev shell (nix develop)}"
command -v bun >/dev/null || { echo "bun not on PATH — run inside nix develop" >&2; exit 1; }

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
serving_or_dead() { socket_live || run_gone; }

cleanup() {
  if [ -n "$RUN_PID" ] && ! run_gone; then
    (cd "$FIXTURE" && "$ODU" ci cancel >/dev/null 2>&1) || true
    wait_until 40 run_gone || kill "$RUN_PID" 2>/dev/null || true
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

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

mkdir -p "$FIXTURE"
cp -r "$WT/tests/e2e/fixtures/fast-slow/." "$FIXTURE/"
(cd "$FIXTURE" && git init -q && git add -A && git -c user.email=demo@odu -c user.name=demo commit -qm fixture)

SYS="$(nix eval --impure --raw --expr builtins.currentSystem)"
export ODU_HOSTS="$SCRATCH/hosts.json"
printf '{"%s":"localhost"}' "$SYS" > "$ODU_HOSTS"

(cd "$FIXTURE" && "$ODU" ci run --no-strict >"$SCRATCH/run.log" 2>&1) &
RUN_PID=$!

echo "# waiting for the run's socket …"
wait_until 480 serving_or_dead || true
if ! socket_live; then
  run_gone && echo "the run exited before serving a socket:" >&2 \
           || echo "no socket after two minutes:" >&2
  cat "$SCRATCH/run.log" >&2
  exit 1
fi
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
(cd "$FIXTURE" && "$ODU" ci cancel >/dev/null 2>&1) || true
wait_until 40 socket_gone || true
echo
echo "\$ bun watch.ts $FIXTURE          # same script, no run"
(cd "$CONSUMER" && bun watch.ts "$FIXTURE") || echo "  [watch.ts exited $?]"
