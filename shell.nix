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
    # What the test suites call on the host, carried rather than assumed: a
    # Cloudflare lane's container has only Nix (no ps, tar from the image is
    # not a promise). transport-death.e2e reads the process table with `ps`;
    # install.e2e copies a tree with `tar`.
    procps
    gnutar
    python3
  ];

  # uv runs apm (`just apm`, install.e2e) and by default DOWNLOADS a generic
  # CPython, which needs an FHS dynamic loader: it runs on a host with nix-ld
  # and dies as "Python interpreter not found" in a Cloudflare lane's bare
  # nixos/nix container (measured, odu's own CI). The shell's Python is the
  # one uv uses, and it never downloads another.
  UV_PYTHON = "${pkgs.python3}/bin/python3";
  UV_PYTHON_DOWNLOADS = "never";

  # The browsers come from nixpkgs, and only in the `e2e` shell (flake.nix) — so
  # the npm `playwright` package must never fetch its own. Set HERE, in the shell
  # where `bun install` runs, rather than there, in the shell where the tests
  # run: a download triggered at install time would land a second, unpinned
  # browser set in ~/.cache and the version the suite then drove would depend on
  # which shell somebody happened to install from.
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
} // oduEnv)
