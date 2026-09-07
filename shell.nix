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

  # The browsers come from nixpkgs, and only in the `e2e` shell (flake.nix) — so
  # the npm `playwright` package must never fetch its own. Set HERE, in the shell
  # where `bun install` runs, rather than there, in the shell where the tests
  # run: a download triggered at install time would land a second, unpinned
  # browser set in ~/.cache and the version the suite then drove would depend on
  # which shell somebody happened to install from.
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
} // oduEnv)
