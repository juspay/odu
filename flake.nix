# IMPORTANT: this flake intentionally has ZERO inputs (the kolu
# convention) — nixpkgs and the kolu pin are managed by npins and
# imported via fetchTarball, keeping `nix develop` fast.
{
  nixConfig = {
    extra-substituters = "https://cache.nixos.asia/oss";
    extra-trusted-public-keys = "oss:KO872wNJkCDgmGN3xy9dT89WAhvv13EiKncTtHDItVU=";
  };

  outputs = { self, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      eachSystem = f: builtins.listToAttrs (map
        (system: {
          name = system;
          value = f (import ./nix/nixpkgs.nix { inherit system; });
        })
        systems);
    in
    {
      packages = eachSystem (pkgs:
        let odu = import ./default.nix { inherit pkgs; selfFlake = self.outPath; };
        in {
          inherit (odu) odu odu-runner pnpmDeps;
          default = odu.odu;
        });
      devShells = eachSystem (pkgs: {
        default = import ./shell.nix { inherit pkgs; };
      });
    };
}
