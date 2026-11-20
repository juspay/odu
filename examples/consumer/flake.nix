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
