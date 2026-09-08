/**
 * Build the browser bundle the web service serves.
 *
 * ONE call, plus ONE plugin. `buildSurfaceClient` (`@kolu/surface-app/bun`) owns
 * the whole freshness contract the server half is built to serve: content-hashed
 * assets under `/assets/`, the build commit published on the `no-store` shell
 * (never defined into a hashed file — a stamp-only rebuild would change an
 * immutable file's bytes without changing its URL and strand every returning
 * browser), `modulepreload` links for the chunks the entry statically imports,
 * and precompressed `br`/`zstd`/`gzip` siblings for the layer that negotiates
 * them.
 *
 * The plugin is Solid's compiler, and it is not optional. `packages/web-ui` is
 * written in Solid JSX — the conventional way to write a Solid app — and Solid's
 * JSX is a COMPILE TARGET rather than a call convention: `babel-preset-solid`
 * turns each element into a cloned `<template>` plus one effect per dynamic
 * binding, which is where the fine-grained updates come from. Bun's own built-in
 * JSX transform would happily consume the same files and emit `jsx(Component,
 * props)` calls instead: it type-checks, it bundles, it renders a page that
 * looks right, and every component re-runs on every update with its signals
 * re-created underneath it. That failure is invisible in a screenshot, so the
 * defence is structural — the loader below claims every `.tsx` file, so no
 * `.tsx` in this app can reach Bun's transform by accident.
 *
 * Usage:  bun scripts/build-web-ui.ts [<distDir>]
 */

import { buildSurfaceClient } from "@kolu/surface-app/bun";
import { transformAsync } from "@babel/core";
import solid from "babel-preset-solid";
import typescript from "@babel/preset-typescript";
import type { BunPlugin } from "bun";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const clientDir = join(repoRoot, "packages", "web-ui", "src");
const distDir = resolve(process.argv[2] ?? join(repoRoot, "packages", "web-ui", "dist"));

/**
 * Solid's JSX compiler, as a `Bun.build` loader.
 *
 * `@babel/preset-typescript` first and `babel-preset-solid` second: the TS
 * preset strips the annotations while LEAVING the JSX alone (`isTSX`), and the
 * Solid preset is what turns that JSX into templates and effects. Both are
 * pinned exactly in the root manifest — this is the compiler that decides
 * whether the shipped page is fine-grained, and a patch release of it is not a
 * thing to discover in production.
 *
 * `babelrc`/`configFile` are off: the compile a developer gets and the compile
 * the Nix derivation gets must be the same one, and a `.babelrc` anywhere above
 * this tree would silently make them differ.
 */
const solidJsx: BunPlugin = {
  name: "solid-jsx",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
      const source = await readFile(args.path, "utf-8");
      const out = await transformAsync(source, {
        filename: args.path,
        babelrc: false,
        configFile: false,
        // Inline, so Bun's own `linked` sourcemap for the bundle points back at
        // the `.tsx` a person wrote rather than at babel's output.
        sourceMaps: "inline",
        presets: [
          [typescript, { isTSX: true, allExtensions: true }],
          [solid, {}],
        ],
      });
      if (out?.code == null) {
        // A silent pass-through here is the exact failure this plugin exists to
        // prevent, so it is a hard stop rather than a fallback.
        throw new Error(`build-web-ui: the Solid compiler produced nothing for ${args.path}`);
      }
      return { contents: out.code, loader: "js" };
    });
  },
};

const report = await buildSurfaceClient({
  entrypoint: join(clientDir, "main.tsx"),
  distDir,
  htmlTemplate: join(clientDir, "index.html"),
  plugins: [solidJsx],
  // The exact substring the shell uses in dev. It MUST be present: a
  // `replaceAll` that matched nothing would build "successfully" and ship a
  // shell still pointing at a `.tsx` file no browser can load, which is exactly
  // the staleness the contract exists to make impossible.
  entryHtmlPlaceholder: 'src="./main.tsx"',
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
    {
      name: "logo",
      ext: "svg",
      // The REPO's logo, read from the root rather than copied in beside the
      // bundle. `website/public/logo.svg` is already a second copy of that file
      // and they are byte-identical today; a third would be a third thing to
      // keep true, in the one asset whose whole job is to look the same
      // everywhere odu appears.
      build: () => readFile(join(repoRoot, "logo.svg")),
      htmlPlaceholder: 'href="./logo.svg"',
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
