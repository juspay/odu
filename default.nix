# Root composer for odu's Nix packages. Used by flake.nix (thin wrapper),
# shell.nix, and nix-build directly.
#
# `selfFlake` is odu's OWN flake source (`self.outPath`), threaded in by
# flake.nix so the `odu` wrapper bakes it as ODU_RUNNER_FLAKE — the coordinator
# resolves the GENERIC lane runner from odu's flake, never the consumer's. It is
# null under plain `nix-build` / `shell.nix` (no `self`): the wrapper bakes
# nothing, and such a binary refuses to run until given ODU_RUNNER_FLAKE (there
# is no override or fallback to the repo under test).
{ pkgs ? import ./nix/nixpkgs.nix { }, selfFlake ? null }:
let
  version = (pkgs.lib.importJSON ./package.json).version;

  src = pkgs.lib.fileset.toSource {
    root = ./.;
    fileset = pkgs.lib.fileset.unions [
      ./package.json
      ./pnpm-lock.yaml
      ./tsconfig.json
      ./vitest.config.ts
      ./src
      ./scripts
    ];
  };

  pnpmDeps = pkgs.fetchPnpmDeps {
    pname = "odu";
    inherit version src;
    hash = "sha256-amkFs395vTG+HeB3t6eE7m6txaSXGrqaNi1l+C9EDdU=";
    fetcherVersion = 3;
  };

  # The repo tree with node_modules installed and the @kolu/* surface
  # libraries hydrated from the npins kolu pin — tsx-runnable, no build
  # step (the kolu/drishti convention).
  base = pkgs.stdenv.mkDerivation {
    pname = "odu-base";
    inherit version src pnpmDeps;
    nativeBuildInputs = [ pkgs.nodejs pkgs.pnpm pkgs.pnpmConfigHook ];
    dontBuild = true;
    dontFixup = true;
    installPhase = ''
      runHook preInstall
      sh scripts/hydrate-kolu-packages.sh \
        ${pkgs.kolu-surface} @kolu/surface \
        ${pkgs.kolu-surface-mcp} @kolu/surface-mcp \
        ${pkgs.kolu-surface-nix-host} @kolu/surface-nix-host
      cp -r . $out
      runHook postInstall
    '';
  };

  # Lane agent: the coordinator `nix copy`s this derivation's closure to
  # each lane host, realises it there, and runs it over
  # `ssh <host> odu-runner --stdio`. `nix` is deliberately NOT pinned on
  # either PATH: the lane host's own nix realised the closure, and a
  # pinned client older than the host daemon corrupts CA-derivation
  # handling — the host that provides the daemon provides the client.
  odu-runner = pkgs.runCommand "odu-runner"
    {
      nativeBuildInputs = [ pkgs.makeWrapper ];
      meta.mainProgram = "odu-runner";
    } ''
    mkdir -p $out/bin
    makeWrapper ${pkgs.tsx}/bin/tsx $out/bin/odu-runner \
      --add-flags "${base}/src/runner/main.ts" \
      --prefix PATH : ${pkgs.lib.makeBinPath [
        pkgs.nodejs
        pkgs.git
        pkgs.just
        pkgs.util-linux
        pkgs.bash
        pkgs.coreutils
      ]}
  '';

  odu = pkgs.runCommand "odu"
    {
      nativeBuildInputs = [ pkgs.makeWrapper ];
      meta.mainProgram = "odu";
    } ''
    mkdir -p $out/bin
    makeWrapper ${pkgs.tsx}/bin/tsx $out/bin/odu \
      --add-flags "${base}/src/cli/main.ts" \
      --set ODU_GH_BIN "${pkgs.gh}/bin/gh" \
      --set ODU_SELF "$out/bin/odu" \
      ${pkgs.lib.optionalString (selfFlake != null) ''--set ODU_RUNNER_FLAKE "${selfFlake}"''} \
      --prefix PATH : ${pkgs.lib.makeBinPath [
        pkgs.nodejs
        pkgs.git
        pkgs.gh
        pkgs.just
        pkgs.openssh
        pkgs.bash
        pkgs.coreutils
      ]}
  '';
in
{
  inherit odu odu-runner pnpmDeps base;
}
