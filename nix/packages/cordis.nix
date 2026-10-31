# CORDIS, HYDRATED AS SOURCE — four packages from one pin, rewritten from a
# `lib/` emit odu does not run into the `src/` tree it does.
#
# `@olai/effect-cordis` (nix/packages/olai-package.nix) is the plugin runtime
# the daemon composes its rows with. It names `cordis` and nothing else, and
# `cordis` is not on npm: it is a workspace of four packages — `packages/core`
# is `cordis`, `packages/loader` is `@cordisjs/plugin-loader`,
# `packages/include` is `@cordisjs/plugin-include`, `packages/group` is
# `@cordisjs/plugin-group` — grafted here from the npins `cordis` pin the same
# way every `@kolu/*` member is. There is no vendor/ copy and no sync script:
# bumping the pin is editing npins/sources.json.
#
# THIS FILE IS PORTED FROM THE SOURCE THAT OWNS IT (juspay/olai's
# nix/cordis.nix), and the rewrite is the part that matters. Upstream's
# manifests point at `lib/`, a `tsc` emit neither tree runs, so every string in
# `exports` that names `./lib/<x>.js` or `./lib/<x>.d.ts` becomes `./src/<x>.ts`
# and `main`/`types`/`typings` follow. The rewrite WALKS the map rather than
# patching `exports["."]`, because a subpath nested inside a condition object is
# reached without this filter knowing the shape of any particular manifest — and
# a package with no `exports` at all (include and group) is GIVEN one, so
# `import "@cordisjs/plugin-include"` resolves the way the other two do.
#
# The `@ts-nocheck` stamp stays. Cordis's own strictness is not odu's: each
# package turns options back off for itself (`noImplicitAny`,
# `noImplicitThis`, `strictFunctionTypes`), and odu's tsconfig turns on two
# upstream never sets (`noUncheckedIndexedAccess`, `noImplicitOverride`).
# Compiled under Cordis's own flags the pin is clean; under odu's it is ~35
# errors, every one an instance of those flags and none of them a bug in
# Cordis. So the stamp hides Cordis's AUTHORING, not its shape: the pin's
# exported TYPES are still computed and every call odu makes is still checked
# against them.
#
# cosmokit, `@standard-schema/spec` and js-yaml stay on npm and are declared in
# the root manifest at the versions the pin names — the same arrangement
# `@odu/run-client` has with `effect`, and the reason is bunfig.toml's
# isolated-linker invariant: a hydrated package resolves its externals by
# walking up into odu's one root node_modules.
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

  # ONE PACKAGE, because odu opens ONE DOOR. `@olai/effect-cordis`'s root door
  # imports `cordis` and nothing else — the loader, the include tree and the
  # group builtin are behind its `./loader` door, which odu does not open (rows
  # are fixed at boot, never read from a file).
  #
  # The pin's three siblings are still there in the source; they are simply not
  # hydrated, so nothing in this tree can reach them by accident either.
  core = asTypescript "cordis-core-src" "${npins.cordis}/packages/core";
in
{
  # One (src, dest) pair, in the shape `hydrate-kolu-packages.sh` takes.
  hydrateArgs = "${core} cordis";

  # The pin's own runtime dependencies, for a check that wants to hold them:
  # whatever the CORE imports, because the core is the only package hydrated.
  #
  # Peers are deliberately NOT folded in: every peer the core declares is one of
  # the packages behind `./loader`, which odu does not open, plus
  # `node-addon-require-builtin` — optional, and none of them is an npm external
  # the root could declare without inventing a second copy of a pin.
  externals = (manifestOf "core").dependencies;

  revision = npins.cordis.revision;
}
