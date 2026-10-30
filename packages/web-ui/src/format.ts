/**
 * THE SHELL'S OWN READINGS — the connection indicator's words, and the favicon.
 *
 * These two are the page's CHROME rather than a row's view: every face is drawn
 * under the same wire indicator, and the tab's icon answers "is anything
 * broken" for the whole document. Everything a RUN is painted from lives in
 * `@odu/ci/face`, with the run views — so this module names no row, and the
 * shell can be read without one.
 */

import type { SurfaceReadout, SurfaceReadoutStatus } from "@kolu/surface/solid";
/** The five semantic hues, spelled here rather than imported.
 *
 *  The canonical union is `@odu/run-client/surface`'s (re-exported by the ci
 *  row's `board` module), and this is a no-row package: a file that is not a
 *  root may not import a row, which the fence checks. What keeps the two
 *  spellings equal is the STYLESHEET — every hue here is a `hue-*` class in
 *  `styles.css`, and `./palette.test.ts` reads that file — so a renamed hue is
 *  one failing suite away from being noticed rather than silently colourless. */
type StatusHue = "grey" | "amber" | "green" | "red" | "violet";

export const CONNECTION: Record<
  SurfaceReadoutStatus,
  { label: string; hue: StatusHue }
> = {
  connecting: { label: "connecting", hue: "grey" },
  live: { label: "live", hue: "green" },
  degraded: { label: "partly live", hue: "amber" },
  reconnecting: {
    label: "reconnecting — showing the last thing the service said",
    hue: "amber",
  },
  retired: {
    label: "this page is bound to a service that has been replaced — reload",
    hue: "red",
  },
};

/** What the connection indicator SAYS, and in which hue. `degraded` is the one
 *  that names what stopped, so the sentence can never come out with a hole in
 *  it. It lives here rather than in the shell because it is a word: it reads
 *  `CONNECTION`, the table this module already owns, and the shell has eight
 *  other concerns. */
export function wireText(readout: SurfaceReadout): {
  text: string;
  hue: StatusHue;
} {
  const said = CONNECTION[readout.status];
  return {
    text:
      readout.status === "degraded"
        ? `${said.label} — nothing is arriving on ${readout.stopped.join(", ")}`
        : said.label,
    hue: said.hue,
  };
}

export function faviconSvg(hue: "red" | "amber"): string {
  const dot = hue === "red" ? "#ff7d74" : "#f5c451";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="#080b0a"/>` +
    `<text x="6" y="23" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" ` +
    `font-size="18" font-weight="700" fill="#7d8e87">$</text>` +
    `<circle cx="24" cy="24" r="6" fill="${dot}"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** A byte count, at the precision a log page needs. */
