{ pkgs }:

let
  npins = import ../../npins;

  asTypescript = name: src:
    pkgs.runCommand name { nativeBuildInputs = [ pkgs.jq ]; } ''
      cp -r ${src} $out
      chmod -R u+w $out
      jq '
        def to_src:
          if type == "string" then
            (if test("^\\./lib/.*\\.d\\.ts$") then
               sub("^\\./lib/"; "./src/") | sub("\\.d\\.ts$"; ".ts")
             elif test("^\\./lib/.*\\.js$") then
               sub("^\\./lib/"; "./src/") | sub("\\.js$"; ".ts")
             else . end)
          else . end;
        .main = "./src/index.ts"
        | .types = "./src/index.ts"
        | (if has("typings") then .typings = "./src/index.ts" else . end)
        | .exports = ((.exports // {}) | walk(to_src))
        | .exports["."] = "./src/index.ts"
        | .exports["./package.json"] = "./package.json"
        | .private = true
      ' "$out/package.json" > "$out/package.json.tmp"
      mv "$out/package.json.tmp" "$out/package.json"
      find "$out" -name '*.ts' -print | while IFS= read -r f; do
        first=$(head -n 1 "$f")
        if [ "$first" != "// @ts-nocheck" ]; then
          printf '%s\n%s\n' "// @ts-nocheck" "$(cat "$f")" > "$f"
        fi
      done
    '';

  manifestOf = dir:
    builtins.fromJSON (builtins.readFile "${npins.cordis}/packages/${dir}/package.json");

  core = asTypescript "cordis-core-src" "${npins.cordis}/packages/core";
in
{
  hydratePairs = [{ src = core; dest = "cordis"; }];

  externals = (manifestOf "core").dependencies;

  revision = npins.cordis.revision;
}
