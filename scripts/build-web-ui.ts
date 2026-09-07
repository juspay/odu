/**
 * Build the browser bundle the web service serves.
 *
 * ONE call. `buildSurfaceClient` (`@kolu/surface-app/bun`) owns the whole
 * freshness contract the server half is built to serve: content-hashed assets
 * under `/assets/`, the build commit published on the `no-store` shell (never
 * defined into a hashed file — a stamp-only rebuild would change an immutable
 * file's bytes without changing its URL and strand every returning browser),
 * `modulepreload` links for the chunks the entry statically imports, and
 * precompressed `br`/`zstd`/`gzip` siblings for the layer that negotiates them.
 *
 * There is no bundler config and no plugin, because there is no JSX transform:
 * `packages/web-ui` is written with Solid's own hyperscript, so the whole build
 * is `Bun.build` over raw TypeScript. That is the reason this file is nine
 * lines of options rather than a `vite.config.ts` and two more dependencies.
 *
 * Usage:  bun scripts/build-web-ui.ts [<distDir>]
 */

import { buildSurfaceClient } from "@kolu/surface-app/bun";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const clientDir = join(repoRoot, "packages", "web-ui", "src");
const distDir = resolve(process.argv[2] ?? join(repoRoot, "packages", "web-ui", "dist"));

const report = await buildSurfaceClient({
  entrypoint: join(clientDir, "main.ts"),
  distDir,
  htmlTemplate: join(clientDir, "index.html"),
  // The exact substring the shell uses in dev. It MUST be present: a
  // `replaceAll` that matched nothing would build "successfully" and ship a
  // shell still pointing at a `.ts` file no browser can load, which is exactly
  // the staleness the contract exists to make impossible.
  entryHtmlPlaceholder: 'src="./main.ts"',
  extraAssets: [
    {
      name: "styles",
      ext: "css",
      // Plain CSS, read as bytes. No preprocessor: the stylesheet is 300 lines
      // of custom properties and a grid, and a toolchain for that would cost
      // more than it saves.
      build: () => readFile(join(clientDir, "styles.css")),
      htmlPlaceholder: 'href="./styles.css"',
    },
  ],
  // Read from the env the Nix wrapper bakes, so the commit the shell reports
  // and the commit the service reports are one value. Falls back to
  // `git rev-parse` and then to "dev", which `clientIsStale` treats as
  // never-stale — a dev build must not prompt itself to reload forever.
  commitEnvVar: "ODU_COMMIT_HASH",
});

process.stdout.write(
  `odu web-ui → ${distDir}\n  entry ${report.jsHref}\n  styles ${report.assetHrefs.styles}\n`,
);
for (const asset of report.assets) {
  const best = Math.min(
    ...[asset.siblings.br, asset.siblings.zstd, asset.siblings.gzip].filter(
      (n): n is number => typeof n === "number",
    ),
  );
  process.stdout.write(
    `  ${asset.file} ${asset.bytes}B${Number.isFinite(best) ? ` → ${best}B on the wire` : ""}\n`,
  );
}
