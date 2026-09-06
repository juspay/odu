/**
 * `@odu/run-client/nodeId` — what a node on the fan-in surface is CALLED.
 *
 * A fan-in node id is `<namepath>@<platform>` — the one primitive that joins
 * lane-local state, fan-in state, GitHub contexts, log paths and CLI selectors,
 * so the `@` separator is wire format and lives here rather than being
 * re-derived at every consumer. It travels in `PipelineState.order`, keys
 * `PipelineState.nodes`, and is the input of `nodeLog` / `node.rerun` /
 * `node.cancel`.
 *
 * The on-disk log path is part of that same naming contract: a run's durable
 * per-node log is `.ci/<sha7>/<platform>/<namepath>.log`, and {@link logPathFor}
 * is the ONE spelling of it. odu's coordinator WRITES through it, and a
 * consumer pointing at a run's logs on disk derives the path through it — the
 * alternative is every client re-splicing the id by hand and quietly drifting
 * the day the layout moves.
 *
 * Invariant: the namepath never leads with `@`, so `lastIndexOf("@")` with an
 * `at > 0` guard splits unambiguously. A lane-local id (no `@`) is the
 * asymmetric edge case — it defaults platform to "unknown".
 *
 * Every fold here is one a READER performs: a face that paints the run as a
 * (recipe × platform) matrix splits every id it is handed, and a face that
 * shows lanes has to know which row is the coordinator's own bookkeeping. They
 * ship with the feed so a consumer reads it rather than reinventing the
 * reading. What is NOT here is the argv grammar a CLI parses ids WITH
 * (`@platform` sugar) and the DAG walk a rerunner does over them — see the
 * README's "What stayed in odu".
 */

import { Schema } from "effect";

/** The node-id contract, shared by every member that names a node. A non-empty
 *  string: the fan-in's `<namepath>@<platform>` and the lane's bare namepath
 *  are both ids, and the surface deliberately does not encode which it is
 *  holding — the SERVER decides that, and a reader that needs the split calls
 *  {@link splitFanId}. */
export const NodeIdSchema = Schema.String.check(Schema.isMinLength(1));

export function fanId(namepath: string, platform: string): string {
  return `${namepath}@${platform}`;
}

export function splitFanId(id: string): { namepath: string; platform: string } {
  const at = id.lastIndexOf("@");
  if (at > 0) {
    return { namepath: id.slice(0, at), platform: id.slice(at + 1) };
  }
  return { namepath: id, platform: "unknown" };
}

/** The 7-char short form of a commit sha — the ONE place the prefix rule
 *  lives, so every reader derives the short sha mechanically rather than
 *  trusting a stored copy.
 *
 *  Here, beside {@link logPathFor}, because `sha7` is already this module's
 *  vocabulary: the durable log path is `.ci/<sha7>/…`, and `<sha7>#<seq>` is
 *  the ref every face prints. It briefly lived in the run-catalog package,
 *  which made a caller wanting seven characters of a commit depend on the
 *  whole durable history to get them. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The node id → durable log path fold: `ci::e2e@x86_64-linux` of run
 *  `338eb01` → `.ci/338eb01/x86_64-linux/ci::e2e.log`. RELATIVE to the
 *  checkout root, exactly as odu lays it on disk (justci's layout) — the
 *  caller joins it to the checkout it is talking about. Pure path algebra
 *  over the id split, like {@link runSocketPath} is over the checkout root;
 *  whether the file exists is a question for the filesystem. */
export function logPathFor(sha7: string, nodeId: string): string {
  const { namepath, platform } = splitFanId(nodeId);
  return `.ci/${sha7}/${platform}/${namepath}.log`;
}

export function onPlatform(id: string, platform: string): boolean {
  // Platform is the field after the last `@` (see splitFanId), not a free
  // suffix of the whole id — so a namepath that itself contains `@` cannot
  // make an unrelated platform string match.
  return splitFanId(id).platform === platform;
}

/** Coordinator / lane bookkeeping namepath fanned as `_ci-setup@<platform>`.
 *  One spelling for the coordinator, the lane runner, and every face that has
 *  to tell the run's own scaffolding apart from a recipe the operator wrote. */
export const SETUP_NAMEPATH = "_ci-setup";

/** Is this fan-in id the coordinator's own bookkeeping node for a lane?
 *
 *  Beside {@link SETUP_NAMEPATH} because several unrelated policies turn on it
 *  and each was re-deriving the split: `@platform` rerun expansion excludes it
 *  (every task `needs` it, so including it would collapse a multi-rerun into
 *  "re-provision the lane"), `odu status`'s provisioning clock reads its
 *  `startedAt`, and a `node.cancel` on it with no live lane routes to a lane
 *  drop. Splits the id rather than matching a prefix, so a recipe merely NAMED
 *  like the sentinel cannot pass. */
export function isSetupNode(id: string): boolean {
  return splitFanId(id).namepath === SETUP_NAMEPATH;
}
