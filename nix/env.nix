# Env vars whose values are Nix-store paths — consumed by the dev shell
# and the build derivation, hydrated into node_modules/@kolu/* by
# scripts/hydrate-kolu-packages.sh.
{ pkgs }:
{
  ODU_KOLU_SURFACE = pkgs.kolu-surface;
  ODU_KOLU_SURFACE_NIX_HOST = pkgs.kolu-surface-nix-host;
}
