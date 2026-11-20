/**
 * `@odu/run-client/nodeId` — what a node on the fan-in surface is CALLED.
 *
 * A fan-in node id is `<namepath>@<platform>`; the `@` separator is wire
 * format. It travels in `PipelineState.order`, keys `PipelineState.nodes`, and
 * is the input of `nodeLog` / `node.rerun` / `node.cancel`.
 *
 * A run's durable per-node log is `.ci/<sha7>/<platform>/<namepath>.log`, and
 * {@link logPathFor} is the ONE spelling of it.
 *
 * Invariant: the namepath never leads with `@`, so `lastIndexOf("@")` with an
 * `at > 0` guard splits unambiguously. A lane-local id (no `@`) defaults
 * platform to "unknown".
 */

import { Schema } from "effect";

/** The node-id contract, shared by every member that names a node. A non-empty
 *  string: the fan-in's `<namepath>@<platform>` and the lane's bare namepath
 *  are both ids, and the surface does not encode which it is holding — a
 *  reader that needs the split calls {@link splitFanId}. */
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
 *  trusting a stored copy. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The node id → durable log path fold: `ci::e2e@x86_64-linux` of run
 *  `338eb01` → `.ci/338eb01/x86_64-linux/ci::e2e.log`, and with
 *  `stream: "push"` the push half beside it, `ci::e2e.push.log`. RELATIVE to
 *  the checkout root; whether the file exists is a question for the
 *  filesystem. */
export function logPathFor(
  sha7: string,
  nodeId: string,
  stream: LogStream = "recipe",
): string {
  const { namepath, platform } = splitFanId(nodeId);
  const suffix = stream === "push" ? "push.log" : "log";
  return `.ci/${sha7}/${platform}/${namepath}.${suffix}`;
}

/**
 * WHICH OF A NODE'S TWO LOGS. `"recipe"` is the default everywhere a stream is
 * not named.
 */
export const LOG_STREAMS = ["recipe", "push"] as const;
export const LogStreamSchema = Schema.Literals(LOG_STREAMS);
export type LogStream = (typeof LOG_STREAMS)[number];

/**
 * The key one node's one stream is pumped under. The suffix is one no node id
 * can collide with, so a reader splitting ids cannot grow a phantom node.
 *
 * Internal to the pump and its two ends: the WIRE names the stream in its own
 * field (`nodeLog.get({ id, stream })`), so this spelling never crosses it.
 */
export function logStreamKey(nodeId: string, stream: LogStream = "recipe"): string {
  return stream === "push" ? `${nodeId}\u0000push` : nodeId;
}

export function onPlatform(id: string, platform: string): boolean {
  return splitFanId(id).platform === platform;
}

/** Coordinator / lane bookkeeping namepath fanned as `_ci-setup@<platform>`. */
export const SETUP_NAMEPATH = "_ci-setup";

/** Is this fan-in id the coordinator's own bookkeeping node for a lane?
 *  Splits the id rather than matching a prefix, so a recipe merely NAMED like
 *  the sentinel cannot pass. */
export function isSetupNode(id: string): boolean {
  return splitFanId(id).namepath === SETUP_NAMEPATH;
}
