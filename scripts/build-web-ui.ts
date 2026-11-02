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

import { buildSurfaceClient, type SurfaceClientExtraAsset } from "@kolu/surface-app/bun";
import { transformAsync } from "@babel/core";
import solid from "babel-preset-solid";
import typescript from "@babel/preset-typescript";
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const clientDir = join(repoRoot, "packages", "web-ui", "src");
/** `@odu/face`'s design system: the stylesheet every row's face draws with,
 *  and the two typefaces it names. Read from the package that owns them. */
const faceDir = join(repoRoot, "packages", "face", "src");
const distDir = resolve(process.argv[2] ?? join(repoRoot, "packages", "web-ui", "dist"));

/**
 * THE TYPEFACES, FROM NIXPKGS — never from a font CDN.
 *
 * A tailnet-only or air-gapped board must render the same page as a public
 * one, so the two Geist variable fonts travel with the bundle. The directory
 * is `nix/env.nix`'s `ODU_GEIST_FONTS`, which both the dev shell and the
 * `web-ui` derivation set — and it is REQUIRED rather than defaulted: a build
 * that silently fell back to whatever the machine has installed would produce
 * a bundle that looks right where it was built and wrong everywhere else.
 */
const fontDir = process.env.ODU_GEIST_FONTS;
if (fontDir === undefined || fontDir.trim() === "") {
  throw new Error(
    "build-web-ui: $ODU_GEIST_FONTS is unset — the bundle carries Geist and " +
      "Geist Mono, and they come from nixpkgs' `geist-font`. Build inside " +
      "`nix develop` (or through `.#web-ui`), which sets it.",
  );
}

/**
 * WHERE AN EXTRA ASSET LANDS, predicted — and then checked.
 *
 * The stylesheet names the two fonts, so it has to know their HASHED urls,
 * and `buildSurfaceClient` computes those AFTER each asset's `build()`
 * returns. There is no hook in between, so this restates its naming rule —
 * `<prefix><name>-<8 hex of Bun.hash>.<ext>` — and then asserts, once the
 * build is done, that every prediction equals what the builder actually
 * emitted. A restated rule that cannot silently rot: the day kolu changes how
 * it hashes, this build fails with the two hrefs side by side rather than
 * shipping a stylesheet pointing at a font nobody serves.
 */
const ASSET_PREFIX = "/assets/";
const assetHref = (name: string, ext: string, bytes: Uint8Array): string =>
  `${ASSET_PREFIX}${name}-${Bun.hash(bytes).toString(16).slice(0, 8)}.${ext}`;

/** Filled by each font's `build()` and read by the stylesheet's, which runs
 *  after them because `extraAssets` is walked in order. */
const fontHrefs = new Map<string, string>();

/** One variable font, hashed beside the bundle. woff2 rather than the ttf
 *  nixpkgs ships, because the asset pipeline precompresses TEXT siblings and
 *  a `.ttf` would go over the wire raw — 320 KB of font on a cold load.
 *  `nix/overlay.nix`'s `odu-geist-fonts` does the conversion, and a woff2 IS
 *  a brotli-compressed TrueType. One file per family covers every weight the
 *  page draws. */
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

/**
 * EVERY ROW'S OWN STYLESHEET, found rather than listed.
 *
 * A row's screens are drawn by the row's face and dressed by the row's
 * `face.css`, beside it. This walks `packages/*​/src` for files with that name
 * and answers them in path order, so the assembled sheet is byte-identical on
 * every machine and a row that grows a stylesheet is shipped by adding one
 * file — no list here, no row named in a script that is not a root.
 */
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

/**
 * A SHEET WHOSE COMMENTS END WHERE THEY SAY THEY DO.
 *
 * CSS comments do not nest and have no escape, so one asterisk followed by a
 * slash inside a paragraph of prose — a glob written out, say — closes the
 * comment early and leaves the rest of it as garbage declarations. The parser
 * recovers by eating the NEXT rule, which in a stylesheet this size is one
 * whole `@layer` block silently gone: every rule in it missing, nothing
 * logged, and a page that still looks like a page.
 *
 * That is exactly what happened once here, so it is checked rather than
 * remembered. Strip every well-formed comment; anything still carrying a
 * close marker was a comment that closed early.
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
    // THE FONTS FIRST, because the stylesheet below reads the hrefs their
    // `build()` records. `extraAssets` is walked in order, so this is an
    // ordering the builder guarantees rather than one this file hopes for.
    font("geist-sans", "Geist.woff2"),
    font("geist-mono", "GeistMono.woff2"),
    {
      name: "styles",
      ext: "css",
      // ONE STYLESHEET, ASSEMBLED FROM THE PACKAGES THAT OWN ITS PARTS.
      //
      // `@odu/face`'s `theme.css` first — the tokens, the base, the
      // primitives `./ui` renders and the page shell every screen sits in —
      // then every row's own `face.css`, which carries what only that row's
      // screens have. A shared sheet that knew `.node-track` would change
      // every time the runs' views did; a row's look belongs in the row,
      // beside the view that emits the class names.
      //
      // FOUND, not listed. This globs `packages/*/src/**/face.css` in path
      // order rather than naming the rows: a build script is not one of the
      // four roots the fence lets name them, and a list here would be a fifth
      // place to remember a row exists. A row ships a sheet by adding a file.
      //
      // ORDER is why every row's sheet names its `@layer`: `theme.css`
      // declares the four up front, so a later `@layer layout { … }` appends
      // to that layer instead of out-shouting it, and the order rows are
      // concatenated in cannot decide which rule wins.
      //
      // The two font `url()`s are BUILD PLACEHOLDERS, rewritten here to the
      // hashed hrefs. A miss is a hard stop: a stylesheet shipped still
      // naming `./geist-sans.woff2` would quietly render the whole board in a
      // fallback face, which is the kind of failure a screenshot does not
      // catch because it still looks like a page.
      build: async (): Promise<Uint8Array> => {
        const sheets = [join(faceDir, "theme.css"), ...(await rowSheets())];
        let css = (
          await Promise.all(
            sheets.map(async (file) => {
              const text = await readFile(file, "utf-8");
              if (!commentsClose(text)) {
                throw new Error(
                  `build-web-ui: ${relative(repoRoot, file)} has a comment that ` +
                    "closes early — the rule after it would be eaten by the " +
                    "parser and the whole block would go missing silently.",
                );
              }
              return `/* ── ${relative(repoRoot, file)} ── */\n${text}`;
            }),
          )
        ).join("\n");
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
          `  stylesheet: ${sheets.map((file) => relative(repoRoot, file)).join(", ")}\n`,
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
