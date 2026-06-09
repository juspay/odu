{ pkgs ? import ./nix/nixpkgs.nix { } }:
let
  oduEnv = import ./nix/env.nix { inherit pkgs; };
in
pkgs.mkShell ({
  packages = with pkgs; [
    just
    jq
    nodejs
    pnpm
    tsx
    nixpkgs-fmt
  ];
} // oduEnv)
