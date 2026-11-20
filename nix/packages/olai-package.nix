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
