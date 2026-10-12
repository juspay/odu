{
  name = "odu";
  description = "odu maintainers: the published odu plugin, plus maintainer-only guidance";
  # The published plugin, exactly as consumers load it, and the maintainer-only
  # plugin that never ships with it.
  plugins = [ ./agent-plugin ./dev ];
}
