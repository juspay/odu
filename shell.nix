{ pkgs ? import ./nix/nixpkgs.nix { } }:
let
  oduEnv = import ./nix/env.nix { inherit pkgs; };
in
pkgs.mkShell ({
  packages = with pkgs; [
    just
    jq
    bun
    nodejs # for npm: `just website` builds website/, a standalone npm project
    nixpkgs-fmt
    uv # `just apm` runs apm via `uvx --from apm-cli`
  ];
} // oduEnv)
