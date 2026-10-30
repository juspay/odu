# Factory: narrow the npins-pinned olai source to a single workspace package.
# The twin of kolu-package.nix, and for the same reason: `@olai/effect-cordis`
# lives upstream in juspay/olai and odu consumes it the way it consumes the
# @kolu/* surface libraries — as source from a pin, never a registry install.
{ pkgs }:
name: pkgs.runCommand "olai-${name}"
{
  meta = {
    description = "@olai/${name} source extracted from juspay/olai";
    homepage = "https://github.com/juspay/olai";
  };
}
  ''
    cp -r ${(import ../../npins).olai}/packages/${name} $out
  ''
