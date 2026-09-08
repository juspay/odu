import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://juspay.github.io",
  base: "/odu",
  trailingSlash: "always",
  vite: {
    server: { allowedHosts: true },
    preview: { allowedHosts: true },
  },
});
