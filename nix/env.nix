# Env vars whose values are Nix-store paths — consumed by the dev shell
# and the build derivation, hydrated into node_modules/@kolu/* (and
# @olai/*, and cordis) by scripts/hydrate-kolu-packages.sh.
{ pkgs }:
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
  # The plugin runtime the daemon composes its rows with, and the four cordis
  # packages behind its root door. `ODU_CORDIS_HYDRATE` is not a path but a
  # STRING OF (src, dest) PAIRS — four upstream packages are one hydration
  # step, and spelling them once here is what keeps the dev shell and the build
  # derivation from drifting on which ones.
  ODU_OLAI_EFFECT_CORDIS = pkgs.olai-effect-cordis;
  ODU_CORDIS_HYDRATE = pkgs.cordis.hydrateArgs;
  ODU_CORDIS_REVISION = pkgs.cordis.revision;
}
