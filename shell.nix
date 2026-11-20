{ pkgs ? import ./nix/nixpkgs.nix { } }:
let
  oduEnv = import ./nix/env.nix { inherit pkgs; };
in
pkgs.mkShell ({
  packages = with pkgs; [
    just
    jq
    bun
    nodejs
    nixpkgs-fmt
    zstd
    xz
    bzip2
    versitygw
  ];

  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
} // oduEnv)
