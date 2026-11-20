{ pkgs ? import ./nix/nixpkgs.nix { }, b2n ? null, selfFlake ? null, selfRev ? null }:
let
  renderHydratePairs = import ./nix/hydrate-pairs.nix { inherit (pkgs) lib; };

  linkWorkspaceMembers = ''
    for member in packages/*; do
      [ -d "$member/node_modules" ] || continue
      target=$out/workspaces/$(basename "$member")
      mkdir -p "$target"
      cp -a "$member/node_modules" "$target/node_modules"
    done
  '';

  version = (pkgs.lib.importJSON ./package.json).version;
  sources = import ./npins;

  mkAgentSourceTree =
    import "${sources.kolu}/packages/surface-daemon/nix/agent-source-tree.nix"
      { inherit (pkgs) lib; };
  agentFlakeRefEnv =
    (pkgs.lib.importJSON "${sources.kolu}/packages/surface-remote/agent-env.json").flakeRef;
  commitHash = if selfRev == null then "" else selfRev;
  agentSource =
    if selfFlake == null
    then null
    else
      mkAgentSourceTree {
        inherit pkgs;
        name = "odu-agent-flake-source";
        src = selfFlake;
        flakeNix = ./flake.nix;
        label = "odu";
        closureIndex =
          if selfRev == null
          then null
          else { repo = "juspay/odu"; branch = "ca-index"; };
        pusher = { kind = "odu"; };
        extraFiles = { "commit-hash" = commitHash; };
      };

  src = pkgs.lib.fileset.toSource {
    root = ./.;
    fileset = pkgs.lib.fileset.unions [
      ./package.json
      ./bun.lock
      ./bunfig.toml
      ./bun.nix
      ./tsconfig.json
      ./logo.svg
      ./src
      (pkgs.lib.fileset.difference ./packages (pkgs.lib.fileset.unions [
        ./packages/web-acceptance/features
        ./packages/web-acceptance/step_definitions
        ./packages/web-acceptance/support
      ]))
      ./scripts
    ];
  };

  web-ui =
    if b2n == null
    then throw "odu's web bundle needs `b2n` (lib.mkBun2nix output) — invoke via flake.nix"
    else
      pkgs.runCommand "odu-web-ui"
        {
          nativeBuildInputs = [ pkgs.bun ];
          ODU_GEIST_FONTS = pkgs.odu-geist-fonts;
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

  depsSrc = pkgs.lib.fileset.toSource {
    root = ./.;
    fileset = pkgs.lib.fileset.unions [
      ./package.json
      ./bun.lock
      ./bunfig.toml
      ./bun.nix
      (pkgs.lib.fileset.fileFilter (f: f.name == "package.json") ./packages)
      ./scripts/hydrate-kolu-packages.sh
      ./scripts/build-cordis.sh
    ];
  };

  odu-deps =
    if b2n == null
    then throw "odu's dependency tree needs `b2n` (lib.mkBun2nix output) — invoke via flake.nix"
    else
      pkgs.stdenv.mkDerivation {
        pname = "odu-deps";
        inherit version;
        src = depsSrc;

        # `b2n.hook` propagates its own bun via propagated-build-inputs.
        # Listing our npins-pinned `bun` FIRST wins on PATH, so the install
        # and the bun the wrappers exec are one and the same version.
        nativeBuildInputs = [ pkgs.bun b2n.hook ];

        bunDeps = b2n.fetchBunDeps {
          bunNix = ./bun.nix;
        };

        bunInstallFlags = [ "--linker=isolated" ];

        dontFixup = true;
        dontPatchShebangs = true;

        dontUseBunBuild = true;
        dontBuild = true;

        # Drop the copies in *after* bun install populates
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
            ${pkgs.kolu-byte-units} @kolu/byte-units \
            ${pkgs.kolu-surface-map} @kolu/surface-map \
            ${pkgs.kolu-log} @kolu/log \
            ${pkgs.kolu-surface-daemon-supervisor} @kolu/surface-daemon-supervisor \
            ${pkgs.kolu-surface-daemon} @kolu/surface-daemon \
            ${pkgs.osfacts-client} osfacts-client \
            ${pkgs.olai-effect-cordis} @olai/effect-cordis \
            ${renderHydratePairs pkgs.cordis.hydratePairs}
          sh scripts/build-cordis.sh
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p $out
          cp -a node_modules $out/node_modules
          ${linkWorkspaceMembers}
          runHook postInstall
        '';
      };

  base = pkgs.runCommand "odu-base-${version}"
    {
      meta.description = "odu's source tree with node_modules resolved against odu-deps";
    } ''
    cp -r ${src} $out
    chmod -R u+w $out

    shopt -s dotglob nullglob

    # Mirror deps' node_modules one directory at a time. Three kinds of entry,
    # three answers:
    #
    #   a symlink      — replayed VERBATIM. Every one bun writes is relative,
    #                    and the tree it means is THIS one: `.bun/…` lands on
    #                    the reference this same loop makes, and
    #                    `../../packages/<member>` on real source.
    #   a scope (`@…`) — recursed into, because `@odu` holds workspace links and
    #                    `@babel` holds dependency links and only the entries
    #                    themselves know which.
    #   any other dir  — linked BY REFERENCE into the store. That is `.bun` (254
    #                    of the 263 MB this change is about), `.bin`, and the
    #                    hydrated `@kolu/*`, `@olai/*`, `cordis` and
    #                    `osfacts-client` sources. A hydrated package resolves
    #                    its own imports from its REALPATH, which is inside
    #                    `odu-deps`, whose root node_modules is the one holding
    #                    `effect` and `@orpc/*` — the walk-up invariant
    #                    `bunfig.toml` states, now satisfied one derivation over.
    mirror() {
      local from=$1 to=$2 path name
      mkdir -p "$to"
      for path in "$from"/*; do
        name=''${path##*/}
        if [ -L "$path" ]; then
          cp -P "$path" "$to/$name"
        elif [ -d "$path" ] && [ "''${name#@}" != "$name" ]; then
          mirror "$path" "$to/$name"
        else
          ln -s "$path" "$to/$name"
        fi
      done
    }
    mirror ${odu-deps}/node_modules $out/node_modules

    # And each member's own farm back beside its manifest, where the `../../../`
    # hops in it are true again.
    for member in ${odu-deps}/workspaces/*; do
      target=$out/packages/$(basename "$member")/node_modules
      cp -a "$member/node_modules" "$target"
      chmod -R u+w "$target"
    done
  '';

  # `nix` is deliberately NOT pinned on
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
    # ODU_WEB_DIST IS NOT. It is --set, and the difference between it and
    # ODU_GH_BIN is the difference between a tool odu CALLS and a part of what
    # odu IS.
    #
    # `gh` is somebody else's program, invoked at an edge, spending the caller's
    # own credential; naming a different one changes which external service the
    # call reaches, not what this package is. The browser bundle is the
    # application's own front end. Served under this wrapper's ODU_BUILD_ID, an
    # ambient dist means two people can dial the same daemon, read the same
    # build id off `service.build`, and be looking at different applications —
    # and the id is what `ensureService` compares to decide a running daemon is
    # the same build and may be adopted. An identity that can be true of two
    # different programs is not an identity.
    #
    # It was --set-default for a developer iterating on the browser. That
    # workflow is `just run`, which rebuilds and runs the package — the same
    # honest cost the justfile already documents for deleting `bun run start`.
    # Iterating against a build whose page is not the build's page is exercising
    # an application no user has, which is the whole thing this wrapper exists
    # to stop.
    #
    # ODU_BUILD_ID IS THIS DERIVATION, AND IT IS UNCONDITIONAL.
    #
    # Two things were wrong with baking `base.outPath` under `selfRev != null`.
    #
    # It named the wrong thing. `base` is the hydrated SOURCE tree; the binary a
    # user actually runs is composed outside it — this wrapper, the web-ui
    # bundle, the pinned bun/git/gh/just/openssh, the agent source the lane
    # runner is resolved from. Bumping `pkgs.gh` or changing that source
    # produced a materially different application with an IDENTICAL build id,
    # and `ensureService` uses that id to decide whether an explicit upgrade is
    # needed. `$out` is the out-path of the complete package, so it covers every
    # input of the thing that runs — which is what an identity has to do.
    #
    # And it was gated on a navigable commit, which is a DIFFERENT fact. A dirty
    # local tree still produces a complete, hash-identified Nix package; calling
    # it "off-nix" and refusing it an identity made the singleton's compatible
    # -reuse branch permanently dead on every developer machine. So identity is
    # unconditional and provenance stays optional beside it.
    #
    # This deviates from `@kolu/surface-daemon`'s `readBakedIdentity`, which
    # requires the pair or neither on the premise that "a Nix build id means the
    # source commit was knowable". That premise does not hold for a dirty build,
    # so odu reads the two env vars itself (see `bakedBuild`) rather than
    # adopting a rule that would erase the identity of a real package.
    #
    # The full store path, not its basename: `ServiceBuild.self` already carries
    # `$out/bin/odu`, so the basename is derivable from what is already on the
    # wire, and the full path is the thing an operator can hand to
    # `nix path-info` when a mismatch has to be explained.
    makeWrapper ${pkgs.bun}/bin/bun $out/bin/odu \
      --add-flags "${base}/src/main.ts" \
      --set-default ODU_GH_BIN "${pkgs.gh}/bin/gh" \
      --set ODU_SELF "$out/bin/odu" \
      --set ODU_WEB_DIST "${web-ui}" \
      --set ODU_BUILD_ID "$out" \
      --set ODU_OSFACTS_BIN "${pkgs.osfacts}/bin/osfacts" \
      ${pkgs.lib.optionalString (selfRev != null) ''--set ODU_COMMIT_HASH "${selfRev}"''} \
      ${pkgs.lib.optionalString (agentSource != null) ''--set ${agentFlakeRefEnv} "${agentSource}"''} \
      --prefix PATH : ${pkgs.lib.makeBinPath [
        pkgs.bun
        pkgs.git
        pkgs.gh
        pkgs.just
        pkgs.openssh
        pkgs.bash
        pkgs.coreutils
        # The cache compresses a NAR on the way out, decompresses what a client
        # uploaded, and the push client compresses on the way in. `nix` itself
        # is deliberately NOT here (the host that provides the daemon provides
        # the client); the compressors are odu's own work, so odu brings them —
        # `xz` and `bzip2` because that is what `nix copy --to` still sends.
        pkgs.zstd
        pkgs.xz
        pkgs.bzip2
      ]}
  '';
in
{
  inherit odu odu-runner base odu-deps web-ui;
  agent-flake-source = agentSource;
}
