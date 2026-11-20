final: _prev:
let
  mkKoluPackage = import ./packages/kolu-package.nix { pkgs = final; };
  mkOlaiPackage = import ./packages/olai-package.nix { pkgs = final; };
  cordis = import ./packages/cordis.nix { pkgs = final; };
in
{
  olai-effect-cordis = mkOlaiPackage "effect-cordis";
  cordis = cordis;

  kolu-surface = mkKoluPackage "surface";
  kolu-surface-mcp = mkKoluPackage "surface-mcp";
  kolu-surface-app = mkKoluPackage "surface-app";
  kolu-surface-cli = mkKoluPackage "surface-cli";
  kolu-url-shape = mkKoluPackage "url-shape";
  kolu-surface-remote = mkKoluPackage "surface-remote";
  kolu-shell-quote = mkKoluPackage "shell-quote";
  kolu-byte-units = mkKoluPackage "byte-units";
  kolu-surface-map = mkKoluPackage "surface-map";
  kolu-log = mkKoluPackage "log";
  kolu-surface-daemon-supervisor = mkKoluPackage "surface-daemon-supervisor";
  kolu-surface-daemon = mkKoluPackage "surface-daemon";
  osfacts-client = final.runCommand "osfacts-client"
    {
      meta = {
        description = "osfacts-client source extracted from juspay/osfacts";
        homepage = "https://github.com/juspay/osfacts";
      };
    }
    ''
      cp -r ${(import ../npins).osfacts}/client-ts $out
    '';

  osfacts = ((import (import ../npins).osfacts { pkgs = final; }).overrideAttrs
    (_: { doCheck = false; }));

  odu-geist-fonts = final.runCommand "odu-geist-fonts"
    {
      nativeBuildInputs = [ final.woff2 ];
      meta.description = "Geist and Geist Mono, variable, as woff2";
    }
    ''
      mkdir -p "$out"
      # Quoted: the names really do contain brackets, and an unquoted path
      # would be read as a glob and silently match nothing.
      cp "${final.geist-font}/share/fonts/truetype/Geist[wght].ttf" "$out/Geist.ttf"
      cp "${final.geist-font}/share/fonts/truetype/GeistMono[wght].ttf" "$out/GeistMono.ttf"
      woff2_compress "$out/Geist.ttf"
      woff2_compress "$out/GeistMono.ttf"
      rm "$out/Geist.ttf" "$out/GeistMono.ttf"
      test -s "$out/Geist.woff2" && test -s "$out/GeistMono.woff2"
    '';
}
