# IMPORTANT: this flake has ZERO inputs *except* `bun2nix` (the kolu
# convention) — nixpkgs and the kolu pin are managed by npins and
# imported via fetchTarball, keeping `nix develop` fast.
#
# `bun2nix` is the ONE documented exception: there is no fetchBunDeps /
# buildBunPackage in nixpkgs, and bun2nix's nix layer is flake-parts-
# shaped — it cannot be cleanly imported from a non-flake-parts context.
# juspay/bun2nix's `rawflake` branch exposes `lib.mkBun2nix { pkgs }` so
# we feed it OUR npins-pinned pkgs (no transitive nixpkgs eval in our
# flake). The input is only forced when the `packages.*` attrset is
# evaluated — `nix develop` cold eval stays unchanged. DO NOT add
# further flake inputs.
{
  inputs.bun2nix.url = "github:juspay/bun2nix/rawflake";

  nixConfig = {
    extra-substituters = "https://cache.nixos.asia/oss";
    extra-trusted-public-keys = "oss:KO872wNJkCDgmGN3xy9dT89WAhvv13EiKncTtHDItVU=";
  };

  outputs = { self, bun2nix, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      eachSystem = f: builtins.listToAttrs (map
        (system:
          let pkgs = import ./nix/nixpkgs.nix { inherit system; };
          in {
            name = system;
            value = f {
              inherit pkgs;
              b2n = bun2nix.lib.mkBun2nix { inherit pkgs; };
            };
          })
        systems);
    in
    {
      packages = eachSystem ({ pkgs, b2n }:
        let
          odu = import ./default.nix {
            inherit pkgs b2n;
            selfFlake = self.outPath;
            # The commit this build is OF, when there is one. Absent for a dirty
            # tree, and absent is the honest answer there: a build identity that
            # named a commit whose tree it was not built from would be worse
            # than none, because a supervisor compares builds to decide whether
            # to recycle a running daemon.
            selfRev = self.rev or null;
          };
        in
        {
          inherit (odu) odu odu-runner web-ui;
          default = odu.odu;
          # bun2nix CLI — `nix run .#bun2nix -- -l bun.lock -o bun.nix`
          # regenerates the lockfile-derived nix expression.
          bun2nix = b2n.bun2nix;
        });
      devShells = eachSystem ({ pkgs, ... }: {
        default = import ./shell.nix { inherit pkgs; };
      });
    };
}
