/**
 * `@odu/run-client/nodeId` — what a node on the fan-in surface is CALLED.
 *
 * A fan-in node id is `<namepath>@<platform>`; a run's durable per-node log is
 * `.ci/<sha7>/<platform>/<namepath>.log`. A lane-local id (no `@`) defaults
 * platform to "unknown".
 */

import { Schema } from "effect";

/** The node-id contract, shared by every member that names a node: a non-empty
 *  string, either `<namepath>@<platform>` or a bare namepath. */
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

/** The 7-char short form of a commit sha. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The node id → durable log path fold: `ci::e2e@x86_64-linux` of run
 *  `338eb01` → `.ci/338eb01/x86_64-linux/ci::e2e.log`, and with
 *  `stream: "push"`, `ci::e2e.push.log`. Relative to the checkout root. */
export function logPathFor(
  sha7: string,
  nodeId: string,
  stream: LogStream = "recipe",
): string {
  const { namepath, platform } = splitFanId(nodeId);
  const suffix = stream === "push" ? "push.log" : "log";
  return `.ci/${sha7}/${platform}/${namepath}.${suffix}`;
}

/** Which of a node's two logs; `"recipe"` is the default. */
export const LOG_STREAMS = ["recipe", "push"] as const;
export const LogStreamSchema = Schema.Literals(LOG_STREAMS);
export type LogStream = (typeof LOG_STREAMS)[number];

/** The key one node's one stream is pumped under. */
export function logStreamKey(nodeId: string, stream: LogStream = "recipe"): string {
  return stream === "push" ? `${nodeId}\u0000push` : nodeId;
}

export function onPlatform(id: string, platform: string): boolean {
  return splitFanId(id).platform === platform;
}

/** Coordinator / lane bookkeeping namepath fanned as `_ci-setup@<platform>`. */
export const SETUP_NAMEPATH = "_ci-setup";

/** Is this fan-in id the coordinator's own bookkeeping node for a lane? */
export function isSetupNode(id: string): boolean {
  return splitFanId(id).namepath === SETUP_NAMEPATH;
}
