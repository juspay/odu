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
/** The five semantic hues, from the package that OWNS the vocabulary.
 *
 *  `@odu/face` names no row, so the shell may import the union from there
 *  where it may not import `@odu/run-client`'s canonical one — and the two
 *  are held equal by a type-level assertion in `@odu/ci/face`'s `format`,
 *  which is a file that can see both. */
import type { StatusHue } from "@odu/face/ui";

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
  const dot = hue === "red" ? "#ff6b5e" : "#f2c14e";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="#0a0d0c"/>` +
    `<text x="6" y="23" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" ` +
    `font-size="18" font-weight="700" fill="#7a8982">$</text>` +
    `<circle cx="24" cy="24" r="6" fill="${dot}"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** A byte count, at the precision a log page needs. */
