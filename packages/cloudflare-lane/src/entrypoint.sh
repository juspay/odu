# odu Cloudflare lane — container entrypoint.
#
# Runs inside the stock docker.io/nixos/nix image (single-user Nix, root, full
# capabilities, Firecracker microVM). The Worker hands this file to the image's
# own bash as `bash -c <text>`, so there is no Dockerfile and no registry push.
# It makes the container behave like a CI box, then execs the WebSocket bridge
# (bridge.ts) on :8080 with odu's pinned bun.
#
# Inputs (container env, set by the Durable Object at start):
#   ODU_LANE_BUN              /nix/store/…-bun-X (odu's own pinned bun)
#   ODU_LANE_TINI             /nix/store/…-tini-X (the container's init)
#   ODU_LANE_BASE             space-separated store paths of base tools (awk, sed, ps, …)
#   ODU_LANE_BRIDGE_GZ        bridge.ts, gzip'd and base64'd (env vars are capped at 16 kB)
#   ODU_LANE_SUBSTITUTERS     space-separated substituters (lane cache first; may be empty)
#   ODU_LANE_TRUSTED_KEYS     space-separated public keys
#   ODU_LANE_NETRC            secret: netrc for the Worker-proxied lane cache
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
#                             secret: R2 S3 read keys, for an s3:// lane cache
#   ODU_LANE_GITHUB_TOKEN     secret: optional GitHub token
#
# Secrets are moved into root-only files and REMOVED from the environment
# before the bridge starts, so no runner, recipe or log inherits them as env.
# (Recipes run as root in this container, so a recipe that goes looking can
# still read the files — scope the GitHub token accordingly.)
set -euo pipefail
echo "odu-lane: entrypoint starting ($(nproc) cpu)"

# 1. /dev/shm: Cloudflare mounts a devtmpfs over /dev after the shm mount, so
#    it is missing. Measured: nixos-render-docs fails with a multiprocessing
#    SemLock error without it, and Chromium needs it. The image has no
#    `mount`, so it is a 1777 directory on that devtmpfs — RAM-backed, up to
#    half the container's memory (6 GB on a standard-4), which is what a
#    tmpfs /dev/shm gives a CI host anyway.
mkdir -p /dev/shm
chmod 1777 /dev/shm

# 2. KVM is a guarantee of this lane, not a best effort: without it NixOS VM
#    tests silently fall back to QEMU's software emulation (TCG) and run 2-5x
#    slower. /dev/kvm arrives 0600 root; builds run as nixbld users (measured:
#    "failed to initialize kvm: Permission denied" → TCG), so open it up, then
#    prove it opens. No KVM → the container exits here and the lane start
#    fails with this message instead of a slow lane.
if [ ! -c /dev/kvm ]; then
  echo "odu-lane: FATAL: /dev/kvm is missing — refusing to run a lane without KVM" >&2
  exit 1
fi
chmod 666 /dev/kvm
if ! { exec 3<>/dev/kvm; } 2>/dev/null; then
  echo "odu-lane: FATAL: /dev/kvm cannot be opened — refusing to run a lane without KVM" >&2
  exit 1
fi
exec 3>&-
if [ "$(stat -c %a /dev/kvm)" != "666" ]; then
  echo "odu-lane: FATAL: /dev/kvm is $(stat -c %a /dev/kvm), not 666 — nix build users would fall back to TCG" >&2
  exit 1
fi
echo "odu-lane: KVM ok ($(stat -c '%A' /dev/kvm) /dev/kvm)"

# 3. Nix: the lane cache first, then odu's caches and cache.nixos.org; KVM
#    system features; fall back to building when a substituter is down.
umask 077
mkdir -p /etc/nix /root/.aws
if [ -n "${ODU_LANE_NETRC:-}" ]; then
  printf '%s\n' "$ODU_LANE_NETRC" > /etc/nix/netrc
fi
if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  printf '[default]\naws_access_key_id = %s\naws_secret_access_key = %s\n' \
    "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" > /root/.aws/credentials
fi
# GitHub: Nix's access-tokens (api.github.com from Cloudflare's shared egress
# is rate-limited — measured 403s on `github:` refs) and git's credential
# store for the runner's fetch of a private origin.
if [ -n "${ODU_LANE_GITHUB_TOKEN:-}" ]; then
  printf 'access-tokens = github.com=%s\n' "$ODU_LANE_GITHUB_TOKEN" > /etc/nix/access-tokens.conf
  printf 'https://x-access-token:%s@github.com\n' "$ODU_LANE_GITHUB_TOKEN" > /root/.git-credentials
  printf '[credential "https://github.com"]\n\thelper = store\n' > /root/.gitconfig
fi
umask 022
cat >> /etc/nix/nix.conf <<EOF
experimental-features = nix-command flakes
substituters = ${ODU_LANE_SUBSTITUTERS} https://cache.nixos.org
trusted-public-keys = ${ODU_LANE_TRUSTED_KEYS} cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=
system-features = nixos-test benchmark big-parallel kvm
max-jobs = auto
cores = 0
connect-timeout = 10
fallback = true
EOF
if [ -f /etc/nix/netrc ]; then echo "netrc-file = /etc/nix/netrc" >> /etc/nix/nix.conf; fi
if [ -f /etc/nix/access-tokens.conf ]; then echo "!include /etc/nix/access-tokens.conf" >> /etc/nix/nix.conf; fi

# 4. Host parity for process-heavy CI. Without systemd the kernel keeps its
#    default pid_max (32768 on 4 vCPU); a CI box under systemd has 4194304.
#    Measured: odu's own e2e suites wrap 32768 in minutes, and a recycled pid
#    is how a stale `kill` lands on the wrong process.
echo 4194304 > /proc/sys/kernel/pid_max 2>/dev/null || echo "odu-lane: could not raise pid_max ($(cat /proc/sys/kernel/pid_max))"

unset ODU_LANE_NETRC AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY ODU_LANE_GITHUB_TOKEN
nix-store --realise "$ODU_LANE_BUN" "$ODU_LANE_TINI" ${ODU_LANE_BASE:-} >/dev/null
"$ODU_LANE_BUN/bin/bun" -e 'process.stdout.write(require("node:zlib").gunzipSync(Buffer.from(process.env.ODU_LANE_BRIDGE_GZ, "base64")))' > /odu-lane-bridge.ts
unset ODU_LANE_BRIDGE_GZ
# 6. Base tools for recipe code that runs outside `nix develop` (awk, sed, ps,
#    hostname, …): after the image's own PATH, so they only fill gaps.
for p in ${ODU_LANE_BASE:-}; do PATH="$PATH:$p/bin"; done
export PATH
echo "odu-lane: bridge starting under tini"
# 5. A real init. This process is the container's PID 1, so every orphan a CI
#    run leaves reparents to it — and bun reaps only its own children.
#    Measured: with the bridge as PID 1, killed recipe trees stayed zombies,
#    `kill(pid, 0)` kept answering, and odu's reaping tests timed out. tini
#    reaps them and forwards signals (-s: also when not PID 1).
exec "$ODU_LANE_TINI/bin/tini" -s -- "$ODU_LANE_BUN/bin/bun" /odu-lane-bridge.ts
