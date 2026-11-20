{ pkgs }:
let
  renderHydratePairs = import ./hydrate-pairs.nix { inherit (pkgs) lib; };
in
{
  ODU_KOLU_SURFACE = pkgs.kolu-surface;
  ODU_KOLU_SURFACE_MCP = pkgs.kolu-surface-mcp;
  ODU_KOLU_SURFACE_APP = pkgs.kolu-surface-app;
  ODU_KOLU_SURFACE_CLI = pkgs.kolu-surface-cli;
  ODU_KOLU_URL_SHAPE = pkgs.kolu-url-shape;
  ODU_KOLU_SURFACE_REMOTE = pkgs.kolu-surface-remote;
  ODU_KOLU_SHELL_QUOTE = pkgs.kolu-shell-quote;
  ODU_KOLU_BYTE_UNITS = pkgs.kolu-byte-units;
  ODU_KOLU_SURFACE_MAP = pkgs.kolu-surface-map;
  ODU_KOLU_LOG = pkgs.kolu-log;
  ODU_KOLU_SURFACE_DAEMON_SUPERVISOR = pkgs.kolu-surface-daemon-supervisor;
  ODU_KOLU_SURFACE_DAEMON = pkgs.kolu-surface-daemon;
  ODU_OSFACTS_CLIENT = pkgs.osfacts-client;
  ODU_OLAI_EFFECT_CORDIS = pkgs.olai-effect-cordis;
  ODU_CORDIS_HYDRATE = renderHydratePairs pkgs.cordis.hydratePairs;
  ODU_CORDIS_REVISION = pkgs.cordis.revision;
  ODU_GEIST_FONTS = pkgs.odu-geist-fonts;
}
