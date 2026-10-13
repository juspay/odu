/**
 * The words and the shapes — everything a view renders that is not itself a
 * value on the wire.
 *
 * Kept apart from the views for the reason the framework keeps its readout
 * states apart from their labels: the framework decides WHICH state is true and
 * the app decides what it is CALLED, and a table is the only spelling of that
 * which a compiler can check. Every mapping below is a total `Record`, so a new
 * state on the wire is a type error here rather than a blank cell in a browser.
 */

import type { SurfaceReadout, SurfaceReadoutStatus } from "@kolu/surface/solid";
import {
  BOARD_STATE,
  OUTCOME,
  scopeLabel,
  type StatusHue,
} from "@odu/service-client/board";
import { STATUS_META } from "@odu/service-client/surface";

/** The five semantic hues, from the contract module rather than spelled again
 *  here — so the one place a hue is consumed is a place the compiler can check
 *  and a reader can look up. */
export type { StatusHue };

/** What a run is called, and what colour it carries. Not this app's assignment:
 *  `@odu/service-client/board` owns it, because a board is not one face's idea
 *  and a second copy of "what is this run called" is how two faces come to
 *  disagree. Re-exported so a view still reads its vocabulary from here. */
export { BOARD_STATE, OUTCOME };

/** The node glyphs and hues are not this app's to assign: `STATUS_META` is the
 *  wire's own table, and its doc says no face keeps a second one. Re-exported
 *  under this module's name so a view still reads its vocabulary from here, and
 *  so a glyph changed for the TUI changes here in the same edit. */
export const NODE_STATUS = STATUS_META;

/**
 * What the connection indicator says.
 *
 * `degraded` is the one the transport cannot see — a live socket over a
 * subscription that has stopped — and it NAMES what stopped, so the sentence
 * can never come out with a hole in it. The framework decides which state is
 * true; these are odu's words for them.
 *
 * The HUE rides the table beside the words, for the reason every other mapping
 * here does: which colour "reconnecting" carries is an assignment of meaning,
 * and a total `Record` is the only spelling of it a compiler can check. It used
 * to be a list of `.wire-*` selectors in the stylesheet, where a sixth readout
 * state would have been a colourless sentence rather than a type error.
 */
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

/** `<sha7>#<seq>`, the ref every odu face already prints, or the sha7 alone for
 *  a run that reserved no ordinal. */
export function runRef(sha: string, seq: number | null): string {
  const sha7 = sha.slice(0, 7);
  return seq === null ? sha7 : `${sha7}#${seq}`;
}

/** The last path segment of a checkout — what a person calls the project. The
 *  whole path stays on the row as a title, because two worktrees of one repo
 *  have the same last segment and the difference matters. */
export function projectOf(repoRoot: string): string {
  const parts = repoRoot.split("/").filter((p) => p !== "");
  return parts[parts.length - 1] ?? repoRoot;
}

/** A duration, at the precision a person reads it. */
export function duration(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds - minutes * 60)).padStart(2, "0")}s`;
}

/** How long ago, coarsely. Coarse on purpose: a board is scanned rather than
 *  read, and "3m ago" is what a scanner needs from a timestamp. */
export function ago(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** What a green here actually covers — the whole reason a scope rides the row.
 *  odu's own reading, because what a run COVERED is a fact about the run and not
 *  one face's idea of it (`@odu/service-client/board` owns it, beside the other
 *  board readings). Re-exported so a view still reads its vocabulary from here,
 *  and so a link that hands somebody else's board a qualifier spells the scope
 *  the same way this one does. */
export { scopeLabel };

/**
 * THE TAB'S OWN ICON, drawn — the one place this app draws a picture.
 *
 * Everywhere else a status is words and a shape, because that is the only
 * spelling a colour-blind reader, a screen reader and a test can all read. A
 * browser tab is the one surface with room for none of those: it is sixteen
 * pixels of icon and a title that is usually clipped, and it is also where a
 * person looks when this page is NOT the page they are on. So the tab is the
 * ambient monitor — a dot on the mark, said again in words in `document.title`
 * beside it, which is what keeps the rule above intact.
 *
 * The mark is `logo.svg`'s own idea rather than a second drawing of it: a slate
 * `$` on a dark rounded square, because odu is a shell prompt you attach to. It
 * is built here rather than shipped as two more assets because the hue is a
 * function of live state, and a build cannot know which of them is true.
 *
 * Returns the whole `data:` URI, ready to assign to a `<link rel="icon">`, so
 * the encoding lives in one place — `#` in an unencoded SVG would truncate the
 * URI at the first colour.
 */
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
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
