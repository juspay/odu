{ pkgs }:

let
  npins = import ../../npins;

  tsconfigFor = builtins.toJSON {
    compilerOptions = {
      rootDir = "src";
      outDir = "lib";
      declaration = true;
      emitDeclarationOnly = true;
      target = "es2024";
      module = "esnext";
      moduleResolution = "bundler";
      skipLibCheck = true;
      strict = true;
      noImplicitAny = false;
      noImplicitThis = false;
      strictFunctionTypes = false;
      types = [ "node" ];
    };
    include = [ "src" ];
  };

  core = pkgs.runCommand "cordis-core-src" { } ''
    cp -r ${npins.cordis}/packages/core $out
    chmod -R u+w $out
    printf '%s' ${pkgs.lib.escapeShellArg tsconfigFor} > $out/tsconfig.json
  '';
in
{
  hydratePairs = [{ src = core; dest = "cordis"; }];

  revision = npins.cordis.revision;
}
