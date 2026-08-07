# The binary caches odu's agent closure may be prefetched from.
#
# TWO consumers need this one fact:
#
#   1. Nix itself, as the flake's eval-time `nixConfig` — so a
#      `nix run --accept-flake-config .#odu` substitutes rather than builds.
#   2. `@kolu/surface-remote`'s provisioning, which REQUIRES an
#      `AgentBinaryCache` on every `AgentDerivation` arm (kolu#2018) so that no
#      consumer can assemble a cache-blind path. It prefetches the runner's
#      output closure into the coordinator's local store before shipping it to
#      the lane host — and a declared substituter can only act in the LOCAL
#      store, never through a remote daemon's nix.conf.
#
# Nix forbids consumer 1 from importing anything: `nixConfig` must be a literal
# set (a computed one fails eval with "expected a set but got a thunk"). So the
# duplication is forced by the tool — which makes it the kind that must be
# CHECKED rather than trusted. The assertion below is that check: it fails
# `nix build .#odu` (odu's own `nix` CI recipe) with a directed message the
# moment the two spellings drift, so the coordinator can never ship a wrapper
# advertising a cache the flake does not trust.
let
  substituters = [ "https://cache.nixos.asia/oss" ];
  trustedPublicKeys = [ "oss:KO872wNJkCDgmGN3xy9dT89WAhvv13EiKncTtHDItVU=" ];

  flakeText = builtins.readFile ../flake.nix;
  missing = builtins.filter (s: !(builtins.match ".*${s}.*" flakeText != null))
    (substituters ++ trustedPublicKeys);
in
assert builtins.length missing == 0 || throw ''
  nix/binary-cache.nix and flake.nix's nixConfig have drifted.

  Not found verbatim in flake.nix: ${builtins.concatStringsSep ", " missing}

  These are one fact with two consumers, and Nix requires the flake's copy to
  be a literal (nixConfig cannot import). Update flake.nix's extra-substituters
  / extra-trusted-public-keys to match, or update this file to match them.
'';
{ inherit substituters trustedPublicKeys; }
