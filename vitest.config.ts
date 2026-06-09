import { defineConfig } from "vitest/config";

// odu is a Node CLI (no Solid / DOM). The @kolu/* packages are hydrated
// into node_modules as raw TypeScript (scripts/hydrate-kolu-packages.sh),
// so vite-node must transform them rather than treat them as prebuilt.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    server: { deps: { inline: [/@kolu\//] } },
  },
});
