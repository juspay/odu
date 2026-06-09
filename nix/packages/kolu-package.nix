# Factory: narrow the npins-pinned kolu source to a single workspace
# package. No vendoring — the @kolu/* surface libraries live upstream in
# juspay/kolu; odu consumes them the way srid/drishti does.
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
