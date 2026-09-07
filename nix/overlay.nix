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

  # THE BINARY THE CLIENT ABOVE IS A FACE FOR.
  #
  # odu hydrated `osfacts-client` and then never gave it a binary to spawn, so
  # the singleton gate's start-time reader was hand-rolled instead — `/proc`
  # field-22 arithmetic against a hardcoded `USER_HZ = 100` on Linux, and a
  # `Date.parse` of locale-formatted `ps -o lstart=` on macOS. The stated reason
  # was that shipping osfacts would need a flake input odu's policy forbids.
  # That was simply wrong: the same pin the client is grafted from ALSO carries
  # the Rust package, its `default.nix` takes `{ pkgs }`, and this is what
  # composing it costs.
  #
  # `doCheck = false` because odu is not the place to run osfacts' own test
  # suite. The pin's `checkPhase` is a cargo-nextest gate that belongs to
  # osfacts' CI; running it here would put it on the critical path of every cold
  # `nix build .#odu` — including a consumer's first `nix run github:juspay/odu`
  # — to re-prove something upstream already proved at this exact revision.
  osfacts = ((import (import ../npins).osfacts { pkgs = final; }).overrideAttrs
    (_: { doCheck = false; }));
}
