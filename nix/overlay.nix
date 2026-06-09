# Exposes kolu workspace packages as Nix-store sources. A new @kolu/*
# consumer is a one-line addition.
final: _prev:
let
  mkKoluPackage = import ./packages/kolu-package.nix { pkgs = final; };
in
{
  kolu-surface = mkKoluPackage "surface";
  kolu-surface-nix-host = mkKoluPackage "surface-nix-host";
}
