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
    uv # `just apm` runs apm via `uvx --from apm-cli`
  ];
} // oduEnv)
