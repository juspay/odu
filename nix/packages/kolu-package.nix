{ pkgs }:
name: pkgs.runCommand "kolu-${name}"
{
  meta = {
    description = "@kolu/${name} source extracted from juspay/kolu";
    homepage = "https://github.com/juspay/kolu";
  };
}
  ''
    cp -r ${(import ../../npins).kolu}/packages/${name} $out
  ''
