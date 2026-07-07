# Exposes kolu workspace packages as Nix-store sources. A new @kolu/*
# consumer is a one-line addition.
final: _prev:
let
  mkKoluPackage = import ./packages/kolu-package.nix { pkgs = final; };
in
{
  kolu-surface = mkKoluPackage "surface";
  kolu-surface-mcp = mkKoluPackage "surface-mcp";
  kolu-surface-remote = mkKoluPackage "surface-remote";
  # `surface-remote` imports `@kolu/shell-quote` (its ssh-command construction)
  # and `@kolu/surface-map` (`serveHostMap`'s host-topology surface), so the
  # consumer must hydrate those transitive sources too — TypeScript resolves
  # the import from the hydrated package's real location.
  kolu-shell-quote = mkKoluPackage "shell-quote";
  kolu-surface-map = mkKoluPackage "surface-map";
}
