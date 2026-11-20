/**
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
 */

import { buildSurfaceClient, type SurfaceClientExtraAsset } from "@kolu/surface-app/bun";
import { compileSolidAsync } from "./solidJsx";
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const clientDir = join(repoRoot, "packages", "web-ui", "src");
const faceDir = join(repoRoot, "packages", "face", "src");
const distDir = resolve(process.argv[2] ?? join(repoRoot, "packages", "web-ui", "dist"));
const ENTRY = "main.tsx";

const fontDir = process.env.ODU_GEIST_FONTS;
if (fontDir === undefined || fontDir.trim() === "") {
  throw new Error(
    "build-web-ui: $ODU_GEIST_FONTS is unset — the bundle carries Geist and " +
      "Geist Mono, and they come from nixpkgs' `geist-font`. Build inside " +
      "`nix develop` (or through `.#web-ui`), which sets it.",
  );
}

const ASSET_PREFIX = "/assets/";
const assetHref = (name: string, ext: string, bytes: Uint8Array): string =>
  `${ASSET_PREFIX}${name}-${Bun.hash(bytes).toString(16).slice(0, 8)}.${ext}`;

const fontHrefs = new Map<string, string>();

const font = (name: string, file: string): SurfaceClientExtraAsset => ({
  name,
  ext: "woff2",
  build: async (): Promise<Uint8Array> => {
    const bytes = new Uint8Array(await readFile(join(fontDir, file)));
    fontHrefs.set(name, assetHref(name, "woff2", bytes));
    return bytes;
  },
  htmlPlaceholder: `href="./${name}.woff2"`,
});

async function rowSheets(): Promise<string[]> {
  const packagesDir = join(repoRoot, "packages");
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name === "face.css") found.push(path);
    }
  };
  for (const pkg of await readdir(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(packagesDir, pkg.name, "src");
    if (!existsSync(src)) continue;
    await walk(src);
  }
  return found.sort();
}

type Sheet = { readonly file: string; readonly text: string };

async function orderedSheets(): Promise<Sheet[]> {
  const read = async (file: string): Promise<Sheet> => ({
    file,
    text: await readFile(file, "utf-8"),
  });
  const theme = await read(join(faceDir, "theme.css"));
  return [theme, ...(await Promise.all((await rowSheets()).map(read)))];
}

/**
 * A SHEET WHOSE COMMENTS END WHERE THEY SAY THEY DO.
 *
 * CSS comments do not nest and have no escape, so one asterisk followed by a
 * slash inside a paragraph of prose — a glob written out, say — closes the
 * comment early and leaves the rest of it as garbage declarations. The parser
 * recovers by eating the NEXT rule, which in a stylesheet this size is one
 * whole `@layer` block silently gone: every rule in it missing, nothing
 * logged, and a page that still looks like a page.
 */
function commentsClose(css: string): boolean {
  return !css.replace(/\/\*[\s\S]*?\*\//g, "").includes("*" + "/");
}

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
      return { contents: await compileSolidAsync(source, args.path), loader: "js" };
    });
  },
};

const report = await buildSurfaceClient({
  entrypoint: join(clientDir, ENTRY),
  distDir,
  htmlTemplate: join(clientDir, "index.html"),
  plugins: [solidJsx],
  entryHtmlPlaceholder: `src="./${ENTRY}"`,
  extraAssets: [
    // THE FONTS FIRST, because the stylesheet below reads the hrefs their
    // `build()` records. `extraAssets` is walked in order, so this is an
    // ordering the builder guarantees rather than one this file hopes for.
    font("geist-sans", "Geist.woff2"),
    font("geist-mono", "GeistMono.woff2"),
    {
      name: "styles",
      ext: "css",
      build: async (): Promise<Uint8Array> => {
        const sheets = await orderedSheets();
        let css = sheets
          .map(({ file, text }) => {
            if (!commentsClose(text)) {
              throw new Error(
                `build-web-ui: ${relative(repoRoot, file)} has a comment that ` +
                  "closes early — the rule after it would be eaten by the " +
                  "parser and the whole block would go missing silently.",
              );
            }
            return `/* ── ${relative(repoRoot, file)} ── */\n${text}`;
          })
          .join("\n");
        for (const [name, href] of fontHrefs) {
          const placeholder = `url("./${name}.woff2")`;
          if (!css.includes(placeholder)) {
            throw new Error(
              `build-web-ui: theme.css does not contain ${placeholder} — the ` +
                `hashed ${name} would never be referenced and the board would ` +
                "render in a fallback typeface.",
            );
          }
          css = css.replaceAll(placeholder, `url("${href}")`);
        }
        process.stdout.write(
          `  stylesheet: ${sheets.map(({ file }) => relative(repoRoot, file)).join(", ")}\n`,
        );
        return new TextEncoder().encode(css);
      },
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

// THE PREDICTION, CHECKED. See `assetHref`: the stylesheet was written with
// hrefs this file computed, and these are the hrefs the builder emitted. They
// are equal or this build is wrong, and a wrong one here ships a page in the
// wrong typeface rather than failing — so it fails.
if (report.assetPrefix !== ASSET_PREFIX) {
  throw new Error(
    `build-web-ui: assets are served from ${report.assetPrefix}, not ` +
      `${ASSET_PREFIX} — the font urls baked into the stylesheet are wrong.`,
  );
}
for (const [name, predicted] of fontHrefs) {
  const emitted = report.assetHrefs[name];
  if (emitted !== predicted) {
    throw new Error(
      `build-web-ui: the stylesheet names ${name} at ${predicted} but the ` +
        `build emitted it at ${String(emitted)}. kolu's asset naming moved; ` +
        "update `assetHref` in this file to match it.",
    );
  }
}

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
