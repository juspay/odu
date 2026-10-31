import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://odu.kolu.dev",
  trailingSlash: "always",
  vite: {
    server: { allowedHosts: true },
    preview: { allowedHosts: true },
  },
});
