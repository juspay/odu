# Exposes kolu workspace packages as Nix-store sources. A new @kolu/*
# consumer is a one-line addition.
final: _prev:
let
  mkKoluPackage = import ./packages/kolu-package.nix { pkgs = final; };
in
{
  kolu-surface = mkKoluPackage "surface";
  kolu-surface-mcp = mkKoluPackage "surface-mcp";
  # PR 2's three faces. `surface-app` is the browser shell and the one HTTP/WS
  # listener the web service binds; `surface-cli` projects the same surface as
  # argv (`odu surface …`); `url-shape` is `surface-app`'s own dependency (the
  # IPv6-safe authority spelling behind the bound URL it reports).
  kolu-surface-app = mkKoluPackage "surface-app";
  kolu-surface-cli = mkKoluPackage "surface-cli";
  kolu-url-shape = mkKoluPackage "url-shape";
  kolu-surface-remote = mkKoluPackage "surface-remote";
  # `surface-remote` imports `@kolu/shell-quote` (its ssh-command construction),
  # `@kolu/surface-map` (`serveHostMap`'s host-topology surface), and `@kolu/log`
  # (the session's structured logger type) — so the consumer must hydrate those
  # transitive sources too. TypeScript resolves the import from the hydrated
  # package's real location.
  kolu-shell-quote = mkKoluPackage "shell-quote";
  kolu-surface-map = mkKoluPackage "surface-map";
  kolu-log = mkKoluPackage "log";
  # The survivable-spawn spine. `surface-daemon-supervisor` owns the mechanism a
  # coordinator is launched with; its `.` entry reaches the daemon-endpoint half
  # (`@kolu/surface-daemon`) and the OS-facts reader behind that. Both come along
  # because hydration is per-PACKAGE: what a consumer pays is the closure of the
  # manifests, not of the modules its own code happens to touch.
  kolu-surface-daemon-supervisor = mkKoluPackage "surface-daemon-supervisor";
  kolu-surface-daemon = mkKoluPackage "surface-daemon";
  # `osfacts-client` is the odd one out, and deliberately so: it is NOT a kolu
  # workspace directory. kolu gitignores it and grafts it at build time from its
  # own `osfacts` pin, so no revision of juspay/kolu contains it and no pin bump
  # could supply it. odu performs the same graft from the same upstream, which is
  # why there is a second pin in npins/sources.json at all.
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
}
