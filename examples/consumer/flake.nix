# THE ONE DECLARATION ODU READS FROM A REPOSITORY: the substituter URL in
# `nixConfig`, and the key it is signed with.
#
# Both lines come off the bucket's page on the board (**Use this bucket**) or
# `odu cache use <bucket>`. They are the same two lines a developer needs in
# order to READ from the cache, so this is not an odu setting — it is the fact
# odu reads: `odu ci run` pushes every recipe's `result*` closure here, and
# the push action with no `cache:` finds this line too.
#
# ONE odu cache. A URL odu does not serve is left alone (the run says `not
# pushing`); two it does serve is refused at start, because a repository
# builds for one cache.
{
  description = "A repository that gets its CI and its Nix cache from odu";

  nixConfig = {
    extra-substituters = "https://cache.example.com/main";
    extra-trusted-public-keys = "main-1:7KmFrK05rVrnxkyZi9hJGnJJmRCpg87u6MUQIk7nokQ=";
  };

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forEach = nixpkgs.lib.genAttrs systems;
    in
    {
      # WHAT THE PIPELINE BUILDS, and therefore what the cache ends up holding:
      # a recipe that leaves a `result-*` link pushes that closure.
      packages = forEach (system:
        let pkgs = nixpkgs.legacyPackages.${system}; in {
          default = pkgs.hello;
          docs = pkgs.runCommand "docs" { } "mkdir -p $out && echo built > $out/index.html";
        });

      devShells = forEach (system: {
        default = nixpkgs.legacyPackages.${system}.mkShell {
          packages = [ nixpkgs.legacyPackages.${system}.just ];
        };
      });
    };
}
