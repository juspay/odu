# odu Cloudflare lane — container entrypoint.
#
# Runs as PID 1's child inside docker.io/nixos/nix (single-user Nix, root, full
# caps). The Worker passes this file as `bash -c "$ODU_LANE_ENTRYPOINT"`, so the
# image needs no Dockerfile. It applies the three fixes a Firecracker container
# needs before Nix builds behave like they do on a CI box, then realises the
# pinned bun and execs the WebSocket bridge (bridge.ts) on :8080.
#
# Inputs (container env, set by the Durable Object):
#   ODU_LANE_BUN              /nix/store/…-bun-X (odu's own pinned bun)
#   ODU_LANE_BRIDGE           bridge.ts source text
#   ODU_LANE_SUBSTITUTERS     space-separated substituters (lane cache first)
#   ODU_LANE_TRUSTED_KEYS     space-separated public keys
#   ODU_LANE_NETRC            optional netrc body for the lane cache
set -euo pipefail
echo "odu-lane: entrypoint starting ($(nproc) cpu)"

# 1. /dev/shm is missing (CF mounts a devtmpfs over /dev after the shm mount);
#    python multiprocessing and friends need it.
mkdir -p /dev/shm
mount -t tmpfs -o mode=1777,size=2g shm /dev/shm 2>/dev/null || true
chmod 1777 /dev/shm

# 2. /dev/kvm is root-only (0600); builds run as nixbld users, so without this
#    QEMU silently falls back to TCG.
if [ -e /dev/kvm ]; then chmod 666 /dev/kvm; fi

# 3. Nix configuration: the lane cache + odu's caches, KVM features, and
#    `git+https`/tarball-friendly defaults (github: refs hit api.github.com,
#    which rate-limits Cloudflare's shared egress).
mkdir -p /etc/nix
if [ -n "${ODU_LANE_NETRC:-}" ]; then
  printf '%s\n' "$ODU_LANE_NETRC" > /etc/nix/netrc
  chmod 600 /etc/nix/netrc
fi
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

printf '%s' "$ODU_LANE_BRIDGE" > /odu-lane-bridge.ts
nix-store --realise "$ODU_LANE_BUN" >/dev/null
echo "odu-lane: bridge starting"
exec "$ODU_LANE_BUN/bin/bun" /odu-lane-bridge.ts
