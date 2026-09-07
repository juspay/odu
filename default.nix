# Root composer for odu's Nix packages. Used by flake.nix (thin wrapper),
# shell.nix, and nix-build directly.
#
# `selfFlake` is odu's OWN flake source (`self.outPath`), threaded in by
# flake.nix so the `odu` wrapper bakes it as ODU_RUNNER_FLAKE — the coordinator
# resolves the GENERIC lane runner from odu's flake, never the consumer's. It is
# null under plain `nix-build` / `shell.nix` (no `self`): the wrapper bakes
# nothing, and such a binary refuses to run until given ODU_RUNNER_FLAKE (there
# is no override or fallback to the repo under test).
#
# `b2n` carries the bun2nix helpers; passed in from flake.nix via
# `lib.mkBun2nix { inherit pkgs; }` (juspay/bun2nix rawflake standalone API).
# Every derivation here is backed by `base`, so a b2n-less import can only
# reach the overlay attrs — `base` throws on use if bun2nix isn't wired up.
{ pkgs ? import ./nix/nixpkgs.nix { }, b2n ? null, selfFlake ? null, selfRev ? null }:
let
  version = (pkgs.lib.importJSON ./package.json).version;

  # The agent's binary-cache declaration, baked onto the `odu` wrapper the same
  # way ODU_RUNNER_FLAKE is: surface-remote REQUIRES one on every
  # `AgentDerivation` (kolu#2018), and a coordinator that carries none is
  # misbuilt — `runnerFlake.ts` refuses loudly rather than provisioning
  # cache-blind. Spelled once in nix/binary-cache.nix, which asserts it matches
  # flake.nix's nixConfig.
  binaryCache = import ./nix/binary-cache.nix;

  src = pkgs.lib.fileset.toSource {
    root = ./.;
    fileset = pkgs.lib.fileset.unions [
      ./package.json
      ./bun.lock
      ./bunfig.toml
      ./bun.nix
      ./tsconfig.json
      ./src
      ./packages
      ./scripts
    ];
  };

  # The BROWSER BUNDLE the web service serves.
  #
  # Built from `base` — which already has node_modules and the hydrated
  # `@kolu/*` sources — by the one call `@kolu/surface-app/bun` publishes, so
  # the dist satisfies the freshness contract its own server half is built to
  # serve: content-hashed assets, the commit on the `no-store` shell, module
  # preloads, and precompressed siblings. No bundler config and no plugin,
  # because `packages/web-ui` uses Solid's hyperscript rather than JSX.
  #
  # A DERIVATION of its own rather than a step inside `base`: the bundle is what
  # a browser downloads and `base` is what a coordinator runs, and a lane host
  # realising the runner closure has no business fetching a stylesheet.
  web-ui =
    if b2n == null
    then throw "odu's web bundle needs `b2n` (lib.mkBun2nix output) — invoke via flake.nix"
    else
      pkgs.runCommand "odu-web-ui"
        {
          nativeBuildInputs = [ pkgs.bun ];
          meta.description = "odu's browser bundle";
        } ''
        cp -r ${base} ./tree
        chmod -R u+w ./tree
        cd ./tree
        # The commit the SHELL reports, and the one the service reports, are one
        # value — which is what makes a staleness comparison a real comparison
        # rather than two independent guesses.
        ${pkgs.lib.optionalString (selfRev != null) ''export ODU_COMMIT_HASH="${selfRev}"''}
        bun scripts/build-web-ui.ts $out
      '';

  # The repo tree with node_modules installed and the @kolu/* surface
  # libraries hydrated from the npins kolu pin — bun-runnable, no build
  # step (the kolu/drishti convention).
  #
  # Dep fetching: `b2n.fetchBunDeps` reads the committed `bun.nix` and
  # builds a fake Bun cache via per-tarball FODs (hashes from the
  # lockfile, no network in the build sandbox). `b2n.hook` installs that
  # cache into $src via `bun install --ignore-scripts`.
  base =
    if b2n == null
    then throw "odu's build derivation needs `b2n` (lib.mkBun2nix output) — invoke via flake.nix"
    else
      pkgs.stdenv.mkDerivation {
        pname = "odu-base";
        inherit version src;

        # `b2n.hook` propagates its own bun via propagated-build-inputs.
        # Listing our npins-pinned `bun` FIRST wins on PATH, so the install
        # and the bun the wrappers exec are one and the same version.
        nativeBuildInputs = [ pkgs.bun b2n.hook ];

        bunDeps = b2n.fetchBunDeps {
          bunNix = ./bun.nix;
        };

        # isolated linker, matching `bunfig.toml` — see that file for why
        # hoisting is not an option here (conflicting transitive versions have
        # to nest, and bun cannot create the nested trees in the Nix sandbox on
        # aarch64-darwin). Passed explicitly as well as via bunfig so the flag
        # survives if the hook ever stops reading bunfig.toml. No
        # `--production`: odu has no app/test dependency split, and the
        # hydrated sources and both suites resolve out of the same tree.
        bunInstallFlags = [ "--linker=isolated" ];

        # The fixupPhase walks node_modules and patches shebangs / ELF. For a
        # Bun app this is pure overhead — Bun runs the source directly, no
        # shebangs we care about, no native binaries.
        dontFixup = true;
        dontPatchShebangs = true;

        # Skip the hook's default `bun build --compile` invocation — that flag
        # set targets single-binary executables. odu ships raw TypeScript
        # exec'd by the wrappers below, so there is no build step at all.
        dontUseBunBuild = true;
        dontBuild = true;

        # The @kolu/* packages are NOT in bun.lock — they're Nix-store
        # sources supplied by the overlay (same hydration strategy as the dev
        # shell). Drop the copies in *after* bun install populates
        # node_modules, otherwise bun install would either overwrite our
        # copies or refuse to proceed.
        postBunNodeModulesInstallPhase = ''
          sh scripts/hydrate-kolu-packages.sh \
            ${pkgs.kolu-surface} @kolu/surface \
            ${pkgs.kolu-surface-mcp} @kolu/surface-mcp \
            ${pkgs.kolu-surface-app} @kolu/surface-app \
            ${pkgs.kolu-surface-cli} @kolu/surface-cli \
            ${pkgs.kolu-url-shape} @kolu/url-shape \
            ${pkgs.kolu-surface-remote} @kolu/surface-remote \
            ${pkgs.kolu-shell-quote} @kolu/shell-quote \
            ${pkgs.kolu-surface-map} @kolu/surface-map \
            ${pkgs.kolu-log} @kolu/log \
            ${pkgs.kolu-surface-daemon-supervisor} @kolu/surface-daemon-supervisor \
            ${pkgs.kolu-surface-daemon} @kolu/surface-daemon \
            ${pkgs.osfacts-client} osfacts-client
        '';

        installPhase = ''
          runHook preInstall
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
    makeWrapper ${pkgs.bun}/bin/bun $out/bin/odu-runner \
      --add-flags "${base}/src/runner-main.ts" \
      --prefix PATH : ${pkgs.lib.makeBinPath [
        pkgs.bun
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
    # ODU_GH_BIN is --set-default, not --set: the pinned `gh` is the floor (odu
    # must not depend on one being on PATH), but a caller naming its own must
    # win. As an unconditional --set it read as an override while silently
    # being a hard pin, so a test pointing $ODU_GH_BIN at a stand-in got the
    # real `gh` — and the real GitHub — without a word.
    #
    # ODU_WEB_DIST is --set-default for the same reason: the bundle built with
    # this binary is the floor, and a developer iterating on the browser points
    # the daemon at their own dist without rebuilding the whole wrapper. The
    # commit the shell reports comes from the dist, so a hand-pointed one
    # reports itself honestly rather than claiming the wrapper's identity.
    #
    # ODU_COMMIT_HASH and ODU_BUILD_ID are baked TOGETHER or not at all — the
    # frozen control contract's own rule. A supervisor deciding whether to
    # recycle a running daemon reads the pair, and a half-set identity is
    # refused rather than guessed at. A dirty tree has no navigable commit, so
    # it bakes neither and the daemon honestly reports itself as off-nix.
    makeWrapper ${pkgs.bun}/bin/bun $out/bin/odu \
      --add-flags "${base}/src/main.ts" \
      --set-default ODU_GH_BIN "${pkgs.gh}/bin/gh" \
      --set ODU_SELF "$out/bin/odu" \
      --set-default ODU_WEB_DIST "${web-ui}" \
      ${pkgs.lib.optionalString (selfRev != null) ''--set ODU_COMMIT_HASH "${selfRev}" --set ODU_BUILD_ID "${builtins.baseNameOf base.outPath}"''} \
      --set ODU_AGENT_SUBSTITUTERS "${pkgs.lib.concatStringsSep " " binaryCache.substituters}" \
      --set ODU_AGENT_TRUSTED_PUBLIC_KEYS "${pkgs.lib.concatStringsSep " " binaryCache.trustedPublicKeys}" \
      ${pkgs.lib.optionalString (selfFlake != null) ''--set ODU_RUNNER_FLAKE "${selfFlake}"''} \
      --prefix PATH : ${pkgs.lib.makeBinPath [
        pkgs.bun
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
  inherit odu odu-runner base web-ui;
}
