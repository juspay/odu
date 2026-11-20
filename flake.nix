{
  inputs.bun2nix.url = "github:juspay/bun2nix/rawflake";

  nixConfig = {
    extra-substituters = "https://cache.kolu.dev/kolu-r2";
    extra-trusted-public-keys = "kolu-r2-1:7KmFrK05rVrnxkyZi9hJGnJJmRCpg87u6MUQIk7nokQ=";
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
            selfRev = self.rev or null;
          };
        in
        {
          inherit (odu) odu odu-runner web-ui agent-flake-source;
          default = odu.odu;
          bun2nix = b2n.bun2nix;
        });
      nixosModules = {
        default = import ./nix/module.nix { inherit self; };
        odu = self.nixosModules.default;
      };

      checks.x86_64-linux =
        let
          pkgs = import ./nix/nixpkgs.nix { system = "x86_64-linux"; };
        in
        {
          nixos-module = pkgs.testers.nixosTest (import ./nix/tests/module.nix { inherit self; });
        };

      devShells = eachSystem ({ pkgs, ... }:
        let default = import ./shell.nix { inherit pkgs; };
        in {
          inherit default;
          e2e = default.overrideAttrs (_: {
            name = "odu-shell-e2e";
            PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
            # Exported so the suite can ASSERT the npm pin matches, instead of
            # discovering it at `chromium.launch()`. The driver refuses a browser
            # build it was not compiled against, and the way it says so is
            # `Executable doesn't exist` at a store path that is real but wrong —
            # minutes into a lane, with nothing naming a version. See
            # packages/web-acceptance/support/hooks.ts and pins.test.ts.
            PLAYWRIGHT_DRIVER_VERSION = pkgs.playwright-driver.version;
          });
        });
    };
}
