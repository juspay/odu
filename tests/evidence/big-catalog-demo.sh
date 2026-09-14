#!/usr/bin/env bash
# Reproducible terminal evidence for juspay/odu#113 — `odu status` / `attach`
# against a THOUSAND-RUN catalog, before and after. Recorded with asciinema,
# rendered to a gif with agg — see .agency/do.md → "PR evidence".
#
# Two private worlds (own catalog, own daemon, own port), each seeded with the
# same 1 000 cloned runs: one served by the build BEFORE the fix, one by the
# build after. Nothing here touches your real catalog or your own `odu web`.
#
#   new=$(nix build .#odu --no-link --print-out-paths)/bin/odu
#   old=$(nix build "git+file://$PWD?rev=<base>#odu" --no-link --print-out-paths)/bin/odu
#   asciinema rec --headless --window-size 92x24 -i 2 --overwrite \
#     -c "bash tests/evidence/big-catalog-demo.sh $new $old $PWD" /tmp/big-catalog.cast
set -u
NEW="$1"   # the odu under test
OLD="$2"   # the odu before the fix
WT="$3"    # the odu checkout (fixture source)
CLONES="${CLONES:-1000}"
# Journal lines per clone. A real run's journal is long, and the parse the
# fix removes is proportional to it; a toy fixture's twenty lines hide the cost.
JOURNAL="${JOURNAL:-1500}"

ROOT=$(mktemp -d /tmp/odu-big-catalog-XXXX)
printf '{"%s":"localhost"}' "$(nix eval --impure --raw --expr builtins.currentSystem)" > "$ROOT/hosts.json"

world() {   # $1 = name, $2 = port → exports the three variables odu owns
  mkdir -p "$ROOT/$1/state/runs"
  export ODU_STATE_DIR="$ROOT/$1/state" ODU_HOSTS="$ROOT/hosts.json"
  export ODU_WEB_ORIGIN="http://127.0.0.1:$2"
}
daemon_pid() { "$1" surface get service 2>/dev/null | grep -o '"pid": *[0-9]*' | grep -o '[0-9]*$'; }
# CPU the daemon burns over two idle seconds, as a percentage of one core.
cpu_now() {
  a=$(awk '{print $14+$15}' "/proc/$1/stat"); sleep 2; b=$(awk '{print $14+$15}' "/proc/$1/stat")
  echo "$(( (b - a) * 100 / ($(getconf CLK_TCK) * 2) ))% of a core"
}
cleanup() {
  for pair in "old:18791:$OLD" "new:18792:$NEW"; do
    IFS=: read -r name port bin <<<"$pair"
    world "$name" "$port"
    pid=$(daemon_pid "$bin") && [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done
  rm -rf "$ROOT"
}
trap cleanup EXIT

P='\033[1;32m$\033[0m'
say() { printf "\033[2;37m# %s\033[0m\n" "$1"; sleep 1.2; }
cmd() { printf "$P %s\n" "$1"; sleep 0.6; }

# ── setup: one real run, cloned ───────────────────────────────────────────────
D="$ROOT/checkout"; mkdir -p "$D"
cp "$WT/tests/e2e/fixtures/pass/justfile" "$D/"
printf '.ci/\n' > "$D/.gitignore"
( cd "$D" && git init -q && git add -A &&
  git -c user.email=a@b.c -c user.name=x commit -qm pass ) >/dev/null 2>&1
D=$(cd "$D" && pwd -P)

world new 18792
cd "$D"
SRC=$("$NEW" run --no-strict --no-post -o json 2>/dev/null | grep -o '"runId": *"[^"]*"' | head -1 | grep -o '"[^"]*"$' | tr -d '"')
# Clones are OLDER than the real run (ids encode their start instant), so the
# real one stays this checkout's newest.
python3 - "$ODU_STATE_DIR/runs" "$SRC" "$CLONES" "$JOURNAL" <<'PY'
import json, os, shutil, sys
runs, src, clones, journal = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
digits = "0123456789abcdefghijklmnopqrstuvwxyz"
def b36(n, width):
    out = ""
    while n: n, r = divmod(n, 36); out = digits[r] + out
    return out.rjust(width, "0")
ts = int(src.split("-")[0], 36)
for i in range(clones):
    cid = f"{b36(ts - (i + 1) * 1000, 9)}-{b36(i, 8)}"
    dst = os.path.join(runs, cid)
    shutil.copytree(os.path.join(runs, src), dst)
    for base, _, files in os.walk(dst):
        for name in files:
            path = os.path.join(base, name)
            text = open(path).read()
            if src in text: open(path, "w").write(text.replace(src, cid))
    events = os.path.join(dst, "events")
    lines = open(events).read().splitlines()
    seq, at = json.loads(lines[-1])["seq"], json.loads(lines[-1])["at"]
    pad = (json.dumps({"seq": seq + k + 1, "at": at, "event": {"kind": "phase", "phase": "lanes"}})
           for k in range(max(0, journal - len(lines))))
    open(events, "a").write("\n".join(pad) + "\n")
PY
mkdir -p "$ROOT/old/state/runs" && cp -r "$ROOT/new/state/runs/." "$ROOT/old/state/runs/"
# A fresh daemon per world, so each starts on the catalog as it now stands.
kill "$(daemon_pid "$NEW")" 2>/dev/null; sleep 1

clear
say "Two private catalogs, identical: one real run and $CLONES clones, ~$JOURNAL-line journals."
cmd "ls \$ODU_STATE_DIR/runs | wc -l"
ls "$ROOT/new/state/runs" | wc -l; sleep 1.5

say "BEFORE — the build this PR is based on. Its poller parses every run, every tick."
world old 18791
"$OLD" web --background >/dev/null 2>&1; sleep 3
cmd "time timeout 30 odu status"
( time timeout 30 "$OLD" status ) 2>&1 | grep -v '^$' | grep -v '^user\|^sys'
[ "${PIPESTATUS[0]}" = 124 ] && echo "  → no answer in 30s"
cmd "cpu <daemon> over 2s idle"
cpu_now "$(daemon_pid "$OLD")"; sleep 1.5

say "AFTER — this PR. A warm tick stats files; status is one run.list call."
world new 18792
"$NEW" web --background >/dev/null 2>&1; sleep 3
cmd "time odu status"
( time "$NEW" status ) 2>&1 | grep -v '^$' | grep -v '^user\|^sys'
sleep 1.5
cmd "odu history list --all | wc -l"
"$NEW" history list --all | wc -l; sleep 1.2
cmd "odu attach"
"$NEW" attach; sleep 1.5
cmd "cpu <daemon> over 2s idle"
cpu_now "$(daemon_pid "$NEW")"; sleep 3
