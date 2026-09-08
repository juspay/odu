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

import type { SurfaceReadoutStatus } from "@kolu/surface/solid";
import type {
  NodeStatus,
  RunBoardState,
  RunOutcome,
} from "./types";

/** What each board state is called, and what colour it carries. The hue names
 *  are the same five `@odu/run-client`'s `STATUS_META` uses — one assignment of
 *  meaning to colour across the terminal dashboard and the browser. */
export const BOARD_STATE: Record<
  RunBoardState,
  { label: string; hue: "grey" | "amber" | "green" | "red" | "violet" }
> = {
  provisioning: { label: "provisioning", hue: "amber" },
  running: { label: "running", hue: "amber" },
  settled: { label: "settled", hue: "grey" },
  owner_lost: { label: "owner lost", hue: "violet" },
  expired: { label: "expired", hue: "grey" },
};

/** A run's terminal word. `null` — no outcome yet — is deliberately absent from
 *  this table: a run that has not finished has nothing to say here, and a
 *  fallback label would be a verdict about a run that has not reached one. */
export const OUTCOME: Record<
  RunOutcome,
  { label: string; hue: "green" | "red" | "amber" }
> = {
  passed: { label: "passed", hue: "green" },
  failed: { label: "failed", hue: "red" },
  incomplete: { label: "incomplete", hue: "amber" },
};

/** The node glyphs and hues — the same assignment the TUI makes, so a person
 *  reading both is reading one vocabulary. */
export const NODE_STATUS: Record<
  NodeStatus,
  { glyph: string; hue: "grey" | "amber" | "green" | "red" | "violet" }
> = {
  pending: { glyph: "◦", hue: "grey" },
  running: { glyph: "▶", hue: "amber" },
  ok: { glyph: "✔", hue: "green" },
  failed: { glyph: "✗", hue: "red" },
  skipped: { glyph: "⊘", hue: "grey" },
  errored: { glyph: "⚠", hue: "violet" },
  cancelled: { glyph: "◼", hue: "grey" },
};

/**
 * What the connection indicator says.
 *
 * `degraded` is the one the transport cannot see — a live socket over a
 * subscription that has stopped — and it NAMES what stopped, so the sentence
 * can never come out with a hole in it. The framework decides which state is
 * true; these are odu's words for them.
 */
export const CONNECTION: Record<SurfaceReadoutStatus, string> = {
  connecting: "connecting",
  live: "live",
  degraded: "partly live",
  reconnecting: "reconnecting — showing the last thing the service said",
  retired: "this page is bound to a service that has been replaced — reload",
};

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
 *  An empty selection is the WHOLE pipeline and says so, because "" would read
 *  as a run that tested nothing. */
export function scopeLabel(scope: {
  selectors: readonly string[];
  platforms: readonly string[];
  noDeps: boolean;
}): string {
  const what =
    scope.selectors.length === 0 ? "whole pipeline" : scope.selectors.join(" ");
  const where =
    scope.platforms.length === 0 ? "" : ` · ${scope.platforms.join(" ")}`;
  return `${what}${where}${scope.noDeps ? " · no deps" : ""}`;
}

/** A byte count, at the precision a log page needs. */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
