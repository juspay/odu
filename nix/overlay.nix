# Exposes kolu workspace packages as Nix-store sources. A new @kolu/*
# consumer is a one-line addition.
final: _prev:
let
  mkKoluPackage = import ./packages/kolu-package.nix { pkgs = final; };
in
{
  kolu-surface = mkKoluPackage "surface";
  kolu-surface-mcp = mkKoluPackage "surface-mcp";
  kolu-surface-nix-host = mkKoluPackage "surface-nix-host";
  # `surface-nix-host` imports `@kolu/shell-quote` (its ssh-command construction),
  # so the consumer must hydrate that transitive source too — TypeScript resolves
  # the import from the hydrated package's real location.
  kolu-shell-quote = mkKoluPackage "shell-quote";
}
