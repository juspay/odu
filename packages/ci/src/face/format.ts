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

import type { LaneCell, StatusHue as FaceHue } from "@odu/face/ui";
import type { StatusHue as WireHue } from "@odu/run-client/surface";
import {
  BOARD_STATE,
  duration,
  OUTCOME,
  scopeLabel,
  type StatusHue,
} from "@odu/service-client/board";
import { STATUS_META } from "@odu/service-client/surface";
import { bytes } from "@odu/cordis/format";
import type {
  LogPage,
  LogStream,
  LogTail,
  NodeStatus,
  RunNode,
} from "./types";

/** The five semantic hues, from the contract module rather than spelled again
 *  here — so the one place a hue is consumed is a place the compiler can check
 *  and a reader can look up. */
export type { StatusHue };

/**
 * THE HUE VOCABULARY, PINNED — and this module is the one place in the tree
 * that can see both spellings of it.
 *
 * `@odu/face` names no row (that is the whole point of the package), so the
 * design system's `StatusHue` cannot be imported from `@odu/run-client`, where
 * the canonical union lives beside `STATUS_META`. Two declarations of one
 * vocabulary is exactly the drift this repo refuses everywhere else — a sixth
 * hue added to the wire would leave the primitives silently unable to draw it,
 * and nothing would say so.
 *
 * So the equality is ASSERTED here, where both are in scope: `@odu/ci` depends
 * on the row's client and on the shared face, and no other package does. Two
 * checks and not one, because a single assignment proves only containment —
 * `"grey"` is assignable to the five, and a union that had lost a member would
 * still pass in that direction. The shell's own `format.ts` points at this
 * line; it is the reason it may use the face's spelling without a second table.
 *
 * Zero runtime: a constraint on a type parameter is checked and then erased.
 */
type Assignable<A extends B, B> = A;
export type StatusHuesAgree = [
  Assignable<FaceHue, WireHue>,
  Assignable<WireHue, FaceHue>,
];

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
 * WHAT A NODE'S STATE IS CALLED, for a reader.
 *
 * `STATUS_META` carries the glyph and the hue but no English: its `progress`
 * field is the `--progress json` wording, a machine's vocabulary with a `null`
 * for the two states that have no JSON event, and `ok` is a key rather than a
 * word anybody says. A board that labelled a cell "ok" or left it blank would
 * be a board whose legend it does not match.
 *
 * Total, so a new node state is a type error here rather than an unnamed cell.
 */
export const NODE_WORD: Record<NodeStatus, string> = {
  pending: "pending",
  running: "running",
  ok: "passed",
  failed: "failed",
  skipped: "skipped",
  errored: "errored",
  cancelled: "cancelled",
};

/** The connection indicator's words and the tab's icon used to live here. They
 *  are the SHELL's — every face is drawn under one wire indicator and one tab —
 *  so they moved to `@odu/web-ui`'s own `format.ts` with the chrome they belong
 *  to, and this module stayed what its header says it is. */
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

// ── what a LANE is, read off the node ids ───────────────────────────────────
//
// A run's nodes arrive as one flat list whose only clue about which machine a
// row belongs to is the `@platform` suffix at the end of an id that is already
// too long to scan. Two views group them: the board draws one strip per
// platform in its pipeline column, and the run view heads each platform's
// nodes with the machine they landed on. One reading, here, because two
// spellings of "which lane is this node in" is how a board and a run come to
// draw a different number of lanes for the same work.

/** The platform half of `<namepath>@<platform>`. Read from the id rather than
 *  carried beside it — the id is the address and every face in this tree
 *  already reads it that way.
 *
 *  NOT `@odu/run-client`'s `splitFanId`, deliberately: that one answers
 *  `"unknown"` for an id with no `@`, which is right for a caller that must
 *  name a platform and wrong for a view. An empty string is a lane a person
 *  can be TOLD has no platform, and it is also what stops the lane's cancel
 *  button being drawn — `run.cancel` addresses a lane BY platform, so a button
 *  there would name nothing. */
export function platformOf(nodeId: string): string {
  const at = nodeId.lastIndexOf("@");
  return at < 0 ? "" : nodeId.slice(at + 1);
}

/** A platform triple at the width a board row has for it — `x86_64-linux`
 *  becomes `linux`, `aarch64-darwin` becomes `darwin`. The WHOLE triple rides
 *  the strip's cells as their accessible names, so nothing is lost: this is
 *  the label in front of eleven pixels, where four characters of architecture
 *  would crowd out the thing being labelled. */
export function platformShort(platform: string): string {
  if (platform === "") return "lane";
  const dash = platform.lastIndexOf("-");
  return dash < 0 ? platform : platform.slice(dash + 1);
}

/** One platform's nodes, in the order the frame first mentions each platform —
 *  the coordinator's own order, which is stable between ticks, unlike a sort
 *  that would re-order the lanes as nodes appear under them. */
export interface Lane {
  readonly platform: string;
  readonly nodes: RunNode[];
}

export function lanesOf(nodes: readonly RunNode[]): Lane[] {
  const byPlatform = new Map<string, RunNode[]>();
  for (const node of nodes) {
    const platform = platformOf(node.id);
    const lane = byPlatform.get(platform);
    if (lane === undefined) byPlatform.set(platform, [node]);
    else lane.push(node);
  }
  return [...byPlatform].map(([platform, lane]) => ({ platform, nodes: lane }));
}

/**
 * A LANE'S NODES AS CELLS — the signature element's content.
 *
 * One cell per node, in the pipeline's own order, each named in words because
 * eleven pixels cannot say `e2e-web@x86_64-linux, failed`. The three
 * distinctions the drawing makes are made here:
 *
 *   - a PENDING node has no hue at all — nothing has happened to it, and grey
 *     with an edge would be a verdict about work that has not run;
 *   - a SKIPPED one is an absence with an edge rather than a colour: a skip is
 *     not a verdict about the work, it is the work not happening;
 *   - everything else takes `STATUS_META`'s hue, so a cell and the glyph on
 *     the node row under it cannot disagree.
 */
export function laneCells(nodes: readonly RunNode[]): LaneCell[] {
  return nodes.map((node) => ({
    label: `${node.id}, ${NODE_WORD[node.status]}`,
    hue: node.status === "pending" ? null : NODE_STATUS[node.status].hue,
    ...(node.status === "skipped" ? { skipped: true } : {}),
  }));
}

/** A duration, at the precision a person reads it — `@odu/service-client/board`
 *  owns it, beside the elapsed rule that produces the numbers it renders, so
 *  this app and the CLI print one spelling. Re-exported so a view still reads
 *  its vocabulary from here. */
export { duration };

/**
 * NOT EVERYTHING FROM `board` COMES THROUGH HERE, and the line is what this
 * module is for.
 *
 * This file is the view's VOCABULARY — what a thing is called, what colour it
 * carries, how a number is spelled. `laneSpan` and `timelineTicks` are
 * GEOMETRY: fractions of a track, positions to place a box at. `detail.tsx`
 * imports those straight from `@odu/service-client/board`, as `board.tsx`
 * already imports `runStatus` and `isActive`, because routing coordinates
 * through a module about wording would make this file the place two unrelated
 * questions are asked — and the next reader would look here for the layout.
 *
 * What a timeline SAYS does come through here: its axis is spelled with
 * {@link duration} above, which is the whole reason that re-export exists.
 */

/** What a green here actually covers — the whole reason a scope rides the row.
 *  odu's own reading, because what a run COVERED is a fact about the run and not
 *  one face's idea of it (`@odu/service-client/board` owns it, beside the other
 *  board readings). Re-exported so a view still reads its vocabulary from here,
 *  and so a link that hands somebody else's board a qualifier spells the scope
 *  the same way this one does. */
export { scopeLabel };

/** A request id a repeat of this page's own click cannot duplicate. The service
 *  makes a request id mandatory precisely so a lost reply is reconcilable, and
 *  a browser that reused one would replay its previous answer rather than doing
 *  what the person just asked for. One mint for every control in this face. */
export function requestId(what: string): string {
  return `web-${what}-${crypto.randomUUID()}`;
}

// ── what a push put on a bucket, and what a log pane says about itself ──────

/**
 * WHAT A PUSH PUT ON THE BUCKET, in one phrase — `3 pushed · 66 present ·
 * 3.1 KiB`.
 *
 * TWO NUMBERS, because a push answers two questions and one number answered
 * neither. `69 paths` was the SERVED total — what the bucket holds because of
 * this node — and it read as "this run uploaded sixty-nine paths", which on a
 * warm cache is almost never what happened. `stored` is what actually went up
 * now; `present` is what was already there. The bytes are the stored ones, so
 * the size and the first count are about the same event.
 *
 * NO `present` CLAUSE WHEN IT IS ZERO. A push that found nothing already on
 * the bucket has nothing to say about it, and `· 0 present` on the common
 * case is a word a reader has to read and discard. Runs recorded before the
 * split fold to `present: 0` in the journal, so they keep reading exactly as
 * they did.
 *
 * ONE PHRASE, TWO PLACES — the run header's total and the node's push step.
 * The step wraps it in its own state word, so it reads `pushed → <bucket> ·
 * 3 pushed · 66 present · 3.1 KiB · 87ms`, and the repetition is deliberate:
 * the first `pushed` is the STEP's verdict and the second is a COUNT of
 * paths, both of them srid's own vocabulary. A header and a step that spelled
 * the same counts two ways would drift the first time one of them changed,
 * and drift between two numbers on one page costs more than a repeated word.
 */
export function pushCounts(counts: {
  stored: number;
  present: number;
  bytes: number;
}): string {
  const present = counts.present === 0 ? "" : ` · ${counts.present} present`;
  return `${counts.stored} pushed${present} · ${bytes(counts.bytes)}`;
}

/** WHAT THE FOLLOW LEARNED BESIDES THE TEXT. A page carries facts about the
 *  whole FILE — how big it is, and whether its producer said its last word —
 *  and the follow used to throw both away on every page and keep the bytes.
 *  That left the push stream, whose only reader is the follow, with no size
 *  to show until somebody pressed a paging button. Kept as the two facts the
 *  pane renders rather than the whole page, so nothing downstream is tempted
 *  to draw a window's text from a value that is only ever the latest one. */
export type FollowedPage = Pick<LogPage, "size" | "complete">;

/** The one spelling of a truncated log, shared by both streams: a log that
 *  has been read to its end but never got its producer's last word is not a
 *  quiet recipe, it is missing evidence, and saying so is the difference. */
const INCOMPLETE = " · incomplete — the producer never closed this log";

/**
 * WHAT THE LOG PANE SAYS ABOUT THE FILE IT IS SHOWING — the size, and whether
 * it is whole.
 *
 * EACH STREAM FROM ITS OWN SOURCE, which is the whole reason this is a
 * function rather than an expression in the pane. `collections.logTails` is
 * keyed by the log key alone and carries the RECIPE's file; the push stream's
 * facts come from the follow's last page, because the follow is the only
 * thing that reads that file. A push pane that fell back to the tail would
 * print the recipe's byte count under a heading that says Push — a wrong
 * answer that looks exactly like a right one, which is the failure mode this
 * pane has already had once.
 *
 * The push stream NAMES ITSELF (`push log`) and the recipe does not: the
 * recipe is what a log pane is about by default, and the tabs above already
 * say which one is selected. A push log that has not delivered a page yet is
 * the bare label — the honest "nothing read yet", with the pane's own
 * `Reading…` beneath it.
 */
export function logMetaText(view: {
  stream: LogStream;
  tail: LogTail | undefined;
  followedPage: FollowedPage | null;
}): string {
  if (view.stream === "push") {
    const page = view.followedPage;
    return page === null
      ? "push log"
      : `push log · ${bytes(page.size)}${page.complete ? "" : INCOMPLETE}`;
  }
  const tail = view.tail;
  return tail === undefined
    ? ""
    : `${bytes(tail.totalBytes)}${tail.complete ? "" : INCOMPLETE}`;
}
